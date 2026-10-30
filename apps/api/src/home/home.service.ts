import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { CredentialsService } from '../integrations/credentials.service.js';
import { INDUSTRY_LABEL, catalogueFor, effectiveIndustry, type IndustryId } from '../industry/industries.js';
import { followUpConfig } from '../restaurant/followup-config.js';
import { webhookSecret } from '../telephony/webhook-token.js';

export type StepStatus = 'complete' | 'action_required' | 'in_progress' | 'blocked';
export type Step = { id: string; label: string; status: StepStatus; detail: string; action?: { label: string; href: string } };
export type Attention = { id: string; severity: 'critical' | 'warning'; title: string; detail: string; action?: { label: string; href: string } };
export type ChannelState = { id: 'whatsapp' | 'voice'; label: string; status: 'connected' | 'not_connected' | 'needs_attention' | 'incomplete'; detail: string; via?: string; href: string };

const RANGES = { today: 1, '7d': 7, '30d': 30 } as const;
export type Range = keyof typeof RANGES;
const DAY = 86_400_000;

/** Start of the day in India (the businesses' time zone), as a UTC instant. */
function istDayStart(d: Date): Date {
  const ist = new Date(d.getTime() + 5.5 * 3600_000);
  ist.setUTCHours(0, 0, 0, 0);
  return new Date(ist.getTime() - 5.5 * 3600_000);
}

/**
 * The business owner's Home: setup readiness, what needs attention, and results, computed only from THIS
 * organization's records and its real integration state. Nothing here is estimated or invented: a metric without
 * data is returned as 0 with `hasData: false`, and a channel is "connected" only when a successful test or a routed
 * number proves it (never because a server variable exists).
 */
