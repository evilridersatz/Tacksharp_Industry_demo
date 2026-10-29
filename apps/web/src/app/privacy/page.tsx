'use client';

import { Prose, SitePage, SiteHero } from '@/components/site';

export default function PrivacyPolicyPage() {
  return (
    <SitePage>
      <SiteHero title="Privacy policy" lead="How Tacksharp collects, uses and protects information." />
      <Prose>
      <p><strong>Last updated:</strong> October 10, 2026</p>

      <h2>1. Introduction</h2>
      <p>
        Tacksharp respects your privacy. This Privacy Policy explains how Tacksharp
        collects, uses, and protects information when you interact with our
        services, including our WhatsApp and AI-powered communication services.
      </p>

      <h2>2. Information We Collect</h2>
      <p>
        We may collect information that you provide when communicating with us,
        such as your name, phone number, property requirements, messages,
        enquiries, and appointment details.
      </p>

      <h2>3. How We Use Information</h2>
      <p>
        We use this information to respond to enquiries, provide property
        information, arrange site visits, communicate with customers, and
        improve our services.
      </p>

      <h2>4. WhatsApp Communications</h2>
      <p>
        When you communicate with Tacksharp through WhatsApp, your messages and
        related information may be processed to provide automated and human
        customer support.
      </p>

      <h2>5. Information Sharing</h2>
      <p>
        We do not sell personal information. Information may be shared with
        service providers when necessary to operate our communication,
        messaging, hosting, and AI services.
      </p>

      <h2>6. Data Security</h2>
      <p>
        We take reasonable measures to protect information from unauthorized
        access, alteration, disclosure, or destruction.
      </p>

      <h2>7. Data Retention</h2>
      <p>
        Information is retained only for as long as reasonably necessary to
        provide our services, meet business requirements, or comply with
        applicable legal obligations.
      </p>

      <h2>8. Your Rights</h2>
      <p>
        You may contact us to request access to, correction of, or deletion of
        your personal information, subject to applicable requirements.
      </p>

      <h2>9. Contact</h2>
      <p>
        For privacy-related questions or requests, please contact Tacksharp.
      </p>
      </Prose>
    </SitePage>
  );
}
