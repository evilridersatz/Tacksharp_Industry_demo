import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { ConversationsService } from '../conversations/conversations.service.js';
import { normalizePhone } from '../common/phone.js';
import { detectLanguage } from '../conversation/language.js';
import { errorMessage, log } from '../common/logger.js';
import type { GenerateResponseInput, GenerateResponseResult } from '../ai/conversation-engine.service.js';
import { ACTIVE_STATES, CATEGORY_LABEL, durationText, minutesBetween, troubleshooting, type Category } from './rules.js';
import { IncidentsService } from './incidents.service.js';

const NUM = /\bINC[-\s]?(\d{3,7})\b/i;
const FIXED = /\b(fixed|resolved|restored|solved|repaired|working now|ok now|back online|sari aagiduchu|seri aagiduchu|seri panniten|sari panniten|ready aagiduchu)\b|சரி\s*ஆயிடுச்சு|சரி\s*பண்ணிட்டேன்/i;
const PROGRESS = /\b(reached|on site|onsite|at site|working on it|started|on the way|going now|vandhutten|vanthuten|poitu iruken|poikitu iruken|varen|coming)\b|வந்துட்டேன்|போயிட்டு/i;
const ACK = /^\s*(ack|acknowledge[ds]?|ok|okay|k|seri|sari|sure|noted|received|paakuren|pakuren|parkiren|parkuren|on it|will check|checking)\b|சரி|பாக்குறேன்/i;
const HELP = /\b(help|steps|how|what to check|enna pannanum|enna check)\b|என்ன\s*பண்ணனும்/i;
const STATUS = /\b(status|list|open|pending|incidents?|summary)\b/i;

type Reply = { text: string; intent: string };

/**
 * WhatsApp replies from technicians (and customer contacts) of a VisionOps workspace. Rules only:
 *  - "ACK INC-1042" / "ok" / "seri"        → acknowledge (the most recent incident they were alerted about, or the one named)
 *  - "reached site" / "working on it"       → IN_PROGRESS (assigned to them if nobody is)
 *  - "fixed INC-1042 loose PoE cable"       → restoration check: RESOLVED only with fresh successful checks
 *  - "HELP INC-1042"                        → safe first checks for that fault (no claimed remote control)
 *  - "status"                               → their open incidents
 * A customer contact gets a read-only status of their sites. Nobody gets a promised arrival time or a repair claim.
 */
@Injectable()
export class TechnicianAssistant {
  constructor(private readonly prisma: PrismaService, private readonly conversations: ConversationsService, private readonly incidents: IncidentsService) {}

  async generate(input: GenerateResponseInput & { organizationId: string }, now = new Date()): Promise<GenerateResponseResult> {
    const started = Date.now();
    const org = input.organizationId;
    const phone = normalizePhone(input.phone) ?? input.phone;
    const channel = input.channel === 'whatsapp' ? 'whatsapp' : input.channel === 'voice' ? 'voice' : 'web';
    const customer = await this.conversations.getOrCreateCustomerByPhone(org, phone, { name: input.customerName, source: channel === 'web' ? 'test_chat' : channel });
    const conversation = await this.conversations.getOrCreateConversation({ organizationId: org, channel, externalId: phone, customerId: customer.id });
    await this.conversations.addMessage({ organizationId: org, conversationId: conversation.id, role: 'user', content: input.message.slice(0, 4000), metadata: { ...(input.metadata ?? {}), channel } });
    const tl = ['tamil', 'tanglish'].includes(detectLanguage(input.message).lang);

    let reply: Reply;
    try {
      let tech = await this.prisma.siteTechnician.findFirst({ where: { organizationId: org, phone, active: true } });
      // Demo playground / scenario runner: the synthetic tester speaks as the demo workspace's first field technician.
      if (!tech && (input.metadata as { playground?: boolean; scenario?: boolean } | undefined)?.playground) {
        const demo = await this.prisma.organization.findUnique({ where: { id: org }, select: { isDemo: true } });
        if (demo?.isDemo) tech = await this.prisma.siteTechnician.findFirst({ where: { organizationId: org, role: 'technician', active: true }, orderBy: { name: 'asc' } });
      }
      reply = tech ? await this.technicianTurn(org, tech, input.message, tl, now) : await this.otherTurn(org, phone, tl);
    } catch (error) {
      log.error('visionops.assistant_failed', { org, error: errorMessage(error) });
      reply = { text: 'Sorry, I could not process that. Please use the dashboard or reply "status".', intent: 'error' };
    }
    await this.conversations.addMessage({ organizationId: org, conversationId: conversation.id, role: 'assistant', content: reply.text, metadata: { channel, intent: reply.intent, industry: 'cctv', path: 'rules', ...(channel !== 'whatsapp' ? { simulated: true } : {}) } });
    return { conversationId: conversation.id, customerId: customer.id, response: reply.text, actions: {}, timings: { totalMs: Date.now() - started }, path: 'rules', intent: reply.intent } as unknown as GenerateResponseResult;
  }

