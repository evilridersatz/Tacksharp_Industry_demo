import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import '@fontsource-variable/inter';
import './globals.css';
import { AppShell } from '@/components/shell';

export const metadata: Metadata = {
  title: 'Tacksharp.ai',
  description: 'AI lead follow-up: WhatsApp, voice calls and CRM',
  // The build that is being served (NEXT_PUBLIC_RELEASE_ID=<git short sha> at build time): proves what is live.
  other: { 'tacksharp-release': process.env.NEXT_PUBLIC_RELEASE_ID ?? 'unset' },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="font-sans">
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
