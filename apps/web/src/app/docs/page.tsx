'use client';

import Link from 'next/link';
import { SitePage, SiteHero } from '@/components/site';

const STEPS: Array<{ t: string; d: React.ReactNode }> = [
  { t: 'Create your organization', d: <>Sign up at <Link href="/signup" className="font-semibold underline">Create an account</Link> with your organization name, your name, business email, a password of at least 12 characters and your industry. You become the organization admin. The dashboard opens immediately.</> },
  { t: 'Wait for activation', d: 'Tacksharp reviews new organizations (this replaces email verification, which is not set up yet). Until then you can configure everything; test calls and messages to customers stay off.' },
  { t: 'Connect WhatsApp', d: <>In <b>Settings → Integrations → WhatsApp</b>, enter your system-user access token, phone number ID and WhatsApp Business Account ID. Press <b>Test connection</b>: Tacksharp asks Meta for the number and your templates. Enable the integration, then <b>Route this number here</b> so incoming messages reach your organization. Set the callback URL shown on that page in your Meta app.</> },
  { t: 'Connect calls (optional)', d: <>In <b>Settings → Integrations → Plivo</b>, enter your Auth ID, Auth Token and a caller ID that belongs to your Plivo account. Test, enable, then route your inbound numbers: each is verified against your Plivo account first. A test call can be placed only to an approved test number once the server is out of dry-run mode.</> },
  { t: 'Connect AI providers (optional)', d: <>In <b>Settings → AI providers</b>, add your Sarvam key (choose the speech models, language and voice, then generate and recognise a test sample) and your OpenAI key (choose a supported model; the test checks the model is available to your key and reports token usage).</> },
  { t: 'Invite your team', d: <>In <b>Setup → Team & access</b>, create an invitation link with a role: admin, manager, operator, a department role or read-only viewer. Send the link privately; it works once and expires. Removing someone ends their sessions at once.</> },
  { t: 'Add your data and go live', d: 'Add or import customers with their consent, set your products, menu or properties, and review automation in Settings. Turn on live sending only after testing with your own numbers.' },
];

const ENDPOINTS: Array<[string, string, string]> = [
  ['POST', '/auth/signup', 'Create an organization and its first admin (public, rate-limited).'],
  ['POST', '/auth/login · /auth/logout', 'Start or end a session (cookie; 7-day expiry).'],
  ['POST', '/auth/forgot-password', 'Record a password-reset request (no email is sent).'],
  ['GET', '/integrations', 'Status of every provider for your organization (masked).'],
  ['GET · PUT · DELETE', '/integrations/:provider', 'Read status, save configuration (secrets encrypted), delete it.'],
  ['POST', '/integrations/:provider/test/:op', 'Run a real provider test: connection, tts, stt or call.'],
  ['POST', '/integrations/:provider/enable', 'Enable or disable; enabling needs a passed test.'],
  ['POST · DELETE', '/integrations/plivo/numbers', 'Route a verified Plivo number to your organization, or remove it.'],
  ['POST', '/integrations/whatsapp/route', 'Route your verified WhatsApp number to your organization.'],
  ['GET', '/team · POST /team/invitations', 'People with access, invitation links.'],
];

export default function DocsPage() {
  return (
    <SitePage>
      <SiteHero title="Getting started" lead="From a new account to your first real customer conversation. Each step happens in your dashboard; nothing needs a developer." />
      <div className="mx-auto grid max-w-[1200px] gap-12 px-4 py-14 sm:px-6 lg:grid-cols-[1.3fr_1fr]">
        <ol className="grid gap-8">
          {STEPS.map((s, i) => (
            <li key={s.t} className="grid grid-cols-[2.25rem_1fr] gap-4">
              <span className="grid size-9 place-items-center rounded-full bg-[#16183d] text-[14px] font-bold text-white" aria-hidden>{i + 1}</span>
              <div><h2 className="text-[19px] font-bold tracking-[-0.01em]">{s.t}</h2><p className="mt-1.5 text-[15px] leading-relaxed text-[#16183d]/75">{s.d}</p></div>
            </li>
          ))}
        </ol>
        <aside className="lg:sticky lg:top-24 lg:self-start">
          <h2 className="text-[17px] font-bold">API reference (summary)</h2>
          <p className="mt-1 text-[13.5px] text-[#16183d]/60">Every endpoint needs a session unless marked public. The organization always comes from the session, never from the request body.</p>
          <dl className="mt-4 grid gap-3">
            {ENDPOINTS.map(([m, path, d]) => (
              <div key={path} className="rounded-[12px] border border-[#16183d]/10 bg-white p-3">
                <dt className="flex flex-wrap items-baseline gap-2"><span className="rounded-[6px] bg-[#ebeaf6] px-1.5 py-0.5 text-[11.5px] font-bold">{m}</span><code className="text-[13px] font-semibold break-all">{path}</code></dt>
                <dd className="mt-1 text-[13.5px] text-[#16183d]/70">{d}</dd>
              </div>
            ))}
          </dl>
        </aside>
      </div>
    </SitePage>
  );
}
