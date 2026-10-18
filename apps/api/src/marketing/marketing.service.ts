import { BadRequestException, ConflictException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service.js';
import { ConversationsService } from '../conversations/conversations.service.js';
import { WhatsAppPermanentError, WhatsAppSenderService } from '../whatsapp/whatsapp-sender.service.js';
import { ApprovalsService, payloadHash } from '../governance/approvals.service.js';
import { can } from '../governance/permissions.js';
import { SettingsService } from '../settings/settings.service.js';
import { DEFAULT_SETTINGS } from '../settings/tenant-settings.js';
import { config } from '../common/config.js';
import { describeError } from '../common/errors.js';
import { log } from '../common/logger.js';
import { followUpConfig, liveGate } from '../restaurant/followup-config.js';
import { marketingQueue, type CampaignJobData } from '../queues/queues.js';
import { checkImport, slugTag } from './customer-import.js';
import { parseImportFile } from './import-file.js';
import { approvedTemplates } from './marketing-templates.js';
import { applyOptKeyword } from '../consent/opt-out.js';
import { adSpendStatus, metaPermissions } from './meta-permissions.js';
import { COPY_KINDS, COPY_LANGUAGES, generateCopy, type CopyGenerator, type CopyKind, type CopyLanguage, type CopyProduct } from './marketing-copy.js';

export const MARKETING_PERMISSIONS = {
  view: 'marketing.view',
  manage: 'marketing.manage',
  approveCampaign: 'marketing.approve_campaign',
  approveContent: 'marketing.approve_content',
} as const;

export type SegmentRules = { tags?: string[]; language?: string; leadStatuses?: string[]; leadSources?: string[]; activeWithinDays?: number };
export type CampaignInput = {
  name?: string;
  objective?: string | null;
  occasion?: string | null;
  segmentId?: string | null;
  brief?: Record<string, unknown> | null;
  templateName?: string | null;
  templateLanguage?: string | null;
  templateParams?: string[];
  headerImageUrl?: string | null;
  scheduledAt?: string | null;
};
export type ContentInput = { title?: string; channel?: string; format?: string; body?: string; mediaUrl?: string | null; productIds?: string[]; plannedFor?: string; campaignId?: string | null };
type User = { sub: string; role?: string };
type RevisionMeta = { source: 'ai' | 'template' | 'manual'; model?: string | null; language?: string; inputTokens?: number; outputTokens?: number; removed?: string[] };

export const OCCASIONS = ['diwali', 'pongal', 'wedding', 'new_arrivals', 'clearance', 'aadi_sale', 'other'] as const;
export const CONTENT_CHANNELS = ['whatsapp_status', 'instagram', 'facebook', 'whatsapp_broadcast'] as const;
export const CONTENT_FORMATS = ['post', 'story', 'reel_idea', 'broadcast'] as const;
const LANGUAGES = ['tamil', 'tanglish', 'english'];
/** Only these can be edited. A campaign waiting for approval must be withdrawn first (so the approved text is what is sent). */
const EDITABLE = ['draft', 'rejected'];
const LIVE_ORDER = ['confirmed', 'processing', 'ready_to_dispatch', 'dispatched', 'delivered'];
/** A reply this soon after a campaign message is credited to that campaign. */
export const ATTRIBUTION_DAYS = 7;

const tagsOf = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
const strList = (v: unknown, max: number, len = 40) =>
  (Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : []).map((x) => String(x).trim().slice(0, len)).filter(Boolean).slice(0, max);
const httpsOrNull = (v: unknown, what: string) => {
  const u = String(v ?? '').trim();
  if (u && !/^https:\/\/\S+$/i.test(u)) throw new BadRequestException(`${what} must be a public https:// link.`);
  return u || null;
};
const dec = (v: number | null) => (v === null ? null : new Prisma.Decimal(v.toFixed(2)));

/** "{{name}}" / "{{shop}}" in a variable, filled per customer. Nothing else is invented. */
export function fill(text: string, v: { name?: string | null; shop: string }): string {
  return text.replace(/\{\{\s*name\s*\}\}/gi, (v.name ?? '').trim().split(/\s+/)[0] || 'Customer').replace(/\{\{\s*shop\s*\}\}/gi, v.shop);
}

/** The template body with {{1}}, {{2}}... replaced by the variables: exactly what the customer reads. */
export function renderTemplate(body: string | null | undefined, params: string[]): string {
  if (!body) return params.length ? params.join('\n') : '';
  return body.replace(/\{\{(\d+)\}\}/g, (_, i) => params[Number(i) - 1] ?? `{{${i}}}`);
}

export function sanitizeRules(raw: unknown): SegmentRules {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const out: SegmentRules = {};
  const tags = strList(r.tags, 10).map(slugTag).filter(Boolean);
  if (tags.length) out.tags = tags;
  if (typeof r.language === 'string' && LANGUAGES.includes(r.language)) out.language = r.language;
  const st = strList(r.leadStatuses, 10);
  if (st.length) out.leadStatuses = st;
  const src = strList(r.leadSources, 10);
  if (src.length) out.leadSources = src;
  const days = Math.round(Number(r.activeWithinDays));
  if (Number.isFinite(days) && days > 0) out.activeWithinDays = Math.min(days, 730);
  return out;
}

/**
 * Marketing: customer lists (import with consent + suppression), segments, campaign drafts, approval-gated WhatsApp
 * template campaigns, delivery / reply tracking with attribution, and the content calendar.
 *
 * Safety: an audience is ALWAYS narrowed to customers with recorded marketing consent who have not opted out
 * (STOP / do-not-contact). A campaign is sent only after an approval of its exact content (hash). With DRY_RUN on,
 * or for a number that is not an approved test recipient, every message is recorded as SIMULATED - never as sent.
 */
@Injectable()
export class MarketingService {
  private queue: Pick<Queue<CampaignJobData>, 'addBulk'> | null = marketingQueue;

  constructor(
    private readonly prisma: PrismaService,
    private readonly conversations: ConversationsService,
    private readonly sender: WhatsAppSenderService,
    private readonly approvals: ApprovalsService,
    @Optional() private readonly settings?: SettingsService,
  ) {
    approvals.registerExecutor('marketing.campaign_send', async (a) => {
      const p = a.payload as { campaignId?: string; hash?: string };
      if (!p.campaignId || !p.hash) throw new Error('Approval has no campaign');
      return this.launch(a.organizationId, p.campaignId, { hash: p.hash, approvalId: a.id });
    });
    approvals.registerExecutor('marketing.content_approve', async (a) => {
      const p = a.payload as { contentId?: string; hash?: string };
      if (!p.contentId || !p.hash) throw new Error('Approval has no content item');
      return this.applyContentApproval(a.organizationId, p.contentId, p.hash, a.id);
    });
  }

  /** undefined = the configured model when OPENAI_API_KEY / OPENAI_BASE_URL is set; null = template only; tests inject a fake. */
  copyGenerator: CopyGenerator | null | undefined = undefined;

  /** Tests: null = no queue (recipients are processed by calling processRecipient). */
  useQueue(q: Pick<Queue<CampaignJobData>, 'addBulk'> | null) {
    this.queue = q;
  }

  private async shopName(organizationId: string) {
    return (await this.prisma.organization.findUnique({ where: { id: organizationId }, select: { name: true } }))?.name || 'our shop';
  }

  private async whatsappRate(organizationId: string): Promise<number | null> {
    const s = this.settings ? await this.settings.get(organizationId) : DEFAULT_SETTINGS;
    const r = Number(s.roi?.whatsappCostPerMessageInr ?? 0);
    return r > 0 ? r : null; // 0 = not set: no invented estimate
  }

  // ================================================================== customers, import, suppression

  async customers(organizationId: string, q: { q?: string; tag?: string; consent?: string; take?: number } = {}) {
    const where: Prisma.CustomerWhereInput = { organizationId };
    const and: Prisma.CustomerWhereInput[] = [];
    if (q.q?.trim()) and.push({ OR: [{ name: { contains: q.q.trim() } }, { phone: { contains: q.q.trim() } }] });
    if (q.tag) and.push({ tags: { array_contains: [slugTag(q.tag)] } });
    if (q.consent === 'yes') and.push({ messagingConsent: true, optedOutAt: null, doNotContact: false });
    if (q.consent === 'no') and.push({ messagingConsent: false });
    if (q.consent === 'suppressed') and.push({ OR: [{ optedOutAt: { not: null } }, { doNotContact: true }] });
    if (and.length) where.AND = and;
    const [rows, total, consented, suppressed] = await Promise.all([
      this.prisma.customer.findMany({ where, orderBy: { updatedAt: 'desc' }, take: Math.min(q.take ?? 200, 500), select: { id: true, name: true, phone: true, language: true, tags: true, messagingConsent: true, optedOutAt: true, doNotContact: true, isDemo: true, source: true, lastInboundAt: true } }),
      this.prisma.customer.count({ where: { organizationId } }),
      this.prisma.customer.count({ where: { organizationId, messagingConsent: true, optedOutAt: null, doNotContact: false } }),
      this.prisma.customer.count({ where: { organizationId, OR: [{ optedOutAt: { not: null } }, { doNotContact: true }] } }),
    ]);
    const tagRows = await this.prisma.customer.findMany({ where: { organizationId, tags: { not: Prisma.DbNull } }, select: { tags: true }, take: 5000 });
    const tagCounts = new Map<string, number>();
    for (const r of tagRows) for (const t of tagsOf(r.tags)) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
    return {
      totals: { customers: total, marketingConsent: consented, suppressed },
      tags: [...tagCounts.entries()].sort((a, b) => b[1] - a[1]).map(([tag, count]) => ({ tag, count })),
      items: rows.map((r) => ({
        id: r.id, name: r.name, phone: r.phone, language: r.language, tags: tagsOf(r.tags), source: r.source, isDemo: r.isDemo,
        marketingConsent: r.messagingConsent, suppressed: Boolean(r.optedOutAt || r.doNotContact), lastInboundAt: r.lastInboundAt?.toISOString() ?? null,
      })),
    };
  }

  /** Manual edit of one customer's tags / marketing consent. Consent can never be set on an opted-out customer here. */
  async updateCustomer(organizationId: string, id: string, body: { tags?: string[]; marketingConsent?: boolean }) {
    const c = await this.prisma.customer.findFirst({ where: { id, organizationId } });
    if (!c) throw new NotFoundException('Customer not found');
    const data: Prisma.CustomerUpdateInput = {};
    if (body.tags !== undefined) data.tags = [...new Set(strList(body.tags, 12).map(slugTag).filter(Boolean))];
    if (typeof body.marketingConsent === 'boolean') {
      if (body.marketingConsent && (c.optedOutAt || c.doNotContact)) throw new BadRequestException('This customer opted out (STOP / do not contact). Only the customer can opt in again by messaging START.');
      data.messagingConsent = body.marketingConsent;
    }
    await this.prisma.customer.update({ where: { id }, data });
    return { ok: true };
  }

  /**
   * Customer list import (CSV / XLSX). `commit: false` only validates and returns the preview. On commit, valid rows
   * are created or merged by phone (tags added, name / language filled if empty). Marketing consent is recorded ONLY
   * from an explicit yes/no column AND when the importer confirms the consent was collected (`consentConfirmed`);
   * otherwise imported customers have no consent and are excluded from every campaign. A "no" always clears consent.
   * An opted-out customer is never re-consented by an import.
   */
  async importCustomers(organizationId: string, file: { originalname?: string; buffer?: Buffer } | undefined, body: { tags?: string; commit?: string | boolean; consentConfirmed?: string | boolean }) {
    if (!file?.buffer?.length) throw new BadRequestException('Choose a CSV or Excel (.xlsx) file.');
    if (file.buffer.length > 5 * 1024 * 1024) throw new BadRequestException('Files must be 5 MB or smaller.');
    let table;
    try {
      table = parseImportFile(file.originalname ?? 'upload.csv', file.buffer);
    } catch (e) {
      throw new BadRequestException(`Could not read the file: ${describeError(e).slice(0, 160)}`);
    }
    const check = checkImport(table, strList(body.tags, 5));
    const commit = body.commit === true || body.commit === 'true';
    const consentConfirmed = body.consentConfirmed === true || body.consentConfirmed === 'true';
    const preview = {
      total: check.total, valid: check.valid.length, invalid: check.invalid.length, duplicatesInFile: check.duplicatesInFile, columns: check.columns,
      consentColumn: check.consentColumn,
      consentNote: !check.consentColumn
        ? 'No consent column: customers are imported WITHOUT marketing consent and cannot be messaged until consent is recorded.'
        : consentConfirmed ? 'Consent will be recorded from the consent column (you confirmed it was collected).' : 'Tick "consent was collected" to record the consent column; otherwise customers are imported without consent.',
      invalidRows: check.invalid.slice(0, 50).map((r) => ({ row: r.row, errors: r.errors })),
      sample: check.valid.slice(0, 5).map((r) => ({ row: r.row, name: r.name, phone: r.phone, tags: r.tags, marketingConsent: r.marketingConsent })),
    };
    if (!commit) return { committed: false, ...preview };
    let created = 0, updated = 0, consentRecorded = 0, suppressedKept = 0;
    for (const r of check.valid) {
      const existing = await this.prisma.customer.findFirst({ where: { organizationId, phone: r.phone! } });
      const suppressed = Boolean(existing?.optedOutAt || existing?.doNotContact);
      const consent = r.marketingConsent === false ? false : r.marketingConsent === true && consentConfirmed && !suppressed ? true : undefined;
      if (r.marketingConsent === true && suppressed) suppressedKept++;
      if (consent === true) consentRecorded++;
      if (existing) {
        await this.prisma.customer.update({
          where: { id: existing.id },
          data: {
            tags: [...new Set([...tagsOf(existing.tags), ...r.tags])].slice(0, 20),
            ...(existing.name ? {} : { name: r.name }),
            ...(existing.language ? {} : { language: r.language }),
            ...(existing.email ? {} : { email: r.email }),
            ...(consent === undefined ? {} : { messagingConsent: consent }),
          },
        });
        updated++;
      } else {
        await this.prisma.customer.create({ data: { organizationId, phone: r.phone!, name: r.name, email: r.email, language: r.language, tags: r.tags, source: 'import', messagingConsent: consent === true } });
        created++;
      }
    }
    log.info('marketing.customers_imported', { organizationId, created, updated, consentRecorded, invalid: check.invalid.length });
    return { committed: true, ...preview, created, updated, consentRecorded, suppressedKept };
  }

  /** Suppression list (CSV / XLSX with a phone column): these numbers are opted out of all marketing, now and later. */
  async importSuppression(organizationId: string, file: { originalname?: string; buffer?: Buffer } | undefined) {
    if (!file?.buffer?.length) throw new BadRequestException('Choose a CSV or Excel (.xlsx) file.');
    const check = checkImport(parseImportFile(file.originalname ?? 'upload.csv', file.buffer));
    const now = new Date();
    let suppressed = 0;
    for (const r of check.valid) {
      await this.prisma.customer.upsert({
        where: { organizationId_phone: { organizationId, phone: r.phone! } },
        create: { organizationId, phone: r.phone!, name: r.name, source: 'suppression_list', optedOutAt: now, messagingConsent: false },
        update: { optedOutAt: now, messagingConsent: false },
      });
      suppressed++;
    }
    // Anyone still queued in a running campaign is skipped at send time (the worker re-checks).
    return { suppressed, invalid: check.invalid.length };
  }

  // ================================================================== segments

  private ruleWhere(organizationId: string, rules: SegmentRules): Prisma.CustomerWhereInput {
    const and: Prisma.CustomerWhereInput[] = [{ organizationId }];
    if (rules.tags?.length) and.push({ OR: rules.tags.map((t) => ({ tags: { array_contains: [t] } })) });
    if (rules.language) and.push({ language: rules.language });
    if (rules.leadStatuses?.length || rules.leadSources?.length)
      and.push({ leads: { some: { ...(rules.leadStatuses?.length ? { status: { in: rules.leadStatuses } } : {}), ...(rules.leadSources?.length ? { source: { in: rules.leadSources } } : {}) } } });
    if (rules.activeWithinDays) and.push({ lastInboundAt: { gte: new Date(Date.now() - rules.activeWithinDays * 86_400_000) } });
    return { AND: and };
  }

  /** The rules AND marketing consent AND not opted out AND a phone number. Used for every count and every send. */
  eligibleWhere(organizationId: string, rules: SegmentRules): Prisma.CustomerWhereInput {
    return { AND: [this.ruleWhere(organizationId, rules), { messagingConsent: true, optedOutAt: null, doNotContact: false, phone: { not: null } }] };
  }

  async previewAudience(organizationId: string, rawRules: unknown) {
    const rules = sanitizeRules(rawRules);
    const base = this.ruleWhere(organizationId, rules);
    const [inSegment, eligible, optedOut, noConsent, sample] = await Promise.all([
      this.prisma.customer.count({ where: base }),
      this.prisma.customer.count({ where: this.eligibleWhere(organizationId, rules) }),
      this.prisma.customer.count({ where: { AND: [base, { OR: [{ optedOutAt: { not: null } }, { doNotContact: true }] }] } }),
      this.prisma.customer.count({ where: { AND: [base, { optedOutAt: null, doNotContact: false, messagingConsent: false }] } }),
      this.prisma.customer.findMany({ where: this.eligibleWhere(organizationId, rules), select: { name: true, isDemo: true }, take: 5, orderBy: { updatedAt: 'desc' } }),
    ]);
    return { rules, inSegment, eligible, excluded: { optedOut, noConsent }, sample: sample.map((s) => ({ name: s.name ?? 'Customer', isDemo: s.isDemo })) };
  }

  async segments(organizationId: string) {
    const rows = await this.prisma.marketingSegment.findMany({ where: { organizationId }, orderBy: { name: 'asc' } });
    return Promise.all(rows.map(async (s) => ({ id: s.id, name: s.name, description: s.description, ...(await this.previewAudience(organizationId, s.rules)), updatedAt: s.updatedAt.toISOString() })));
  }

  async saveSegment(organizationId: string, body: { id?: string; name?: string; description?: string; rules?: unknown }, by: string) {
    const name = String(body.name ?? '').trim().slice(0, 120);
    if (!name) throw new BadRequestException('Segment name is required.');
    const data = { name, description: String(body.description ?? '').trim().slice(0, 500) || null, rules: sanitizeRules(body.rules) as never };
    try {
      if (body.id) {
        const r = await this.prisma.marketingSegment.updateMany({ where: { id: body.id, organizationId }, data });
        if (!r.count) throw new NotFoundException('Segment not found');
        return { id: body.id };
      }
      const s = await this.prisma.marketingSegment.create({ data: { ...data, organizationId, createdBy: by } });
      return { id: s.id };
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new BadRequestException('A segment with this name already exists.');
      throw e;
    }
  }

  async deleteSegment(organizationId: string, id: string) {
    const used = await this.prisma.marketingCampaign.count({ where: { organizationId, segmentId: id, status: { in: ['pending_approval', 'approved', 'scheduled', 'sending', 'paused'] } } });
    if (used) throw new BadRequestException('A campaign that is waiting or sending uses this segment.');
    const r = await this.prisma.marketingSegment.deleteMany({ where: { id, organizationId } });
    if (!r.count) throw new NotFoundException('Segment not found');
    return { ok: true };
  }

  // ================================================================== campaigns: drafts

  async templates() {
    return approvedTemplates();
  }

  private validate(input: CampaignInput, partial: boolean): Prisma.MarketingCampaignUncheckedUpdateInput {
    const d: Prisma.MarketingCampaignUncheckedUpdateInput = {};
    if (input.name !== undefined || !partial) {
      const name = String(input.name ?? '').trim().slice(0, 120);
      if (!name) throw new BadRequestException('Campaign name is required.');
      d.name = name;
    }
    if (input.objective !== undefined) d.objective = String(input.objective ?? '').trim().slice(0, 500) || null;
    if (input.occasion !== undefined) d.occasion = (OCCASIONS as readonly string[]).includes(String(input.occasion)) ? String(input.occasion) : null;
    if (input.segmentId !== undefined) d.segmentId = input.segmentId || null;
    if (input.brief !== undefined) d.brief = input.brief && typeof input.brief === 'object' ? (input.brief as never) : Prisma.DbNull;
    if (input.templateName !== undefined) d.templateName = String(input.templateName ?? '').trim().slice(0, 512) || null;
    if (input.templateLanguage !== undefined) d.templateLanguage = String(input.templateLanguage ?? '').trim().slice(0, 20) || null;
    if (input.templateParams !== undefined) d.templateParams = (Array.isArray(input.templateParams) ? input.templateParams : []).map((x) => String(x).slice(0, 500)).slice(0, 10);
    if (input.headerImageUrl !== undefined) d.headerImageUrl = httpsOrNull(input.headerImageUrl, 'Header image');
    if (input.scheduledAt !== undefined) {
      if (input.scheduledAt) {
        const at = new Date(input.scheduledAt);
        if (Number.isNaN(at.getTime())) throw new BadRequestException('Invalid schedule time.');
        d.scheduledAt = at;
      } else d.scheduledAt = null;
    }
    return d;
  }

  async createCampaign(organizationId: string, input: CampaignInput, by: string, extra: { taskId?: string } = {}) {
    const d = this.validate(input, false);
    if (d.segmentId) await this.findSegment(organizationId, String(d.segmentId));
    const c = await this.prisma.marketingCampaign.create({ data: { ...(d as Prisma.MarketingCampaignUncheckedCreateInput), organizationId, createdBy: by, status: 'draft', taskId: extra.taskId ?? null } });
    return this.detail(organizationId, c.id);
  }

  async updateCampaign(organizationId: string, id: string, input: CampaignInput) {
    const c = await this.find(organizationId, id);
    if (!EDITABLE.includes(c.status)) throw new BadRequestException(c.status === 'pending_approval' ? 'Withdraw the approval request before editing.' : `A ${c.status} campaign cannot be edited.`);
    const d = this.validate(input, true);
    if (d.segmentId) await this.findSegment(organizationId, String(d.segmentId));
    await this.prisma.marketingCampaign.update({ where: { id }, data: { ...d, status: 'draft', approvedHash: null, approvalId: null } });
    return this.detail(organizationId, id);
  }

  private async findSegment(organizationId: string, id: string) {
    const s = await this.prisma.marketingSegment.findFirst({ where: { id, organizationId } });
    if (!s) throw new BadRequestException('Segment not found');
    return s;
  }

  private async find(organizationId: string, id: string) {
    const c = await this.prisma.marketingCampaign.findFirst({ where: { id, organizationId } });
    if (!c) throw new NotFoundException('Campaign not found');
    return c;
  }

  private async rulesOf(c: { organizationId: string; segmentId: string | null }): Promise<SegmentRules | null> {
    if (!c.segmentId) return null;
    const s = await this.prisma.marketingSegment.findFirst({ where: { id: c.segmentId, organizationId: c.organizationId } });
    return s ? sanitizeRules(s.rules) : null;
  }

  /** Everything that decides what is sent and to whom. Approval authorises exactly this. */
  private async contentHash(c: Prisma.MarketingCampaignGetPayload<object>) {
    return payloadHash({
      templateName: c.templateName, templateLanguage: c.templateLanguage, templateParams: c.templateParams ?? [], headerImageUrl: c.headerImageUrl,
      segmentId: c.segmentId, rules: await this.rulesOf(c), scheduledAt: c.scheduledAt?.toISOString() ?? null,
    });
  }

  /** The mobile preview: the approved template body with the variables filled for a sample customer. */
  async preview(organizationId: string, id: string) {
    const c = await this.find(organizationId, id);
    const shop = await this.shopName(organizationId);
    const rules = await this.rulesOf(c);
    const sample = rules ? await this.prisma.customer.findFirst({ where: this.eligibleWhere(organizationId, rules), select: { name: true } }) : null;
    const params = tagsOf(c.templateParams).map((p) => fill(p, { name: sample?.name ?? 'Priya', shop }));
    const t = c.templateName ? (await approvedTemplates()).templates.find((x) => x.name === c.templateName && (!c.templateLanguage || x.language === c.templateLanguage)) : undefined;
    return {
      templateFound: Boolean(t),
      templateNote: !c.templateName ? 'Choose an approved WhatsApp template.' : t ? null : 'Template body not loaded from Meta (not configured or not approved): the preview shows the variables only.',
      header: t?.header ?? (c.headerImageUrl ? 'IMAGE' : null),
      headerImageUrl: c.headerImageUrl,
      text: renderTemplate(t?.body, params),
      variablesExpected: t?.variables ?? null,
      variablesGiven: params.length,
      sampleCustomer: sample?.name ?? 'Priya (example)',
    };
  }

  /** Read-only: who would get it and what it might cost. Nothing is queued or sent. */
  async estimate(organizationId: string, id: string) {
    const c = await this.find(organizationId, id);
    const rules = await this.rulesOf(c);
    const audience = rules ? await this.previewAudience(organizationId, rules) : null;
    const eligible = audience?.eligible ?? 0;
    const rate = await this.whatsappRate(organizationId);
    const fu = followUpConfig();
    const problems: string[] = [];
    if (!c.segmentId) problems.push('Choose a segment.');
    else if (!rules) problems.push('The segment was deleted.');
    if (!c.templateName) problems.push('Choose an approved WhatsApp template (Meta only allows approved templates for marketing).');
    if (c.segmentId && rules && eligible === 0) problems.push('Nobody in this segment has marketing consent.');
    const warnings: string[] = [];
    if (!config.whatsapp.accessToken || !config.whatsapp.phoneNumberId) warnings.push('WhatsApp is not configured: sending is simulated only.');
    if (fu.dryRun) warnings.push('DRY_RUN is on: every message is recorded as simulated, nothing is sent.');
    else if (!fu.liveAllowAll) warnings.push(`Live test mode: only the ${fu.liveTestRecipients.length} approved test number(s) receive messages; everyone else is simulated.`);
    if (rate === null) warnings.push('Set "WhatsApp cost per message" in Settings → ROI to see a cost estimate.');
    return {
      campaignId: c.id,
      inSegment: audience?.inSegment ?? 0,
      eligible,
      excluded: audience?.excluded ?? { optedOut: 0, noConsent: 0 },
      mode: fu.dryRun ? 'simulation' : fu.liveAllowAll ? 'live' : 'live_test_numbers_only',
      rate,
      estimatedCost: rate === null ? null : Math.round(eligible * rate * 100) / 100,
      problems,
      warnings,
      ready: problems.length === 0,
    };
  }

  // ================================================================== campaigns: approval and sending

  /**
   * Ask for approval to send (the confirmation screen calls this). `expectedRecipients` must equal what the person
   * saw, so a stale screen cannot approve a different audience. A requester who holds marketing.approve_campaign
   * approves by confirming (recorded); anyone else creates a request in the approval queue.
   */
  async requestSend(organizationId: string, id: string, user: User, body: { confirm?: boolean; expectedRecipients?: number }) {
    if (body?.confirm !== true) throw new BadRequestException('Confirm the campaign first.');
    const c = await this.find(organizationId, id);
    if (!EDITABLE.includes(c.status)) throw new BadRequestException(`This campaign is ${c.status}.`);
    const est = await this.estimate(organizationId, id);
    if (!est.ready) throw new BadRequestException(est.problems.join(' '));
    if (Number(body.expectedRecipients) !== est.eligible) throw new ConflictException(`The audience changed (now ${est.eligible}). Review the confirmation again.`);
    const hash = await this.contentHash(c);
    const preview = await this.preview(organizationId, id);
    const claimed = await this.prisma.marketingCampaign.updateMany({
      where: { id, organizationId, status: { in: EDITABLE } },
      data: { status: 'pending_approval', approvedHash: hash, estimatedRecipients: est.eligible, estimatedCost: dec(est.estimatedCost), previewText: preview.text.slice(0, 4000) },
    });
    if (claimed.count !== 1) throw new ConflictException('This campaign changed meanwhile.');
    const r = await this.approvals.request(organizationId, {
      action: 'marketing.campaign_send', entityType: 'campaign', entityId: id,
      reason: `Send "${c.name}" to ${est.eligible} customer(s) with marketing consent (${est.mode}).`,
      payload: { campaignId: id, hash, expectedRecipients: est.eligible, estimatedCost: est.estimatedCost, template: c.templateName, preview: preview.text.slice(0, 1000) },
      requiredPermission: MARKETING_PERMISSIONS.approveCampaign, requestedBy: `user:${user.sub}`, requesterRole: user.role,
    });
    await this.prisma.marketingCampaign.update({ where: { id }, data: { approvalId: r.approval.id } });
    if (r.approved) {
      const result = await this.launch(organizationId, id, { hash, approvalId: r.approval.id });
      await this.approvals.markExecuted(organizationId, r.approval.id, result);
    }
    return this.detail(organizationId, id);
  }

  /** Agent path: put the campaign in the approval state (the orchestrator files the approval request). */
  async prepareAgentSend(organizationId: string, id: string, taskId: string) {
    const c = await this.find(organizationId, id);
    if (!EDITABLE.includes(c.status)) throw new BadRequestException(`This campaign is ${c.status}.`);
    const est = await this.estimate(organizationId, id);
    if (!est.ready) throw new BadRequestException(est.problems.join(' '));
    const hash = await this.contentHash(c);
    const preview = await this.preview(organizationId, id);
    await this.prisma.marketingCampaign.update({ where: { id }, data: { status: 'pending_approval', approvedHash: hash, taskId, estimatedRecipients: est.eligible, estimatedCost: dec(est.estimatedCost), previewText: preview.text.slice(0, 4000) } });
    return { name: c.name, hash, estimate: est, preview: preview.text.slice(0, 1000) };
  }

  /** Withdraw a pending request: the campaign goes back to draft and the request is cancelled. */
  async withdraw(organizationId: string, id: string, by: string) {
    const c = await this.find(organizationId, id);
    if (c.status !== 'pending_approval') throw new BadRequestException('Only a campaign waiting for approval can be withdrawn.');
    if (c.approvalId) await this.approvals.cancel(organizationId, c.approvalId, by).catch(() => undefined);
    await this.prisma.marketingCampaign.updateMany({ where: { id, organizationId, status: 'pending_approval' }, data: { status: 'draft', approvedHash: null, approvalId: null } });
    return this.detail(organizationId, id);
  }

  /**
   * Start an approved campaign. Refused when anything that is sent changed since the approval (hash), or the audience
   * grew beyond what was approved. Claimed with compare-and-set: it can only start once. Recipients get one job each.
   */
  async launch(organizationId: string, id: string, a: { hash: string; approvalId?: string | null }) {
    const c = await this.find(organizationId, id);
    if (c.status !== 'pending_approval') throw new ConflictException(`This campaign is ${c.status}; it was not started.`);
    const now = await this.contentHash(c);
    if (now !== a.hash || c.approvedHash !== a.hash) throw new ConflictException('The campaign changed after it was approved. Request approval again.');
    const rules = await this.rulesOf(c);
    if (!rules) throw new ConflictException('The segment was deleted.');
    const customers = await this.prisma.customer.findMany({ where: this.eligibleWhere(organizationId, rules), select: { id: true } });
    if (c.estimatedRecipients !== null && customers.length > c.estimatedRecipients)
      throw new ConflictException(`The audience grew from ${c.estimatedRecipients} to ${customers.length} since approval. Request approval again.`);
    const scheduled = c.scheduledAt && c.scheduledAt.getTime() > Date.now();
    const claimed = await this.prisma.marketingCampaign.updateMany({
      where: { id, organizationId, status: 'pending_approval', approvedHash: a.hash },
      data: { status: scheduled ? 'scheduled' : 'sending', startedAt: new Date(), simulated: followUpConfig().dryRun, ...(a.approvalId ? { approvalId: a.approvalId } : {}) },
    });
    if (claimed.count !== 1) throw new ConflictException('This campaign was already started.');
    await this.prisma.campaignRecipient.createMany({ data: customers.map((cu) => ({ organizationId, campaignId: id, customerId: cu.id, status: 'queued' })), skipDuplicates: true });
    await this.enqueue(organizationId, id, scheduled ? c.scheduledAt : null, '');
    if (!customers.length) await this.finishIfDone(organizationId, id);
    log.info('marketing.campaign_started', { organizationId, campaignId: id, recipients: customers.length, simulated: followUpConfig().dryRun, scheduled: Boolean(scheduled) });
    return { campaignId: id, recipients: customers.length, status: scheduled ? 'scheduled' : 'sending', simulated: followUpConfig().dryRun };
  }

  private async enqueue(organizationId: string, id: string, at: Date | null, suffix: string) {
    if (!this.queue) return;
    const recipients = await this.prisma.campaignRecipient.findMany({ where: { organizationId, campaignId: id, status: 'queued' }, select: { id: true } });
    const delay = at ? Math.max(0, at.getTime() - Date.now()) : 0;
    for (let i = 0; i < recipients.length; i += 500) {
      await this.queue.addBulk(recipients.slice(i, i + 500).map((r) => ({ name: 'campaign-recipient', data: { campaignId: id, recipientId: r.id }, opts: { jobId: `${id}-${r.id}${suffix}`, delay } })));
    }
  }

  async pause(organizationId: string, id: string) {
    const r = await this.prisma.marketingCampaign.updateMany({ where: { id, organizationId, status: { in: ['sending', 'scheduled'] } }, data: { status: 'paused' } });
    if (r.count !== 1) throw new BadRequestException('Only a scheduled or sending campaign can be paused.');
    return this.detail(organizationId, id);
  }

  async resume(organizationId: string, id: string) {
    const r = await this.prisma.marketingCampaign.updateMany({ where: { id, organizationId, status: 'paused' }, data: { status: 'sending' } });
    if (r.count !== 1) throw new BadRequestException('Only a paused campaign can be resumed.');
    await this.enqueue(organizationId, id, null, `-r${Date.now()}`); // paused jobs ended without sending
    return this.detail(organizationId, id);
  }

  async cancel(organizationId: string, id: string, by: string) {
    const c = await this.find(organizationId, id);
    if (c.status === 'pending_approval' && c.approvalId) await this.approvals.cancel(organizationId, c.approvalId, by).catch(() => undefined);
    const r = await this.prisma.marketingCampaign.updateMany({ where: { id, organizationId, status: { in: ['draft', 'rejected', 'pending_approval', 'scheduled', 'sending', 'paused'] } }, data: { status: 'cancelled', completedAt: new Date() } });
    if (r.count !== 1) throw new BadRequestException('This campaign can no longer be cancelled.');
    await this.prisma.campaignRecipient.updateMany({ where: { organizationId, campaignId: id, status: 'queued' }, data: { status: 'cancelled', reason: 'campaign cancelled' } });
    return this.detail(organizationId, id);
  }

  /** A rejected / cancelled / expired approval returns its campaign to an editable state with the decision visible. */
  private async settleApprovals(organizationId: string) {
    const waiting = await this.prisma.marketingCampaign.findMany({ where: { organizationId, status: 'pending_approval' }, select: { id: true, approvalId: true, taskId: true } });
    for (const w of waiting) {
      let approvalId = w.approvalId;
      if (!approvalId && w.taskId) approvalId = (await this.prisma.agentTask.findFirst({ where: { id: w.taskId, organizationId }, select: { approvalId: true } }))?.approvalId ?? null;
      if (!approvalId) continue;
      const a = await this.prisma.approval.findFirst({ where: { id: approvalId, organizationId }, select: { status: true } });
      if (a && ['rejected', 'cancelled', 'expired', 'failed'].includes(a.status))
        await this.prisma.marketingCampaign.updateMany({ where: { id: w.id, status: 'pending_approval' }, data: { status: 'rejected', approvalId, approvedHash: null } });
      else if (a && !w.approvalId) await this.prisma.marketingCampaign.update({ where: { id: w.id }, data: { approvalId } });
    }
  }

  // ================================================================== worker

  /**
   * One recipient (the worker calls this). Everything is re-checked at send time: campaign still running, customer
   * still consenting and not opted out. DRY_RUN / not-approved numbers are recorded as SIMULATED with the reason.
   */
  async processRecipient(job: CampaignJobData): Promise<string> {
    const r = await this.prisma.campaignRecipient.findUnique({ where: { id: job.recipientId }, include: { customer: true, campaign: true } });
    if (!r || r.campaignId !== job.campaignId) return 'missing';
    const c = r.campaign;
    if (r.status !== 'queued') return `already_${r.status}`;
    if (c.status === 'paused') return 'paused';
    if (c.status === 'cancelled') {
      await this.prisma.campaignRecipient.update({ where: { id: r.id }, data: { status: 'cancelled', reason: 'campaign cancelled' } });
      return 'cancelled';
    }
    if (c.status === 'scheduled') await this.prisma.marketingCampaign.updateMany({ where: { id: c.id, status: 'scheduled' }, data: { status: 'sending' } });
    else if (c.status !== 'sending') return `campaign_${c.status}`;
    const cu = r.customer;
    const skip = async (reason: string) => {
      await this.prisma.campaignRecipient.updateMany({ where: { id: r.id, status: 'queued' }, data: { status: 'skipped', reason } });
      await this.finishIfDone(c.organizationId, c.id);
      return 'skipped';
    };
    if (!cu.phone) return skip('no phone number');
    if (cu.optedOutAt || cu.doNotContact) return skip('customer opted out');
    if (!cu.messagingConsent) return skip('no marketing consent');
    // Claim the row first: a duplicate job (or a second worker) can never send the same recipient twice.
    const claim = await this.prisma.campaignRecipient.updateMany({ where: { id: r.id, status: 'queued' }, data: { status: 'sending', attempts: { increment: 1 } } });
    if (claim.count !== 1) return 'already_claimed';
    const shop = await this.shopName(c.organizationId);
    const params = tagsOf(c.templateParams).map((p) => fill(p, { name: cu.name, shop }));
    const shown = `📣 ${c.name}: ${params.join(' | ') || c.templateName}`.slice(0, 900);
    const gate = liveGate(followUpConfig(), { phone: cu.phone, isDemo: cu.isDemo });
    const conv = await this.conversations.getOrCreateConversation({ organizationId: c.organizationId, channel: 'whatsapp', externalId: cu.phone, customerId: cu.id });
    let result: string;
    if (!gate.live) {
      await this.prisma.campaignRecipient.update({ where: { id: r.id }, data: { status: 'simulated', reason: gate.reason ?? 'not live' } });
      await this.conversations.addMessage({ organizationId: c.organizationId, conversationId: conv.id, role: 'assistant', content: `${shown} (simulated: ${gate.reason})`, metadata: { campaignId: c.id, simulated: true } as never });
      result = 'simulated';
    } else {
      try {
        const id = await this.sender.sendCampaignTemplate(cu.phone, { name: c.templateName!, language: c.templateLanguage || config.whatsapp.templateLanguage, bodyParams: params, headerImageUrl: c.headerImageUrl ?? undefined });
        if (!id) throw new WhatsAppPermanentError('WhatsApp accepted the request but returned no message id', 0);
        await this.prisma.campaignRecipient.update({ where: { id: r.id }, data: { status: 'sent', providerMessageId: id, sentAt: new Date(), reason: null } });
        await this.conversations.addMessage({ organizationId: c.organizationId, conversationId: conv.id, role: 'assistant', content: shown, externalId: id, metadata: { campaignId: c.id } as never });
        result = 'sent';
      } catch (error) {
        const message = describeError(error).slice(0, 480);
        if (error instanceof WhatsAppPermanentError) {
          await this.prisma.campaignRecipient.update({ where: { id: r.id }, data: { status: 'failed', reason: message } });
          result = 'failed';
        } else {
          // Temporary: back to queued so the BullMQ retry can claim it again.
          await this.prisma.campaignRecipient.update({ where: { id: r.id }, data: { status: 'queued', reason: message } });
          throw error;
        }
      }
    }
    await this.finishIfDone(c.organizationId, c.id);
    return result;
  }

  private async finishIfDone(organizationId: string, campaignId: string) {
    const left = await this.prisma.campaignRecipient.count({ where: { organizationId, campaignId, status: { in: ['queued', 'sending'] } } });
    if (!left) await this.prisma.marketingCampaign.updateMany({ where: { id: campaignId, organizationId, status: { in: ['sending', 'scheduled'] } }, data: { status: 'completed', completedAt: new Date() } });
  }

  // ================================================================== webhook: receipts, replies, attribution

  /** Meta delivery receipts for campaign messages. Statuses only move forward. */
  async applyDeliveryStatus(organizationId: string, providerMessageId: string, status: string, error?: string) {
    const now = new Date();
    if (status === 'delivered') await this.prisma.campaignRecipient.updateMany({ where: { organizationId, providerMessageId, status: 'sent' }, data: { status: 'delivered', deliveredAt: now } });
    else if (status === 'read') await this.prisma.campaignRecipient.updateMany({ where: { organizationId, providerMessageId, status: { in: ['sent', 'delivered'] } }, data: { status: 'read', readAt: now, deliveredAt: now } });
    else if (status === 'failed') await this.prisma.campaignRecipient.updateMany({ where: { organizationId, providerMessageId, status: { in: ['sent', 'delivered'] } }, data: { status: 'failed', reason: (error ?? 'delivery failed').slice(0, 480) } });
  }

  /**
   * STOP / START for businesses other than GR Chicken (whose ordering flow already handles them): STOP records the
   * opt-out (no marketing, no reminders, no updates) and skips the customer in any campaign still queued; START is the
   * customer's own explicit opt-in and lifts it. Returns what was applied.
   */
  async handleOptKeyword(organizationId: string, phone: string, text: string | undefined): Promise<'stop' | 'start' | null> {
    return applyOptKeyword(this.prisma, organizationId, phone, text); // one shared opt-out path (consent/opt-out.ts)
  }

  /**
   * The customer wrote to us: credit the most recent campaign message they actually received (sent, not simulated)
   * in the last ATTRIBUTION_DAYS, and tag their open lead with the campaign if it has none.
   */
  async recordReply(organizationId: string, phone: string) {
    const cu = await this.prisma.customer.findFirst({ where: { organizationId, phone }, select: { id: true } });
    if (!cu) return null;
    const since = new Date(Date.now() - ATTRIBUTION_DAYS * 86_400_000);
    const r = await this.prisma.campaignRecipient.findFirst({
      where: { organizationId, customerId: cu.id, sentAt: { gte: since }, status: { in: ['sent', 'delivered', 'read', 'replied'] } },
      orderBy: { sentAt: 'desc' },
      include: { campaign: { select: { name: true } } },
    });
    if (!r) return null;
    if (r.status !== 'replied') await this.prisma.campaignRecipient.update({ where: { id: r.id }, data: { status: 'replied', repliedAt: new Date() } });
    await this.attributeLead(organizationId, r.id, cu.id, r.sentAt!, r.campaign.name);
    return r.campaignId;
  }

  private async attributeLead(organizationId: string, recipientId: string, customerId: string, sentAt: Date, campaignName: string) {
    const lead = await this.prisma.lead.findFirst({
      where: { organizationId, customerId, OR: [{ createdAt: { gte: sentAt } }, { campaign: null }], status: { notIn: ['lost', 'closed', 'won'] } },
      orderBy: { createdAt: 'desc' },
    });
    if (!lead) return;
    if (!lead.campaign) await this.prisma.lead.update({ where: { id: lead.id }, data: { campaign: campaignName.slice(0, 191), source: lead.source ?? 'whatsapp_campaign' } });
    await this.prisma.campaignRecipient.updateMany({ where: { id: recipientId, leadId: null }, data: { leadId: lead.id } });
  }

  /** Leads created after the reply (the AI creates them in the worker) are linked when the report is read. */
  private async attributePending(organizationId: string, campaignId: string) {
    const rs = await this.prisma.campaignRecipient.findMany({ where: { organizationId, campaignId, status: 'replied', leadId: null, sentAt: { not: null } }, include: { campaign: { select: { name: true } } }, take: 500 });
    for (const r of rs) await this.attributeLead(organizationId, r.id, r.customerId, r.sentAt!, r.campaign.name);
  }

  // ================================================================== reports

  async report(organizationId: string, id: string) {
    const c = await this.find(organizationId, id);
    await this.attributePending(organizationId, id);
    const rs = await this.prisma.campaignRecipient.findMany({ where: { organizationId, campaignId: id }, select: { status: true, leadId: true, sentAt: true } });
    const counts: Record<string, number> = {};
    for (const r of rs) counts[r.status] = (counts[r.status] ?? 0) + 1;
    const sent = rs.filter((r) => r.sentAt).length;
    const delivered = (counts.delivered ?? 0) + (counts.read ?? 0) + rs.filter((r) => r.status === 'replied').length;
    const leadIds = [...new Set(rs.map((r) => r.leadId).filter((x): x is string => !!x))];
    const [quotations, orders] = await Promise.all([
      leadIds.length ? this.prisma.quotation.findMany({ where: { organizationId, leadId: { in: leadIds } }, select: { status: true } }) : [],
      leadIds.length ? this.prisma.salesOrder.findMany({ where: { organizationId, leadId: { in: leadIds }, status: { in: LIVE_ORDER } }, select: { id: true, total: true } }) : [],
    ]);
    const recordedOrderValue = Math.round(orders.reduce((a, o) => a + Number(o.total ?? 0), 0) * 100) / 100;
    // Money is counted only when Finance VERIFIED it (never a claim or an unverified UTR).
    const verified = orders.length ? await this.prisma.payment.aggregate({ where: { organizationId, orderId: { in: orders.map((o) => o.id) }, status: 'verified' }, _sum: { amount: true } }) : null;
    const verifiedCollections = Math.round(Number(verified?._sum.amount ?? 0) * 100) / 100;
    const rate = await this.whatsappRate(organizationId);
    return {
      campaignId: id, name: c.name, status: c.status, simulated: c.simulated,
      recipients: rs.length, counts, sent, delivered, read: (counts.read ?? 0), replied: counts.replied ?? 0,
      simulatedCount: counts.simulated ?? 0, skipped: counts.skipped ?? 0, failed: counts.failed ?? 0,
      leads: leadIds.length, quotations: quotations.length, orders: orders.length, recordedOrderValue, verifiedCollections,
      messagingCost: rate === null ? null : Math.round(sent * rate * 100) / 100,
      adSpend: null,
      notes: [
        c.simulated ? 'DRY_RUN was on: messages were simulated, so there are no deliveries or replies to report.' : null,
        `Replies within ${ATTRIBUTION_DAYS} days of a delivered campaign message are credited to the campaign; leads, quotations and orders follow from those replies.`,
        'Order value is what was recorded on orders. Verified collections are payments Finance verified on those orders.',
        'Meta ad spend is not available (ads_read permission not connected), so no ad ROI is computed.',
      ].filter(Boolean),
    };
  }

  async performance(organizationId: string, days = 90) {
    await this.settleApprovals(organizationId);
    const rows = await this.prisma.marketingCampaign.findMany({ where: { organizationId, createdAt: { gte: new Date(Date.now() - days * 86_400_000) }, status: { in: ['sending', 'completed', 'paused', 'scheduled', 'cancelled'] } }, orderBy: { createdAt: 'desc' }, take: 50, select: { id: true } });
    const reports = await Promise.all(rows.map((r) => this.report(organizationId, r.id)));
    const sum = (k: 'recipients' | 'sent' | 'delivered' | 'replied' | 'leads' | 'quotations' | 'orders' | 'recordedOrderValue' | 'verifiedCollections') => Math.round(reports.reduce((a, r) => a + r[k], 0) * 100) / 100;
    return {
      days,
      totals: { campaigns: reports.length, recipients: sum('recipients'), sent: sum('sent'), delivered: sum('delivered'), replied: sum('replied'), leads: sum('leads'), quotations: sum('quotations'), orders: sum('orders'), recordedOrderValue: sum('recordedOrderValue'), verifiedCollections: sum('verifiedCollections') },
      campaigns: reports,
      adSpend: { available: false, reason: adSpendStatus(await metaPermissions()).note },
    };
  }

  // ================================================================== list / detail

  async list(organizationId: string, status?: string) {
    await this.settleApprovals(organizationId);
    const rows = await this.prisma.marketingCampaign.findMany({ where: { organizationId, ...(status ? { status } : {}) }, orderBy: { createdAt: 'desc' }, take: 100, include: { segment: { select: { name: true } } } });
    const stats = rows.length ? await this.prisma.campaignRecipient.groupBy({ by: ['campaignId', 'status'], where: { organizationId, campaignId: { in: rows.map((r) => r.id) } }, _count: { _all: true } }) : [];
    return rows.map((r) => ({ ...this.summary(r), segmentName: r.segment?.name ?? null, counts: Object.fromEntries(stats.filter((s) => s.campaignId === r.id).map((s) => [s.status, s._count._all])) }));
  }

  private summary(r: Prisma.MarketingCampaignGetPayload<object>) {
    return {
      id: r.id, name: r.name, objective: r.objective, occasion: r.occasion, channel: r.channel, segmentId: r.segmentId, brief: r.brief,
      templateName: r.templateName, templateLanguage: r.templateLanguage, templateParams: tagsOf(r.templateParams), headerImageUrl: r.headerImageUrl,
      previewText: r.previewText, status: r.status, scheduledAt: r.scheduledAt?.toISOString() ?? null, approvalId: r.approvalId, taskId: r.taskId,
      estimatedRecipients: r.estimatedRecipients, estimatedCost: r.estimatedCost === null ? null : Number(r.estimatedCost), simulated: r.simulated,
      createdBy: r.createdBy, startedAt: r.startedAt?.toISOString() ?? null, completedAt: r.completedAt?.toISOString() ?? null, createdAt: r.createdAt.toISOString(),
    };
  }

  async detail(organizationId: string, id: string) {
    await this.settleApprovals(organizationId);
    const c = await this.prisma.marketingCampaign.findFirst({ where: { id, organizationId }, include: { segment: { select: { name: true } } } });
    if (!c) throw new NotFoundException('Campaign not found');
    const recipients = await this.prisma.campaignRecipient.findMany({ where: { organizationId, campaignId: id }, include: { customer: { select: { name: true, phone: true, isDemo: true } } }, orderBy: { createdAt: 'asc' }, take: 500 });
    const approval = c.approvalId ? await this.prisma.approval.findFirst({ where: { id: c.approvalId, organizationId }, select: { id: true, status: true, decidedBy: true, decidedAt: true, decisionNote: true, requestedBy: true } }) : null;
    const counts: Record<string, number> = {};
    for (const r of recipients) counts[r.status] = (counts[r.status] ?? 0) + 1;
    return {
      ...this.summary(c), segmentName: c.segment?.name ?? null, counts, approval,
      recipients: recipients.map((r) => ({
        id: r.id, customerId: r.customerId, name: r.customer.name, phone: r.customer.phone, isDemo: r.customer.isDemo, status: r.status, reason: r.reason, leadId: r.leadId,
        sentAt: r.sentAt?.toISOString() ?? null, deliveredAt: r.deliveredAt?.toISOString() ?? null, readAt: r.readAt?.toISOString() ?? null, repliedAt: r.repliedAt?.toISOString() ?? null,
      })),
    };
  }

  // ================================================================== content calendar

  async content(organizationId: string, q: { from?: string; to?: string } = {}) {
    const from = q.from ? new Date(q.from) : new Date(Date.now() - 7 * 86_400_000);
    const to = q.to ? new Date(q.to) : new Date(Date.now() + 35 * 86_400_000);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) throw new BadRequestException('Invalid date range');
    const rows = await this.prisma.contentItem.findMany({ where: { organizationId, plannedFor: { gte: from, lte: to } }, orderBy: { plannedFor: 'asc' }, take: 500 });
    return rows.map((r) => this.contentView(r));
  }

  private contentView(r: Prisma.ContentItemGetPayload<object>) {
    return {
      id: r.id, title: r.title, channel: r.channel, format: r.format, body: r.body, mediaUrl: r.mediaUrl, productIds: tagsOf(r.productIds),
      plannedFor: r.plannedFor.toISOString(), status: r.status, campaignId: r.campaignId, approvalId: r.approvalId,
      publishedAt: r.publishedAt?.toISOString() ?? null, publishedBy: r.publishedBy, publishedNote: r.publishedNote, createdBy: r.createdBy,
    };
  }

  private contentData(input: ContentInput, partial: boolean): Prisma.ContentItemUncheckedUpdateInput {
    const d: Prisma.ContentItemUncheckedUpdateInput = {};
    if (input.title !== undefined || !partial) {
      const t = String(input.title ?? '').trim().slice(0, 150);
      if (!t) throw new BadRequestException('Title is required.');
      d.title = t;
    }
    if (input.channel !== undefined || !partial) {
      if (!(CONTENT_CHANNELS as readonly string[]).includes(String(input.channel))) throw new BadRequestException(`Channel must be one of ${CONTENT_CHANNELS.join(', ')}.`);
      d.channel = input.channel;
    }
    if (input.format !== undefined) {
      if (!(CONTENT_FORMATS as readonly string[]).includes(String(input.format))) throw new BadRequestException(`Format must be one of ${CONTENT_FORMATS.join(', ')}.`);
      d.format = input.format;
    }
    if (input.body !== undefined || !partial) {
      const b = String(input.body ?? '').trim().slice(0, 4000);
      if (!b) throw new BadRequestException('Write the post text.');
      d.body = b;
    }
    if (input.mediaUrl !== undefined) d.mediaUrl = httpsOrNull(input.mediaUrl, 'Media link');
    if (input.productIds !== undefined) d.productIds = strList(input.productIds, 10, 64);
    if (input.plannedFor !== undefined || !partial) {
      const at = new Date(String(input.plannedFor ?? ''));
      if (Number.isNaN(at.getTime())) throw new BadRequestException('Choose the planned date.');
      d.plannedFor = at;
    }
    if (input.campaignId !== undefined) d.campaignId = input.campaignId || null;
    return d;
  }

  async createContent(organizationId: string, input: ContentInput, by: string, status: 'idea' | 'draft' = 'draft', revision: RevisionMeta = { source: 'manual' }) {
    const d = this.contentData(input, false);
    const r = await this.prisma.contentItem.create({ data: { ...(d as Prisma.ContentItemUncheckedCreateInput), organizationId, createdBy: by, status } });
    await this.addRevision(organizationId, r, by, revision);
    return this.contentView(r);
  }

  private addRevision(organizationId: string, r: { id: string; title: string; body: string }, by: string, m: RevisionMeta) {
    return this.prisma.contentRevision.create({
      data: { organizationId, contentItemId: r.id, title: r.title, body: r.body, source: m.source, model: m.model ?? null, language: m.language ?? null, inputTokens: m.inputTokens ?? null, outputTokens: m.outputTokens ?? null, removed: m.removed?.length ? (m.removed as never) : undefined, createdBy: by.slice(0, 191) },
    });
  }

  async revisions(organizationId: string, id: string) {
    const r = await this.prisma.contentItem.findFirst({ where: { id, organizationId }, select: { id: true } });
    if (!r) throw new NotFoundException('Content not found');
    return this.prisma.contentRevision.findMany({ where: { organizationId, contentItemId: id }, orderBy: { createdAt: 'desc' }, take: 50 });
  }

  async restoreRevision(organizationId: string, id: string, revisionId: string, by: string) {
    const rev = await this.prisma.contentRevision.findFirst({ where: { id: revisionId, organizationId, contentItemId: id } });
    if (!rev) throw new NotFoundException('Revision not found');
    return this.updateContent(organizationId, id, { title: rev.title, body: rev.body }, by, { source: 'manual', model: `restored ${rev.createdAt.toISOString().slice(0, 16)}` });
  }

  /**
   * AI draft (caption / promo / Reels script / broadcast) from APPROVED catalogue facts, in English, Tamil or Tanglish.
   * Unsupported prices, offers, stock or delivery claims are removed by the grounding check; without a model a template
   * draft is used. Saved as a draft revision (never approved or published by this).
   */
  async aiDraft(organizationId: string, input: { contentId?: string; kind?: string; language?: string; productIds?: string[]; offer?: string; occasion?: string; channel?: string; plannedFor?: string }, by: string) {
    const kind = (COPY_KINDS as readonly string[]).includes(String(input.kind)) ? (input.kind as CopyKind) : 'caption';
    const language = (COPY_LANGUAGES as readonly string[]).includes(String(input.language)) ? (input.language as CopyLanguage) : 'english';
    const ids = strList(input.productIds, 6, 64);
    const rows = await this.prisma.textileProduct.findMany({ where: { organizationId, active: true, ...(ids.length ? { id: { in: ids } } : {}) }, take: ids.length ? 6 : 3, orderBy: { updatedAt: 'desc' } });
    if (ids.length && rows.length !== ids.length) throw new BadRequestException('A chosen product was not found or is inactive');
    const products: CopyProduct[] = rows.map((p) => ({
      name: p.name, fabricCategory: p.fabricCategory, colour: p.colour, composition: p.composition, design: p.design, gsm: p.gsm, width: p.width,
      price: p.priceApproved && p.price !== null ? Number(p.price) : null, priceUnit: p.priceUnit, stockStatus: p.stockStatus,
    }));
    const offer = String(input.offer ?? '').trim().slice(0, 200) || null;
    const occasion = String(input.occasion ?? '').trim().slice(0, 60) || null;
    const result = await generateCopy({ kind, language, products, offer, occasion, shopName: await this.shopName(organizationId) }, this.copyGenerator === undefined ? undefined : this.copyGenerator);
    const meta: RevisionMeta = { source: result.source, model: result.model, language, inputTokens: result.inputTokens, outputTokens: result.outputTokens, removed: result.removed };
    const title = `${kind === 'reel_script' ? 'Reel' : kind === 'promo' ? 'Promo' : kind === 'broadcast' ? 'Broadcast' : 'Caption'}: ${rows[0]?.name ?? occasion ?? 'collection'}`.slice(0, 150);
    const item = input.contentId
      ? await this.updateContent(organizationId, input.contentId, { body: result.text }, by, meta)
      : await this.createContent(organizationId, {
          title, body: result.text, channel: (CONTENT_CHANNELS as readonly string[]).includes(String(input.channel)) ? input.channel : kind === 'broadcast' ? 'whatsapp_broadcast' : 'instagram',
          format: kind === 'reel_script' ? 'reel_idea' : kind === 'broadcast' ? 'broadcast' : 'post', productIds: rows.map((r) => r.id), plannedFor: input.plannedFor ?? new Date(Date.now() + 86_400_000).toISOString(),
        }, by, 'draft', meta);
    return { item, source: result.source, model: result.model, removed: result.removed, note: result.note ?? null };
  }

  /** Model usage that Tacksharp records (marketing drafts). Conversation-assistant usage is in the API logs only. */
  async aiUsage(organizationId: string, days = 30) {
    const since = new Date(Date.now() - days * 86_400_000);
    const agg = await this.prisma.contentRevision.aggregate({ where: { organizationId, source: 'ai', createdAt: { gte: since } }, _count: { _all: true }, _sum: { inputTokens: true, outputTokens: true } });
    return { days, marketingDrafts: agg._count._all, inputTokens: agg._sum.inputTokens ?? 0, outputTokens: agg._sum.outputTokens ?? 0, costInr: null, note: 'Token counts for marketing drafts only. Cost is not computed (no per-token rate is configured). Conversation-assistant usage is logged per turn, not stored.' };
  }

  async updateContent(organizationId: string, id: string, input: ContentInput, by = 'system', revision: RevisionMeta = { source: 'manual' }) {
    const r = await this.prisma.contentItem.findFirst({ where: { id, organizationId } });
    if (!r) throw new NotFoundException('Content not found');
    if (!['idea', 'draft', 'approved'].includes(r.status)) throw new BadRequestException(r.status === 'pending_approval' ? 'It is waiting for approval; it cannot be edited now.' : `A ${r.status} item cannot be edited.`);
    // Editing approved content needs a new approval.
    const u = await this.prisma.contentItem.update({ where: { id }, data: { ...this.contentData(input, true), status: r.status === 'approved' ? 'draft' : r.status, approvalId: r.status === 'approved' ? null : r.approvalId } });
    if (u.title !== r.title || u.body !== r.body) await this.addRevision(organizationId, u, by, revision);
    return this.contentView(u);
  }

  private itemHash(r: { title: string; body: string; channel: string; format: string; mediaUrl: string | null; plannedFor: Date }) {
    return payloadHash({ title: r.title, body: r.body, channel: r.channel, format: r.format, mediaUrl: r.mediaUrl, plannedFor: r.plannedFor.toISOString() });
  }

  async requestContentApproval(organizationId: string, id: string, user: User) {
    const r = await this.prisma.contentItem.findFirst({ where: { id, organizationId } });
    if (!r) throw new NotFoundException('Content not found');
    if (!['idea', 'draft'].includes(r.status)) throw new BadRequestException(`A ${r.status} item cannot be sent for approval.`);
    const hash = this.itemHash(r);
    await this.prisma.contentItem.update({ where: { id }, data: { status: 'pending_approval' } });
    const a = await this.approvals.request(organizationId, {
      action: 'marketing.content_approve', entityType: 'content', entityId: id, reason: `Approve ${r.channel.replace('_', ' ')} ${r.format} "${r.title}" for ${r.plannedFor.toISOString().slice(0, 10)}`,
      payload: { contentId: id, hash, title: r.title, body: r.body.slice(0, 1500), channel: r.channel }, requiredPermission: MARKETING_PERMISSIONS.approveContent,
      requestedBy: `user:${user.sub}`, requesterRole: user.role,
    });
    await this.prisma.contentItem.update({ where: { id }, data: { approvalId: a.approval.id } });
    if (a.approved) {
      const result = await this.applyContentApproval(organizationId, id, hash, a.approval.id);
      await this.approvals.markExecuted(organizationId, a.approval.id, result);
    }
    return this.contentView((await this.prisma.contentItem.findUnique({ where: { id } }))!);
  }

  private async applyContentApproval(organizationId: string, id: string, hash: string, approvalId: string) {
    const r = await this.prisma.contentItem.findFirst({ where: { id, organizationId } });
    if (!r || r.status !== 'pending_approval') throw new ConflictException('The content is no longer waiting for approval.');
    if (this.itemHash(r) !== hash) throw new ConflictException('The content changed after the request.');
    await this.prisma.contentItem.update({ where: { id }, data: { status: 'approved', approvalId } });
    return { contentId: id, status: 'approved' };
  }

  /** Back to draft when its approval was rejected / cancelled / expired (shown on the calendar). */
  async settleContentApprovals(organizationId: string) {
    const waiting = await this.prisma.contentItem.findMany({ where: { organizationId, status: 'pending_approval', approvalId: { not: null } }, select: { id: true, approvalId: true } });
    for (const w of waiting) {
      const a = await this.prisma.approval.findFirst({ where: { id: w.approvalId!, organizationId }, select: { status: true } });
      if (a && ['rejected', 'cancelled', 'expired', 'failed'].includes(a.status)) await this.prisma.contentItem.updateMany({ where: { id: w.id, status: 'pending_approval' }, data: { status: 'draft' } });
    }
  }

  /**
   * No social account is connected, so Tacksharp never posts. A person posts the approved content themselves and
   * records it here (who, when, optional link / note).
   */
  async markPublished(organizationId: string, id: string, by: string, note?: string) {
    const r = await this.prisma.contentItem.updateMany({ where: { id, organizationId, status: 'approved' }, data: { status: 'published', publishedAt: new Date(), publishedBy: by, publishedNote: String(note ?? '').trim().slice(0, 500) || null } });
    if (!r.count) throw new BadRequestException('Only approved content can be marked as published.');
    return this.contentView((await this.prisma.contentItem.findUnique({ where: { id } }))!);
  }

  async cancelContent(organizationId: string, id: string, by: string) {
    const r = await this.prisma.contentItem.findFirst({ where: { id, organizationId } });
    if (!r) throw new NotFoundException('Content not found');
    if (r.status === 'published' || r.status === 'cancelled') throw new BadRequestException(`A ${r.status} item cannot be cancelled.`);
    if (r.status === 'pending_approval' && r.approvalId) await this.approvals.cancel(organizationId, r.approvalId, by).catch(() => undefined);
    await this.prisma.contentItem.update({ where: { id }, data: { status: 'cancelled' } });
    return { ok: true };
  }

  // ================================================================== overview

  async overview(organizationId: string, user?: User) {
    await Promise.all([this.settleApprovals(organizationId), this.settleContentApprovals(organizationId)]);
    const [customers, segments, drafts, pending, running, contentPending, contentUpcoming, tpl] = await Promise.all([
      this.prisma.customer.count({ where: { organizationId, messagingConsent: true, optedOutAt: null, doNotContact: false } }),
      this.prisma.marketingSegment.count({ where: { organizationId } }),
      this.prisma.marketingCampaign.count({ where: { organizationId, status: { in: ['draft', 'rejected'] } } }),
      this.prisma.marketingCampaign.count({ where: { organizationId, status: 'pending_approval' } }),
      this.prisma.marketingCampaign.count({ where: { organizationId, status: { in: ['scheduled', 'sending', 'paused'] } } }),
      this.prisma.contentItem.count({ where: { organizationId, status: 'pending_approval' } }),
      this.prisma.contentItem.count({ where: { organizationId, status: { in: ['draft', 'approved', 'idea'] }, plannedFor: { gte: new Date() } } }),
      approvedTemplates(),
    ]);
    const fu = followUpConfig();
    const ads = adSpendStatus(await metaPermissions());
    return {
      consentedCustomers: customers, segments, campaigns: { drafts, pendingApproval: pending, running }, content: { pendingApproval: contentPending, upcoming: contentUpcoming },
      mode: fu.dryRun ? 'simulation' : fu.liveAllowAll ? 'live' : 'live_test_numbers_only',
      templates: { configured: tpl.configured, count: tpl.templates.length, reason: tpl.reason ?? null },
      permissions: user ? { manage: can(user.role, MARKETING_PERMISSIONS.manage), approveCampaign: can(user.role, MARKETING_PERMISSIONS.approveCampaign), approveContent: can(user.role, MARKETING_PERMISSIONS.approveContent) } : null,
      occasions: OCCASIONS, contentChannels: CONTENT_CHANNELS, contentFormats: CONTENT_FORMATS,
      blocked: [{ feature: 'Meta ad spend / ad ROI', reason: ads.note }, { feature: 'Auto-posting to Instagram / Facebook', reason: 'No social account is connected; approved posts are published by a person and recorded.' }],
      ai: { configured: Boolean(process.env.OPENAI_API_KEY || process.env.OPENAI_BASE_URL), usage: await this.aiUsage(organizationId) },
    };
  }
}