@Injectable()
export class HomeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly creds: CredentialsService,
  ) {}

  async channels(organizationId: string): Promise<ChannelState[]> {
    const [waRow, plivoRow, sarvamRow, wa, plivo, sarvam, routes] = await Promise.all([
      this.creds.row(organizationId, 'whatsapp'),
      this.creds.row(organizationId, 'plivo'),
      this.creds.row(organizationId, 'sarvam_telephony'),
      this.creds.resolve(organizationId, 'whatsapp'),
      this.creds.resolve(organizationId, 'plivo'),
      this.creds.resolve(organizationId, 'sarvam_telephony'),
      this.prisma.organizationChannel.findMany({ where: { organizationId, kind: { in: ['whatsapp_phone_number_id', 'plivo_number'] } }, select: { kind: true } }),
    ]);
    const routed = (kind: string) => routes.some((r) => r.kind === kind);
    const state = (
      id: ChannelState['id'], label: string, href: string,
      rows: Array<{ row: { status: string; enabled: boolean } | null; eff: { source: string; reason?: string }; name: string; routeKind?: string }>,
    ): ChannelState => {
      for (const r of rows) {
        // Own account, tested and enabled.
        if (r.eff.source === 'organization') return { id, label, status: 'connected', detail: `Connected through your own ${r.name} account.`, via: r.name, href };
        // The platform's account, and a number of this organization is actually routed to it.
        if (r.eff.source === 'environment' && !r.eff.reason && r.routeKind && routed(r.routeKind)) return { id, label, status: 'connected', detail: `Connected through Tacksharp's ${r.name} account; your number is routed to this workspace.`, via: r.name, href };
      }
      const failed = rows.find((r) => r.row?.status === 'failed');
      if (failed) return { id, label, status: 'needs_attention', detail: `The last ${failed.name} connection test failed. Open the settings to see why and test again.`, href };
      const saved = rows.find((r) => r.row);
      if (saved) return { id, label, status: 'incomplete', detail: saved.row!.status === 'ok' ? `${saved.name} is tested but not switched on yet.` : `${saved.name} details are saved but have not passed a connection test yet.`, href };
      return { id, label, status: 'not_connected', detail: id === 'whatsapp' ? 'Connect WhatsApp so your AI assistant can answer customer messages.' : 'Connect a voice provider so your AI assistant can answer and place calls.', href };
    };
    return [
      state('whatsapp', 'WhatsApp', '/settings/integrations/whatsapp', [{ row: waRow, eff: wa, name: 'WhatsApp', routeKind: 'whatsapp_phone_number_id' }]),
      state('voice', 'Voice calls', '/settings/integrations', [
        { row: plivoRow, eff: plivo, name: 'Plivo', routeKind: 'plivo_number' },
        { row: sarvamRow, eff: sarvam, name: 'Sarvam' },
      ]),
    ];
  }

  async overview(organizationId: string, rangeRaw: string | undefined) {
    const range: Range = (rangeRaw && rangeRaw in RANGES ? rangeRaw : '7d') as Range;
    const days = RANGES[range];
    const now = new Date();
    const from = range === 'today' ? istDayStart(now) : new Date(istDayStart(now).getTime() - (days - 1) * DAY);
    const prevFrom = new Date(from.getTime() - (now.getTime() - from.getTime()));
    const org = await this.prisma.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { id: true, name: true, status: true, vertical: true, isDemo: true, contactPhone: true, selfServe: true } });
    const s = await this.settings.get(organizationId);
    const industry: IndustryId = effectiveIndustry(org.vertical, s.industry);
    const builtIn = catalogueFor(industry).some((a) => a.runtime.type === 'conversation');
    const between = (a: Date, b: Date) => ({ gte: a, lt: b });
    const period = between(from, now);
    const prev = between(prevFrom, from);
    const ordersApply = industry === 'restaurant';
    const leadsApply = !['restaurant', 'cctv'].includes(industry);

    const [
      channels, agents, testedAgents, customers, consenting, messagingConsent, optedOut,
      msgsNow, msgsPrev, convNow, convPrev, callsDone, callsDonePrev, callsFailed, leadsNow, leadsPrev, ordersNow, ordersPrev, fuDone, fuDonePrev,
      failedCreds, failedDocs, failedReqs, okTests,
    ] = await Promise.all([
      this.channels(organizationId),
      this.prisma.voiceAgent.findMany({ where: { organizationId, status: { not: 'archived' } }, select: { id: true, name: true, status: true, lastTestedAt: true } }),
      this.prisma.voiceAgent.count({ where: { organizationId, lastTestedAt: { not: null } } }),
      this.prisma.customer.count({ where: { organizationId, isDemo: org.isDemo ? undefined : false } }),
      this.prisma.customer.count({ where: { organizationId, callingConsent: true, optedOutAt: null, doNotContact: false } }),
      this.prisma.customer.count({ where: { organizationId, messagingConsent: true, optedOutAt: null, doNotContact: false } }),
      this.prisma.customer.count({ where: { organizationId, OR: [{ optedOutAt: { not: null } }, { doNotContact: true }] } }),
      this.prisma.message.count({ where: { organizationId, role: 'user', createdAt: period } }),
      this.prisma.message.count({ where: { organizationId, role: 'user', createdAt: prev } }),
      this.prisma.message.groupBy({ by: ['conversationId'], where: { organizationId, createdAt: period } }).then((r) => r.length),
      this.prisma.message.groupBy({ by: ['conversationId'], where: { organizationId, createdAt: prev } }).then((r) => r.length),
      this.prisma.call.count({ where: { organizationId, status: 'completed', createdAt: period } }),
      this.prisma.call.count({ where: { organizationId, status: 'completed', createdAt: prev } }),
      this.prisma.call.count({ where: { organizationId, status: 'failed', createdAt: { gte: new Date(now.getTime() - 7 * DAY) } } }),
      leadsApply ? this.prisma.lead.count({ where: { organizationId, createdAt: period } }) : 0,
      leadsApply ? this.prisma.lead.count({ where: { organizationId, createdAt: prev } }) : 0,
      ordersApply ? this.prisma.order.count({ where: { organizationId, createdAt: period } }) : 0,
      ordersApply ? this.prisma.order.count({ where: { organizationId, createdAt: prev } }) : 0,
      this.prisma.followUp.count({ where: { organizationId, status: { in: ['sent', 'completed', 'done'] }, updatedAt: period } }),
      this.prisma.followUp.count({ where: { organizationId, status: { in: ['sent', 'completed', 'done'] }, updatedAt: prev } }),
      this.prisma.integrationCredential.findMany({ where: { organizationId, status: 'failed' }, select: { provider: true } }),
      this.prisma.knowledgeDocument.count({ where: { organizationId, status: 'failed' } }),
      this.prisma.telephonyCallRequest.count({ where: { organizationId, status: 'failed', createdAt: { gte: new Date(now.getTime() - 7 * DAY) } } }),
      this.prisma.integrationEvent.count({ where: { organizationId, ok: true, kind: { in: ['test', 'tts', 'stt', 'call'] } } }),
    ]);

    const anyChannel = channels.some((c) => c.status === 'connected');
    const customersHref = industry === 'restaurant' ? '/customers' : '/contacts';
    const activeAgents = agents.filter((a) => a.status === 'active');
    const live = followUpConfig();
    const voice = channels.find((c) => c.id === 'voice')!;

    // ------------------------------------------------------------------ setup readiness (never green when incomplete)
    const checklist: Step[] = [
      org.name && org.contactPhone
        ? { id: 'profile', label: 'Business profile', status: 'complete', detail: `${org.name} · ${INDUSTRY_LABEL[industry]}` }
        : { id: 'profile', label: 'Business profile', status: 'action_required', detail: 'Add your business phone number so your team and Tacksharp can reach you.', action: { label: 'Complete profile', href: '/settings' } },
      activeAgents.length
        ? { id: 'agent', label: 'AI agent', status: 'complete', detail: `${activeAgents.length} custom agent${activeAgents.length > 1 ? 's' : ''} active.` }
        : builtIn
          ? { id: 'agent', label: 'AI agent', status: 'complete', detail: `The built-in ${INDUSTRY_LABEL[industry]} assistant answers your customers. You can also create custom agents.` }
          : agents.length
            ? { id: 'agent', label: 'AI agent', status: 'in_progress', detail: 'Your agent is a draft. Test it and publish it.', action: { label: 'Finish your agent', href: `/voice-agents/${agents[0].id}` } }
            : { id: 'agent', label: 'AI agent', status: 'action_required', detail: 'Your business has no AI assistant yet. Create one from a ready-made template.', action: { label: 'Create an agent', href: '/voice-agents' } },
      anyChannel
        ? { id: 'channels', label: 'Communication channels', status: 'complete', detail: channels.filter((c) => c.status === 'connected').map((c) => c.label).join(' and ') + ' connected.' }
        : channels.some((c) => c.status === 'needs_attention' || c.status === 'incomplete')
          ? { id: 'channels', label: 'Communication channels', status: 'in_progress', detail: 'A channel is saved but not working yet.', action: { label: 'Finish connecting', href: '/settings/integrations' } }
          : { id: 'channels', label: 'Communication channels', status: 'action_required', detail: 'Connect WhatsApp or voice calling so customers can reach your AI assistant.', action: { label: 'Connect a channel', href: '/settings/integrations' } },
      customers
        ? { id: 'customers', label: 'Customer data', status: 'complete', detail: `${customers.toLocaleString('en-IN')} customer${customers > 1 ? 's' : ''} in your workspace.` }
        : { id: 'customers', label: 'Customer data', status: 'action_required', detail: 'Add your customers (one by one or from a file), or let them arrive through WhatsApp.', action: { label: 'Add customers', href: customersHref } },
      consenting || messagingConsent
        ? { id: 'consent', label: 'Consent and calling permissions', status: 'complete', detail: `${consenting} agreed to calls, ${messagingConsent} to WhatsApp messages${optedOut ? `; ${optedOut} opted out (never contacted)` : ''}.` }
        : { id: 'consent', label: 'Consent and calling permissions', status: customers ? 'action_required' : 'blocked', detail: customers ? 'No customer has agreed to be called or messaged yet. Record consent on each customer before any follow-up.' : 'Add customers first, then record their consent.', action: customers ? { label: 'Record consent', href: customersHref } : undefined },
      testedAgents || okTests
        ? { id: 'test', label: 'Test conversation or call', status: 'complete', detail: 'A test has passed.' }
        : { id: 'test', label: 'Test conversation or call', status: 'action_required', detail: 'Have a test conversation with your assistant before customers do.', action: { label: 'Test your assistant', href: agents[0] ? `/voice-agents/${agents[0].id}` : '/voice-agents' } },
      org.status === 'pending_review'
        ? { id: 'production', label: 'Production readiness', status: 'blocked', detail: 'Tacksharp is reviewing your account. You can set everything up; nothing reaches customers until it is activated.' }
        : org.status === 'suspended'
          ? { id: 'production', label: 'Production readiness', status: 'blocked', detail: 'This workspace is suspended. Contact Tacksharp.' }
          : live.dryRun
            ? { id: 'production', label: 'Production readiness', status: 'in_progress', detail: 'Test mode: messages and calls are checked but not sent. Tacksharp switches live sending on when you are ready.' }
            : !anyChannel
              ? { id: 'production', label: 'Production readiness', status: 'action_required', detail: 'Live sending is on, but no channel is connected yet.', action: { label: 'Connect a channel', href: '/settings/integrations' } }
              : { id: 'production', label: 'Production readiness', status: 'complete', detail: live.liveAllowAll ? 'Live: consenting customers can be contacted.' : 'Live for approved test numbers only.' },
    ];
    const done = checklist.filter((c) => c.status === 'complete').length;
    const next = checklist.find((c) => c.status !== 'complete' && c.action);

    // ------------------------------------------------------------------ attention required (plain English, a fix each)
    const attention: Attention[] = [];
    if (org.status === 'pending_review') attention.push({ id: 'review', severity: 'warning', title: 'Account waiting for activation', detail: 'Tacksharp activates new accounts after a short review. Until then nothing is sent to customers.' });
    for (const c of channels.filter((x) => x.status === 'needs_attention')) attention.push({ id: `channel-${c.id}`, severity: 'critical', title: `${c.label} needs attention`, detail: c.detail, action: { label: 'Repair', href: c.href } });
    for (const f of failedCreds.filter((x) => !['whatsapp', 'plivo', 'sarvam_telephony'].includes(x.provider))) attention.push({ id: `cred-${f.provider}`, severity: 'warning', title: `${f.provider === 'openai' ? 'AI model' : 'Speech'} connection failed its last test`, detail: 'Your assistant uses Tacksharp defaults or answers from your documents until it is fixed.', action: { label: 'Open AI providers', href: '/settings/ai-providers' } });
    if (!activeAgents.length && !builtIn) attention.push({ id: 'agent', severity: 'warning', title: 'No active AI agent', detail: 'Customers are not answered automatically yet.', action: { label: 'Create an agent', href: '/voice-agents' } });
    if (voice.status !== 'connected' && activeAgents.length) attention.push({ id: 'voice', severity: 'warning', title: 'Your AI agent cannot take or place calls yet', detail: 'Connect your voice provider to continue.', action: { label: 'Complete setup', href: '/settings/integrations' } });
    if (callsFailed) attention.push({ id: 'calls', severity: 'warning', title: `${callsFailed} call${callsFailed > 1 ? 's' : ''} failed in the last 7 days`, detail: 'See each call for the reason (no answer, number problem or provider issue).', action: { label: 'Review calls', href: '/calls' } });
    if (failedReqs) attention.push({ id: 'requests', severity: 'warning', title: `${failedReqs} call request${failedReqs > 1 ? 's' : ''} could not be placed`, detail: 'The voice provider refused or could not be reached.', action: { label: 'See why', href: '/voice-agents' } });
    if (failedDocs) attention.push({ id: 'docs', severity: 'warning', title: `${failedDocs} knowledge document${failedDocs > 1 ? 's' : ''} could not be read`, detail: 'Your agent cannot use them until they are fixed or removed.', action: { label: 'Fix documents', href: '/voice-agents' } });
    if (customers && !consenting && !messagingConsent) attention.push({ id: 'consent', severity: 'warning', title: 'Customer consent is missing', detail: 'Follow-up messages and calls only go to customers who agreed.', action: { label: 'Record consent', href: customersHref } });

    // ------------------------------------------------------------------ results (verified sources only)
    const metric = (id: string, label: string, value: number, previous: number, why: string, href: string) => ({ id, label, value, previous, why, href, hasData: value > 0 || previous > 0 });
    const metrics = [
      metric('enquiries', 'Customer messages received', msgsNow, msgsPrev, 'Messages your customers sent on WhatsApp, chat or calls.', '/conversations'),
      metric('conversations', 'Conversations handled', convNow, convPrev, 'Separate customer conversations your assistant and team took part in.', '/conversations'),
      metric('calls', 'Calls completed', callsDone, callsDonePrev, 'Calls that connected and finished.', '/calls'),
      ...(leadsApply ? [metric('leads', 'New leads', leadsNow, leadsPrev, 'New enquiries that could become business.', '/leads')] : []),
      ...(ordersApply ? [metric('orders', 'Orders received', ordersNow, ordersPrev, 'Orders customers placed with your assistant or staff.', '/orders')] : []),
      metric('followups', 'Follow-ups completed', fuDone, fuDonePrev, 'Scheduled follow-ups that were sent or done.', '/follow-ups'),
    ];

    // Daily series for the chart (IST days).
    const seriesDays = range === 'today' ? 1 : days;
    const start = range === 'today' ? from : new Date(istDayStart(now).getTime() - (seriesDays - 1) * DAY);
    const [msgRows, callRows] = await Promise.all([
      this.prisma.message.findMany({ where: { organizationId, role: 'user', createdAt: { gte: start } }, select: { createdAt: true }, take: 50_000 }),
      this.prisma.call.findMany({ where: { organizationId, createdAt: { gte: start } }, select: { createdAt: true, status: true }, take: 50_000 }),
    ]);
    const bucket = (d: Date) => Math.floor((d.getTime() - start.getTime()) / DAY);
    const labels = Array.from({ length: seriesDays }, (_, i) => new Date(start.getTime() + i * DAY + 5.5 * 3600_000).toISOString().slice(0, 10));
    const messages = Array(seriesDays).fill(0);
    const calls = Array(seriesDays).fill(0);
    for (const m of msgRows) { const b = bucket(m.createdAt); if (b >= 0 && b < seriesDays) messages[b]++; }
    for (const c of callRows) { const b = bucket(c.createdAt); if (b >= 0 && b < seriesDays) calls[b]++; }
    const outcomes: Record<string, number> = {};
    for (const c of callRows) outcomes[c.status] = (outcomes[c.status] ?? 0) + 1;

    return {
      business: { name: org.name, industry, industryLabel: INDUSTRY_LABEL[industry], status: org.status, isDemo: org.isDemo },
      range, from, to: now, updatedAt: now,
      readiness: { done, total: checklist.length, ready: done === checklist.length, next: next ? { label: next.action!.label, href: next.action!.href, why: next.detail } : null },
      checklist, attention, channels,
      agents: { total: agents.length, active: activeAgents.length, builtIn },
      metrics,
      series: { labels, messages, calls },
      callOutcomes: outcomes,
      activity: await this.activity(organizationId, ordersApply),
      mode: { dryRun: live.dryRun, sarvamWebhookReady: Boolean(webhookSecret()) },
    };
  }

  /** Recent events from real records, newest first, each linking to its page. */
  private async activity(organizationId: string, orders: boolean) {
    const [leads, calls, requests, ords, audits] = await Promise.all([
      this.prisma.lead.findMany({ where: { organizationId }, orderBy: { createdAt: 'desc' }, take: 6, select: { id: true, createdAt: true, source: true, customer: { select: { name: true } } } }),
      this.prisma.call.findMany({ where: { organizationId }, orderBy: { createdAt: 'desc' }, take: 6, select: { id: true, createdAt: true, status: true, direction: true, outcome: true, customer: { select: { name: true } } } }),
      this.prisma.telephonyCallRequest.findMany({ where: { organizationId, status: { in: ['rejected', 'failed', 'dry_run'] } }, orderBy: { createdAt: 'desc' }, take: 4, select: { id: true, createdAt: true, status: true, failureReason: true } }),
      orders ? this.prisma.order.findMany({ where: { organizationId }, orderBy: { updatedAt: 'desc' }, take: 6, select: { id: true, updatedAt: true, status: true, orderNumber: true } }) : Promise.resolve([]),
      this.prisma.auditEvent.findMany({ where: { organizationId, action: { in: ['agent.published', 'integration.enabled', 'integration.disabled', 'knowledge.uploaded', 'industry_changed'] } }, orderBy: { createdAt: 'desc' }, take: 6, select: { id: true, createdAt: true, action: true, entityId: true } }),
    ]);
    const items: Array<{ id: string; at: Date; kind: string; text: string; href: string; tone: 'ok' | 'warn' | 'info' }> = [
      ...leads.map((l) => ({ id: `lead-${l.id}`, at: l.createdAt, kind: 'lead', text: `New lead${l.customer?.name ? ` from ${l.customer.name}` : ''}${l.source ? ` (${l.source.replace(/_/g, ' ')})` : ''}`, href: `/leads/${l.id}`, tone: 'info' as const })),
      ...calls.map((c) => ({ id: `call-${c.id}`, at: c.createdAt, kind: 'call', text: `${c.direction === 'inbound' ? 'Call from' : 'Call to'} ${c.customer?.name ?? 'a customer'}: ${c.status.replace(/_/g, ' ')}`, href: '/calls', tone: c.status === 'failed' ? ('warn' as const) : c.status === 'completed' ? ('ok' as const) : ('info' as const) })),
      ...requests.map((r) => ({ id: `req-${r.id}`, at: r.createdAt, kind: 'call_request', text: r.status === 'dry_run' ? 'Call checked in test mode (not placed)' : `Call not placed: ${explainReason(r.failureReason)}`, href: '/voice-agents', tone: r.status === 'dry_run' ? ('info' as const) : ('warn' as const) })),
      ...ords.map((o) => ({ id: `order-${o.id}`, at: o.updatedAt, kind: 'order', text: `Order ${o.orderNumber}: ${o.status.replace(/_/g, ' ')}`, href: '/orders', tone: o.status === 'cancelled' ? ('warn' as const) : ('info' as const) })),
      ...audits.map((a) => ({ id: `audit-${a.id}`, at: a.createdAt, kind: 'setup', text: AUDIT_TEXT[a.action] ?? a.action, href: a.action.startsWith('integration') ? '/settings/integrations' : a.action === 'industry_changed' ? '/settings' : '/voice-agents', tone: 'ok' as const })),
    ];
    return items.sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, 12);
  }
}

