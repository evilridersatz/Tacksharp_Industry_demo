'use client';

import Link from 'next/link';
import { useState } from 'react';
import { api } from '@/lib/api';
import { SitePage } from '@/components/site';

/**
 * Password help without an email provider: the request is recorded for the people who can issue a one-time reset
 * link (workspace admins, Tacksharp). The answer is the same whether or not the email has an account.
 */
export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) { setError('Enter the email you log in with.'); return; }
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ message: string }>('/auth/forgot-password', { email: email.trim() });
      setDone(r.message);
    } catch (x) {
      setError(x instanceof Error ? x.message : String(x));
    } finally {
      setBusy(false);
    }
  }
  return (
    <SitePage>
      <div className="mx-auto max-w-[520px] px-4 py-16 sm:px-6">
        <h1 className="text-[32px] leading-tight font-extrabold tracking-[-0.03em]">Password help</h1>
        <p className="mt-3 text-[15.5px] leading-relaxed text-[#16183d]/70">Tacksharp does not send email yet, so there is no automatic reset message. The quickest way back in is a one-time reset link from your workspace admin (Team & access → Reset link).</p>
        {done ? (
          <p role="status" className="mt-8 rounded-[14px] bg-emerald-50 p-4 text-[14.5px] text-emerald-900">{done}</p>
        ) : (
          <form onSubmit={submit} noValidate className="mt-8 grid gap-3 rounded-[18px] border border-[#16183d]/10 bg-white p-6">
            <label htmlFor="fp-email" className="text-[13.5px] font-semibold">If you are the admin, record a reset request for Tacksharp</label>
            <input id="fp-email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} aria-invalid={Boolean(error)} aria-describedby="fp-msg" className="h-11 rounded-[12px] border border-[#16183d]/15 px-3.5 text-[14.5px] outline-none focus:border-[#16183d] focus:ring-4 focus:ring-[#16183d]/10" />
            <span id="fp-msg" role={error ? 'alert' : undefined} className="text-[12.5px] text-rose-700">{error ?? ''}</span>
            <button disabled={busy} className="h-11 rounded-[12px] bg-[#16183d] text-[14.5px] font-semibold text-white hover:bg-[#262a63] disabled:opacity-60">{busy ? 'Recording…' : 'Record reset request'}</button>
          </form>
        )}
        <p className="mt-6 text-[14px]"><Link href="/login" className="font-semibold underline">Back to log in</Link></p>
      </div>
    </SitePage>
  );
}
