import { normalizePhone } from '../common/phone.js';

/**
 * Follow-up settings, read from the environment each time (so tests and a restart pick up changes).
 *
 *   DRY_RUN                         default true. true = no WhatsApp message is sent and no call is placed:
 *                                   mock adapters record the exact request and a simulated result.
 *   LIVE_TEST_RECIPIENTS            comma-separated numbers explicitly approved for real-provider testing.
 *   LIVE_ALLOW_ALL_CUSTOMERS        default false. Only for production after testing: allow real follow-ups
 *                                   to every (non-demo, consenting) customer, not just the test list.
 *   FOLLOWUP_FEEDBACK_DELAY_MINUTES default 30. WhatsApp feedback request this long after collection.
 *   FOLLOWUP_CALL_DELAY_MINUTES     default 120. Voice follow-up this long after collection.
 *   FOLLOWUP_CALL_MAX_ATTEMPTS      default 2. Calls per order including retries after no answer.
 *   FOLLOWUP_CALL_RETRY_MINUTES     default 60. Wait before calling again after no answer.
 *   FOLLOWUP_SEND_MAX_ATTEMPTS      default 3. Attempts for a WhatsApp send that fails with a temporary error.
 *   FOLLOWUP_FEEDBACK_TEMPLATE      approved WhatsApp template for the feedback request outside the 24h window
 *                                   ({{1}} customer name, {{2}} order number).
 *   FOLLOWUP_CONFIRMATION_TEMPLATE  approved template for confirmations / updates outside 24h ({{1}} order number).
 */
export function followUpConfig(env: NodeJS.ProcessEnv = process.env) {
  const num = (name: string, fallback: number) => {
    const v = Number(env[name]);
    return Number.isFinite(v) && v >= 0 ? v : fallback;
  };
  const recipients = (env.LIVE_TEST_RECIPIENTS ?? '')
    .split(',')
    .map((p) => normalizePhone(p.trim()))
    .filter((p): p is string => Boolean(p));
  return {
    dryRun: env.DRY_RUN !== 'false',
    liveTestRecipients: recipients,
    liveAllowAll: env.LIVE_ALLOW_ALL_CUSTOMERS === 'true',
    feedbackDelayMinutes: num('FOLLOWUP_FEEDBACK_DELAY_MINUTES', 30),
    callDelayMinutes: num('FOLLOWUP_CALL_DELAY_MINUTES', 120),
    callMaxAttempts: Math.max(1, num('FOLLOWUP_CALL_MAX_ATTEMPTS', 2)),
    callRetryMinutes: num('FOLLOWUP_CALL_RETRY_MINUTES', 60),
    sendMaxAttempts: Math.max(1, num('FOLLOWUP_SEND_MAX_ATTEMPTS', 3)),
    feedbackTemplate: env.FOLLOWUP_FEEDBACK_TEMPLATE ?? '',
    confirmationTemplate: env.FOLLOWUP_CONFIRMATION_TEMPLATE ?? '',
  };
}

export type FollowUpConfig = ReturnType<typeof followUpConfig>;

/**
 * May this follow-up reach a real provider? Dry-run never does. Live mode only reaches explicitly approved
 * test numbers (or everyone once LIVE_ALLOW_ALL_CUSTOMERS=true), and never a demo (synthetic) customer.
 */
export function liveGate(cfg: FollowUpConfig, customer: { phone: string | null; isDemo: boolean }): { live: boolean; reason?: string } {
  if (cfg.dryRun) return { live: false, reason: 'DRY_RUN is on' };
  if (customer.isDemo) return { live: false, reason: 'demo customer: synthetic number is never contacted' };
  if (!customer.phone) return { live: false, reason: 'no phone number' };
  if (cfg.liveAllowAll) return { live: true };
  if (cfg.liveTestRecipients.includes(customer.phone)) return { live: true };
  return { live: false, reason: 'not an approved test recipient (LIVE_TEST_RECIPIENTS)' };
}
