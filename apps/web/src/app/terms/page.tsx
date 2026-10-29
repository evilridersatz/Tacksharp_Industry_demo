'use client';

import Link from 'next/link';
import { Prose, SitePage, SiteHero } from '@/components/site';

/** Terms of service. Describes how the service actually works; to be reviewed by Tacksharp's legal counsel. */
export default function TermsPage() {
  return (
    <SitePage>
      <SiteHero title="Terms of service" lead="The rules for using Tacksharp, written to match how the service actually works." />
      <Prose>
        <p><strong>Last updated:</strong> October 29, 2026. These terms are between you (the organization that registers) and Tacksharp AI Private Limited, Chennai, India.</p>
        <h2>1. Your account</h2>
        <p>The person who registers an organization becomes its administrator and is responsible for the people they invite. Keep passwords private. Tacksharp may review, activate or decline new organizations, and may suspend an organization that breaks these terms or the law.</p>
        <h2>2. Your data</h2>
        <p>You own the customer records, conversations and files in your organization. We process them only to provide the service, as described in the <Link href="/privacy">privacy policy</Link>. Each organization can see only its own data.</p>
        <h2>3. Messaging and calls</h2>
        <ul>
          <li>You may message or call only people who have agreed to hear from you, and you must honour opt-outs (the service stops contact after STOP or an opt-out).</li>
          <li>You are responsible for following WhatsApp Business, telecom and calling-hour rules that apply to you, including using approved templates outside the 24-hour window.</li>
          <li>Automated replies can be wrong. Prices, discounts and commitments come from your records and approval settings; review them before relying on them.</li>
        </ul>
        <h2>4. Your provider accounts</h2>
        <p>When you connect your own WhatsApp, Plivo, Sarvam or OpenAI account, that provider&apos;s terms apply and it bills you directly. You are responsible for those charges. We store your keys encrypted and use them only for your organization.</p>
        <h2>5. Acceptable use</h2>
        <p>Do not use the service for spam, harassment, deceptive or illegal content, or to collect data you are not allowed to collect. Do not try to access another organization&apos;s data or bypass security controls.</p>
        <h2>6. Availability and changes</h2>
        <p>We work to keep the service available but do not guarantee uninterrupted operation. Features may change; we will not remove access to your own data without notice.</p>
        <h2>7. Fees</h2>
        <p>Plan fees are agreed when your organization is activated. Provider usage is billed by the providers.</p>
        <h2>8. Ending the service</h2>
        <p>You may stop using the service at any time and ask us to export or delete your organization&apos;s data. We may end the service for breach of these terms.</p>
        <h2>9. Liability</h2>
        <p>To the extent the law allows, Tacksharp is not liable for indirect or consequential losses, and our total liability is limited to the fees you paid in the three months before the claim.</p>
        <h2>10. Law</h2>
        <p>These terms are governed by the laws of India, with courts in Chennai having jurisdiction.</p>
      </Prose>
    </SitePage>
  );
}
