import { BadRequestException, Injectable } from '@nestjs/common';
import { Agent } from '@openai/agents';
import { PrismaService } from '../prisma/prisma.service.js';
import { CredentialsService } from '../integrations/credentials.service.js';
import { openaiRunner } from '../integrations/openai-runner.js';
import { configureClient, modelSettings } from 'ai/agents/real-estate-agent.js';
import { publishLive } from '../common/live-events.js';
import { errorMessage, log } from '../common/logger.js';
import { sharedCartStore, type CartStore } from '../telephony/sarvam-tools.service.js';
import { DEFAULT_JARVIS, MONITOR_INFO, istClock, sanitizeJarvis, type JarvisConfig } from './jarvis-config.js';
import { JarvisDataService } from './jarvis-data.service.js';
import { digestLines, evaluateMonitors, factSheet, type Alert } from './jarvis-logic.js';
import { checkInstagram, checkOfficeMail, type MailSummary } from './jarvis-checks.js';

export type DigestRecord = { at: string; date: string; headline: string; lines: string[]; source: 'scheduled' | 'manual' };

const ALERTS_KEY = (org: string) => `jarvis:alerts:${org}`;
const DIGESTS_KEY = (org: string) => `jarvis:digests:${org}`;
const SEEN_KEY = (org: string, k: string) => `jarvis:seen:${org}:${k}`;
const MAIL_KEY = (org: string) => `jarvis:mail:${org}`;
const KEEP_MS = 30 * 86_400_000;

/**
 * Jarvis: the business assistant's extra jobs (ideas from OpenJarvis, rebuilt on this platform's own data):
 * a morning digest, scheduled monitors with alerts, "ask your business data", a usage and cost tracker, and checks of
 * office mail, Instagram and the "ERP" (this platform's own orders, stock and money). Read-only towards customers:
 * nothing here messages a customer or changes an order.
 */