  /** The incident a message is about: the number in it, else the newest active one this person was alerted about / assigned. */
  private async target(org: string, techId: string, siteId: string | null, text: string) {
    const m = text.match(NUM);
    if (m) return this.prisma.downtimeIncident.findFirst({ where: { organizationId: org, number: `INC-${m[1]}` }, include: { site: { select: { name: true } } } });
    const alerted = await this.prisma.notificationAttempt.findMany({ where: { organizationId: org, technicianId: techId }, select: { incidentId: true }, orderBy: { createdAt: 'desc' }, take: 20 });
    return this.prisma.downtimeIncident.findFirst({
      where: { organizationId: org, status: { in: ACTIVE_STATES }, OR: [{ id: { in: alerted.map((a) => a.incidentId) } }, { assignedTechnicianId: techId }, ...(siteId ? [{ siteId }] : [])] },
      orderBy: [{ acknowledgedAt: { sort: 'asc', nulls: 'first' } }, { firstDetectedAt: 'desc' }],
      include: { site: { select: { name: true } } },
    });
  }

  private async technicianTurn(org: string, tech: { id: string; name: string; siteId: string | null }, text: string, tl: boolean, now: Date): Promise<Reply> {
    const actor = `technician:${tech.name}`;
    const t = (en: string, ta: string) => (tl ? ta : en);
    if (STATUS.test(text) && !NUM.test(text) && !FIXED.test(text)) {
      const open = await this.prisma.downtimeIncident.findMany({ where: { organizationId: org, status: { in: ACTIVE_STATES }, OR: [{ assignedTechnicianId: tech.id }, ...(tech.siteId ? [{ siteId: tech.siteId }] : [{}])] }, include: { site: { select: { name: true } } }, orderBy: { firstDetectedAt: 'asc' }, take: 8 });
      if (!open.length) return { text: t('No open incidents for you right now.', 'Ungalukku ippo open incident edhuvum illa.'), intent: 'status' };
      return { text: `${t('Open incidents', 'Open incidents')}:\n${open.map((i) => `• ${i.number} ${i.deviceCode ?? ''} @ ${i.site.name}: ${CATEGORY_LABEL[i.category as Category]} · ${i.status} · ${durationText(minutesBetween(i.firstDetectedAt, now))}`).join('\n')}`, intent: 'status' };
    }
    const inc = await this.target(org, tech.id, tech.siteId, text);
    if (!inc) return { text: t('I could not find that incident. Reply "status" to see your open incidents.', 'Andha incident kidaikkala. "status" nu reply panni open incidents paarunga.'), intent: 'not_found' };
    if (!ACTIVE_STATES.includes(inc.status as never)) return { text: `${inc.number} ${t('is already', 'already')} ${inc.status}${inc.resolvedBy === 'verification' ? t(' (verified by monitoring checks)', ' (monitoring checks verify panniduchu)') : ''}.`, intent: 'closed' };

    if (HELP.test(text)) {
      const steps = troubleshooting(inc.category as Category);
      await this.incidents.timeline(org, inc.id, 'troubleshooting', `First checks sent to ${tech.name}.`, 'ai', undefined, now);
      return { text: `${inc.number} · ${CATEGORY_LABEL[inc.category as Category]}${inc.deviceCode ? ` (${inc.deviceCode})` : ''} @ ${inc.site.name}\n${steps.map((s, k) => `${k + 1}. ${s}`).join('\n')}\n${t('I cannot control the device remotely; these are checks for you on site.', 'Naan device-a remote-aa control panna mudiyaadhu; idhu site-la neenga check panna vendiyadhu.')}`, intent: 'troubleshooting' };
    }
    if (FIXED.test(text)) {
      const note = text.replace(NUM, '').replace(FIXED, '').trim().slice(0, 300);
      const r = await this.incidents.requestResolve(org, inc.id, actor, { note: note || undefined, rootCause: note || undefined }, now);
      if (r.resolved) return { text: t(`Thanks ${tech.name}. ${inc.number} is resolved: fresh monitoring checks confirm ${inc.deviceCode ?? 'the device'} is responding.`, `Nandri ${tech.name}. ${inc.number} resolve aagiduchu: ${inc.deviceCode ?? 'device'} respond panradhu monitoring checks confirm pannuchu.`), intent: 'resolved' };
      return { text: t(`Thanks ${tech.name}. I have noted it. ${inc.number} will be marked resolved after ${r.needed} more successful monitoring check(s) of ${inc.deviceCode ?? 'the device'}; right now it is not confirmed yet.`, `Nandri ${tech.name}. Note pannitten. ${inc.deviceCode ?? 'Device'}-ku innum ${r.needed} successful check vandha apram ${inc.number} resolve aagum; ippo confirm aagala.`), intent: 'restoration_check' };
    }
    if (PROGRESS.test(text)) {
      if (!inc.assignedTechnicianId) await this.incidents.assign(org, inc.id, tech.id, actor, now);
      await this.incidents.start(org, inc.id, actor, now, text.slice(0, 200));
      return { text: t(`${inc.number} is now IN PROGRESS with you. Reply "fixed ${inc.number} <what you did>" when done; I will confirm with fresh checks.`, `${inc.number} ippo ungakitta IN PROGRESS. Mudinjadhum "fixed ${inc.number} <enna panneenga>" nu reply pannunga; fresh checks vachu confirm pannuven.`), intent: 'in_progress' };
    }
    if (ACK.test(text) || NUM.test(text)) {
      const r = await this.incidents.acknowledge(org, inc.id, actor, now, 'whatsapp');
      if (!inc.assignedTechnicianId) await this.incidents.assign(org, inc.id, tech.id, actor, now);
      return { text: r.already ? t(`${inc.number} was already acknowledged. Status: ${r.incident?.status}.`, `${inc.number} already acknowledge aagiduchu. Status: ${r.incident?.status}.`) : t(`${inc.number} acknowledged. Assigned to ${tech.name}. Status: investigating. Reply "HELP ${inc.number}" for first checks.`, `${inc.number} acknowledge aagiduchu. ${tech.name}-ku assign pannitten. "HELP ${inc.number}" nu reply panna first checks anuppuven.`), intent: 'acknowledged' };
    }
    return { text: t('Reply "ACK INC-1042" to acknowledge, "HELP INC-1042" for checks, "reached site", "fixed INC-1042 <note>", or "status".', '"ACK INC-1042" acknowledge panna, "HELP INC-1042" checks-ku, "reached site", "fixed INC-1042 <note>", illa "status" nu reply pannunga.'), intent: 'menu' };
  }

  private async otherTurn(org: string, phone: string, tl: boolean): Promise<Reply> {
    const customer = await this.prisma.monitoringCustomer.findFirst({ where: { organizationId: org, contactPhone: phone } });
    if (!customer) return { text: tl ? 'Idhu CCTV service alerts number. Engal team inga reply pannuvaanga.' : 'This number handles CCTV monitoring alerts. Our service team will reply to you here.', intent: 'other' };
    const open = await this.prisma.downtimeIncident.findMany({ where: { organizationId: org, customerId: customer.id, status: { in: ACTIVE_STATES }, resolvedBy: null }, include: { site: { select: { name: true } } }, take: 6 });
    if (!open.length) return { text: `${customer.name}: no open camera incidents right now. All monitored issues are resolved.`, intent: 'customer_status' };
    return { text: `${customer.name}: ${open.length} open incident(s):\n${open.map((i) => `• ${i.number} @ ${i.site.name}: ${CATEGORY_LABEL[i.category as Category]} (${i.status === 'OPEN' ? 'reported to our technician' : i.status.toLowerCase().replace('_', ' ')})`).join('\n')}\nOur team will update you here when it is resolved.`, intent: 'customer_status' };
  }
}
