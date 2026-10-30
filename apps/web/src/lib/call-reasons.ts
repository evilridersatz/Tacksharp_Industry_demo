/**
 * Plain-English explanations for why a call was not placed or did not connect (codes from the API's call gates and
 * the providers). The raw code stays available in an expandable "technical details" line for administrators.
 */
const RULES: Array<[RegExp, string]> = [
  [/^no_calling_consent/, "The customer's calling consent has not been recorded."],
  [/^(do_not_contact|opted_out)/, 'The customer asked not to be contacted.'],
  [/^(outside_calling_hours|outside_call_window)/, 'The call was blocked by your calling hours.'],
  [/^not_live: DRY_RUN/, 'Test mode is on: everything was checked, but no real call was placed.'],
  [/^not_live: demo customer/, 'This is a demo customer with a sample number: it is never called.'],
  [/^not_live/, 'Live calling is limited to approved test numbers right now: nothing was placed.'],
  [/^agent_not_active/, 'The voice agent is not published yet.'],
  [/^agent_outbound_disabled/, 'Outbound calls are switched off for this agent.'],
  [/^agent_has_no_sarvam_app_id/, 'The voice agent is not configured: it needs its Sarvam agent id.'],
  [/(plivo|sarvam)_not_configured|PLIVO_FROM_NUMBER missing|TELEPHONY_WEBHOOK_SECRET/, 'The voice provider connection needs attention.'],
  [/^(concurrency_limit|daily_limit)/, 'Your calling limit was reached. Try again later.'],
  [/^call_already_in_progress/, 'A call to this customer is already in progress.'],
  [/^unknown_number/, 'This number is not one of your customers. Add them and record consent first.'],
  [/^customer_has_no_phone/, 'The customer has no phone number.'],
  [/^(sarvam_|plivo_error)/, 'The voice provider refused the call or could not be reached.'],
  [/^(no_answer)$/, 'The customer did not answer.'],
  [/^(busy)$/, "The customer's line was busy."],
];

export function explainCallReason(code: string | null | undefined): string {
  const c = (code ?? '').trim();
  if (!c) return 'No reason was given.';
  return RULES.find(([r]) => r.test(c))?.[1] ?? 'The call could not be completed. See the technical details.';
}
