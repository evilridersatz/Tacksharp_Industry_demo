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
  [/sarvam_not_configured|no_sarvam_agent|agent_has_no_sarvam_app_id|TELEPHONY_WEBHOOK_SECRET/, 'The voice provider connection needs attention.'],
  [/^(concurrency_limit|daily_limit)/, 'Your calling limit was reached. Try again later.'],
  [/^call_already_in_progress/, 'A call to this customer is already in progress.'],
  [/^unknown_number/, 'This number is not one of your customers. Add them and record consent first.'],
  [/^customer_has_no_phone/, 'The customer has no phone number.'],
  // Sarvam outbound request refused (codes from provider-clients: classify / request), most specific first.
  [/^sarvam_auth_failed/, 'Sarvam rejected the calling API key (SARVAM_AGENTS_API_KEY): check it in the Sarvam console → Settings → API keys.'],
  [/^sarvam_not_found/, 'Sarvam could not find the organisation, workspace or agent: check SARVAM_AGENTS_ORG_ID / WORKSPACE_ID and the agent id.'],
  [/^sarvam_rejected.*(version|app)/i, 'Sarvam refused the agent: the Sarvam agent id or "App version" is wrong, or that version is not committed.'],
  [/^sarvam_rejected/, 'Sarvam refused the request: check the agent id and version, the connection id and the calling number (it must be on that connection).'],
  [/^sarvam_rate_limited/, 'Sarvam’s calling limit was reached (concurrent calls or calls per minute). Try again in a minute.'],
  [/^sarvam_provider_error/, 'Sarvam had an error on its side. Try again in a few minutes.'],
  [/^sarvam_(timeout|network)/, 'Sarvam could not be reached from the server. Try again; if it keeps failing, check the server’s internet access.'],
  [/^sarvam_invalid_response/, 'Sarvam answered without a call id. The call may not have been placed.'],
  [/^sarvam_/, 'The voice provider refused the call or could not be reached.'],
  [/^(no_answer)$/, 'The customer did not answer.'],
  [/^(busy)$/, "The customer's line was busy."],
];

export function explainCallReason(code: string | null | undefined): string {
  const c = (code ?? '').trim();
  if (!c) return 'No reason was given.';
  const text = RULES.find(([r]) => r.test(c))?.[1] ?? 'The call could not be completed. See the technical details.';
  // Provider refusals: also show what Sarvam itself said (secrets are already removed by the API).
  const said = /^sarvam_/.test(c) ? c.match(/Provider said: (.+)$/)?.[1]?.trim() : undefined;
  return said ? `${text} Sarvam said: ${said.slice(0, 160)}` : text;
}