@Injectable()
export class JarvisService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly data: JarvisDataService,
    private readonly creds: CredentialsService,
  ) {}

  store: CartStore = sharedCartStore();
  fetchImpl: typeof fetch = (u, i) => fetch(u, i);

  // ---- settings (OrganizationSettings.data.jarvis) ----
  async config(organizationId: string): Promise<JarvisConfig> {
    const row = await this.prisma.organizationSettings.findUnique({ where: { organizationId } }).catch(() => null);
    return sanitizeJarvis((row?.data as Record<string, unknown> | undefined)?.jarvis, DEFAULT_JARVIS);
  }

  async saveConfig(organizationId: string, patch: unknown): Promise<JarvisConfig> {
    const row = await this.prisma.organizationSettings.findUnique({ where: { organizationId } });
    const data = (row?.data as Record<string, unknown> | undefined) ?? {};
    const next = sanitizeJarvis(patch, sanitizeJarvis(data.jarvis, DEFAULT_JARVIS));
    await this.prisma.organizationSettings.upsert({ where: { organizationId }, create: { organizationId, data: { jarvis: next } as never }, update: { data: { ...data, jarvis: next } as never } });
    log.info('jarvis.settings_saved', { organizationId });
    return next;
  }

  // ---- history (Redis, 30 days) ----
  private async list<T>(key: string): Promise<T[]> {
    try { return JSON.parse((await this.store.get(key)) ?? '[]') as T[]; } catch { return []; }
  }
  private async push<T>(key: string, item: T, keep: number) {
    const all = [item, ...(await this.list<T>(key))].slice(0, keep);
    await this.store.set(key, JSON.stringify(all), KEEP_MS);
  }
  alerts(organizationId: string) { return this.list<Alert & { resolved?: boolean }>(ALERTS_KEY(organizationId)); }
  digests(organizationId: string) { return this.list<DigestRecord>(DIGESTS_KEY(organizationId)); }

  // ---- digest ----
  async buildDigest(organizationId: string, source: DigestRecord['source'], now = new Date()): Promise<DigestRecord> {
    const cfg = await this.config(organizationId);
    const s = await this.data.snapshot(organizationId, cfg, now);
    const d = digestLines(s);
    const rec: DigestRecord = { at: now.toISOString(), date: istClock(now).date, headline: d.headline, lines: d.lines, source };
    await this.push(DIGESTS_KEY(organizationId), rec, 14);
    log.info('jarvis.digest', { organizationId, source, lines: d.lines.length });
    return rec;
  }

  // ---- monitors ----
  async runMonitors(organizationId: string, now = new Date()): Promise<{ raised: Alert[]; checked: number }> {
    const cfg = await this.config(organizationId);
    const s = await this.data.snapshot(organizationId, cfg, now);
    let mailUnread: number | null = null;
    if (cfg.monitors.mail_unread.on) mailUnread = (await this.officeMail(organizationId, true)).unread;
    let spendToday: number | undefined;
    if (cfg.monitors.usage_budget.on && cfg.dailyBudget > 0) spendToday = (await this.data.usage(organizationId, 1, cfg, now)).totals.cost;
    const found = evaluateMonitors(s, cfg, { mailUnread, spendToday });
    const raised: Alert[] = [];
    for (const a of found) {
      const seen = await this.store.get(SEEN_KEY(organizationId, a.dedupeKey));
      if (seen) continue;
      await this.store.set(SEEN_KEY(organizationId, a.dedupeKey), '1', 26 * 3_600_000);
      await this.push(ALERTS_KEY(organizationId), a, 100);
      publishLive(organizationId, { type: 'alert', status: a.severity, title: a.title });
      raised.push(a);
    }
    if (raised.length) log.info('jarvis.alerts', { organizationId, raised: raised.map((a) => a.monitor) });
    return { raised, checked: found.length };
  }

  async resolveAlert(organizationId: string, id: string) {
    const all = await this.alerts(organizationId);
    const next = all.map((a) => (a.id === id ? { ...a, resolved: true } : a));
    await this.store.set(ALERTS_KEY(organizationId), JSON.stringify(next), KEEP_MS);
    return { ok: true };
  }

  // ---- overview page ----
  async overview(organizationId: string) {
    const cfg = await this.config(organizationId);
    const s = await this.data.snapshot(organizationId, cfg);
    const [alerts, digests] = await Promise.all([this.alerts(organizationId), this.digests(organizationId)]);
    return { snapshot: s, digest: digestLines(s), lastDigest: digests[0] ?? null, alerts: alerts.filter((a) => !a.resolved).slice(0, 20), settings: cfg, monitorInfo: MONITOR_INFO };
  }

  // ---- ask your business data ----
  async ask(organizationId: string, question: unknown) {
    const q = typeof question === 'string' ? question.trim().slice(0, 500) : '';
    if (q.length < 3) throw new BadRequestException('Ask a question about your business, for example “How many orders came by phone yesterday?”.');
    const cfg = await this.config(organizationId);
    const [s, usage] = await Promise.all([this.data.snapshot(organizationId, cfg), this.data.usage(organizationId, 7, cfg)]);
    const facts = factSheet(s, usage);
    const acct = await openaiRunner();
    if (!acct.runner) return { answer: null, facts, source: 'facts' as const, note: 'No AI model is configured for this workspace: here are the numbers Jarvis has.' };
    configureClient();
    const agent = new Agent({
      name: 'Jarvis business analyst',
      model: process.env.OPENAI_MODEL || 'gpt-5.4-mini',
      modelSettings: modelSettings('low', 500),
      instructions: [
        'You answer a business owner’s question using ONLY the facts given. Never invent numbers, customers or causes.',
        'If the facts do not contain the answer, say exactly what is missing and which page of the dashboard would show it.',
        'Answer in the language of the question (English, Tamil or Tanglish), in at most 5 short sentences, with the numbers.',
      ].join('\n'),
      tools: [],
    });
    try {
      const r = await acct.runner.run(agent, `Facts:\n${facts}\n\nQuestion: ${q}`, { maxTurns: 1, signal: AbortSignal.timeout(30_000) });
      const u = r.runContext?.usage;
      void this.prisma.integrationEvent.create({ data: { organizationId, provider: 'openai', kind: 'chat', ok: true, units: (u?.inputTokens ?? 0) + (u?.outputTokens ?? 0) || null, unitType: 'tokens', source: acct.source, message: 'jarvis.ask' } }).catch(() => undefined);
      return { answer: String(r.finalOutput ?? '').trim(), facts, source: 'ai' as const };
    } catch (e) {
      log.warn('jarvis.ask_failed', { organizationId, error: errorMessage(e) });
      return { answer: null, facts, source: 'facts' as const, note: 'The AI model did not answer: here are the numbers Jarvis has.' };
    }
  }

  // ---- checks ----
  async officeMail(organizationId: string, cached = false): Promise<MailSummary> {
    if (cached) {
      const hit = await this.store.get(MAIL_KEY(organizationId));
      if (hit) try { return JSON.parse(hit) as MailSummary; } catch { /* refresh */ }
    }
    const c = await this.creds.resolve(organizationId, 'office_mail');
    const r = c.source === 'organization' ? await checkOfficeMail(c.config, c.secrets) : { ok: false, account: '', unread: 0, total: 0, recent: [], message: 'Office mail is not connected (Integrations → Office mail: Gmail address and app password, then Test).' };
    await this.store.set(MAIL_KEY(organizationId), JSON.stringify(r), 5 * 60_000);
    return r;
  }

  async instagram(organizationId: string) {
    const c = await this.creds.resolve(organizationId, 'meta_social');
    const account = c.source === 'organization' ? await checkInstagram(this.fetchImpl, c.secrets.pageAccessToken, c.config.instagramAccountId) : { ok: false, recent: [], message: 'Instagram is not connected (Integrations → Instagram & Messenger).' };
    const cfg = await this.config(organizationId);
    const s = await this.data.snapshot(organizationId, cfg);
    return { account, waiting: s.instagramWaiting };
  }

  async checks(organizationId: string) {
    const cfg = await this.config(organizationId);
    const [mail, instagram, erp] = await Promise.all([this.officeMail(organizationId), this.instagram(organizationId), this.data.erp(organizationId, cfg)]);
    return { mail, instagram, erp };
  }

  usage(organizationId: string, days: number) {
    return this.config(organizationId).then((cfg) => this.data.usage(organizationId, days, cfg));
  }
}