const AUDIT_TEXT: Record<string, string> = {
  'agent.published': 'An AI agent was published',
  'integration.enabled': 'An integration was switched on',
  'integration.disabled': 'An integration was switched off',
  'knowledge.uploaded': 'A knowledge document was uploaded',
  industry_changed: 'Business industry changed',
};

/** Plain-English reason for a call that was not placed (codes from TelephonyService / VoiceService). */
export function explainReason(code: string | null | undefined): string {
  const c = code ?? '';
  if (c.startsWith('no_calling_consent')) return "the customer's calling consent has not been recorded";
  if (c.startsWith('do_not_contact') || c.startsWith('opted_out')) return 'the customer asked not to be contacted';
  if (c.startsWith('outside_calling_hours') || c.startsWith('outside_call_window')) return 'it is outside your calling hours';
  if (c.startsWith('not_live')) return 'test mode is on (checked, not placed)';
  if (c.startsWith('agent_not_active')) return 'the AI agent is not published';
  if (c.startsWith('agent_outbound_disabled')) return 'outbound calls are off for this agent';
  if (c.includes('not_configured')) return 'the voice provider is not set up';
  if (c.startsWith('concurrency_limit') || c.startsWith('daily_limit')) return 'your calling limit was reached';
  if (c.startsWith('call_already_in_progress')) return 'a call to this customer is already in progress';
  if (c.startsWith('unknown_number')) return 'the number is not one of your customers';
  if (c.startsWith('sarvam_') || c.startsWith('plivo_')) return 'the voice provider refused or could not be reached';
  return 'see the call details';
}
