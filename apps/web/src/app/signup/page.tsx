'use client';

import Link from 'next/link';
import { useState } from 'react';
import { AlertCircle, Eye, EyeOff } from 'lucide-react';
import { ApiError, api, useApi } from '@/lib/api';
import { forgetWorkspace } from '@/lib/industry';
import { forgetMe } from '@/lib/restaurant';
import { SitePage } from '@/components/site';
import { cx } from '@/components/ui';

const INDUSTRIES: Array<[string, string]> = [
  ['real_estate', 'Real estate'],
  ['food', 'Restaurant and food ordering'],
  ['retail', 'Retail and e-commerce'],
  ['textile', 'Textile and apparel'],
  ['manufacturing', 'Manufacturing and quality'],
  ['hospital', 'Hospital and healthcare'],
  ['hotel', 'Hotel and room booking'],
  ['cctv', 'Vision AI and CCTV monitoring'],
  ['agency', 'Marketing agency or other business'],
];

type Form = { organizationName: string; adminName: string; email: string; password: string; industry: string; phone: string; acceptTerms: boolean; website: string };
const EMPTY: Form = { organizationName: '', adminName: '', email: '', password: '', industry: '', phone: '', acceptTerms: false, website: '' };

/** Mirrors the server's rules so mistakes show before submitting; the server re-checks everything. */
function check(f: Form): Partial<Record<keyof Form, string>> {
  const e: Partial<Record<keyof Form, string>> = {};
  if (f.organizationName.trim().length < 2) e.organizationName = 'Enter your organization name.';
  if (f.adminName.trim().length < 2) e.adminName = 'Enter your name.';
  if (!/^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/.test(f.email.trim())) e.email = 'Enter a valid business email address.';
  if (f.password.length < 12) e.password = 'Use at least 12 characters.';
  else if (f.password.trim().toLowerCase() === f.email.trim().toLowerCase()) e.password = 'The password must not be your email address.';
  if (!f.industry) e.industry = 'Choose your industry.';
  if (f.phone.trim() && !/^\d{8,15}$/.test(f.phone.replace(/[\s()+-]/g, ''))) e.phone = 'Digits with country code, 8 to 15 long.';
  if (!f.acceptTerms) e.acceptTerms = 'Accept the terms and privacy policy to continue.';
  return e;
}

/** Module-level (not recreated on each render, so inputs keep focus while typing). */
function Field({ k, label, children, hint, error }: { k: keyof Form; label: string; children: React.ReactNode; hint?: string; error?: string }) {
  return (
    <div className="grid gap-1">
      <label htmlFor={k} className="text-[13.5px] font-semibold">{label}</label>
      {children}
      <span id={`${k}-msg`} className={cx('text-[12.5px]', error ? 'text-rose-700' : 'text-[#16183d]/55')}>{error ?? hint ?? ''}</span>
    </div>
  );
}

export default function SignupPage() {
  const { data: status } = useApi<{ enabled: boolean }>('/auth/signup-status', 0);
  const [f, setF] = useState<Form>(EMPTY);
  const [touched, setTouched] = useState<Partial<Record<keyof Form, boolean>>>({});
  const [server, setServer] = useState<Partial<Record<keyof Form, string>>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [show, setShow] = useState(false);
  const local = check(f);
  const err = (k: keyof Form) => server[k] ?? (touched[k] ? local[k] : undefined);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => { setF({ ...f, [k]: v }); setServer({ ...server, [k]: undefined }); };

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setTouched(Object.fromEntries(Object.keys(EMPTY).map((k) => [k, true])));
    if (Object.keys(local).length) return;
    setBusy(true);
    setError(null);
    try {
      await api.post('/auth/signup', { ...f, phone: f.phone.trim() || undefined });
      forgetMe();
      forgetWorkspace();
      window.location.href = '/?welcome=1';
    } catch (x) {
      const fields = x instanceof ApiError ? ((x.body as { fields?: Record<string, string> } | null)?.fields ?? {}) : {};
      setServer(fields as Partial<Record<keyof Form, string>>);
      setError(x instanceof Error ? x.message : String(x));
      setBusy(false);
    }
  }

  const input = (bad: boolean) => cx('h-11 w-full rounded-[12px] border bg-white px-3.5 text-[14.5px] outline-none transition focus:ring-4', bad ? 'border-rose-500 focus:ring-rose-500/15' : 'border-[#16183d]/15 focus:border-[#16183d] focus:ring-[#16183d]/10');
  const a11y = (k: keyof Form) => ({ id: k, 'aria-invalid': Boolean(err(k)), 'aria-describedby': `${k}-msg`, onBlur: () => setTouched({ ...touched, [k]: true }) });

  return (
    <SitePage>
      <div className="mx-auto grid max-w-[1100px] gap-10 px-4 py-12 sm:px-6 lg:grid-cols-[1fr_1.1fr] lg:py-16">
        <div>
          <h1 className="text-[34px] leading-[1.05] font-extrabold tracking-[-0.035em] sm:text-[46px]">Create your organization</h1>
          <p className="mt-4 text-[16px] leading-relaxed text-[#16183d]/70">You become its administrator. Your data, team and provider accounts stay inside your organization.</p>
          <h2 className="mt-8 text-[16px] font-bold">What happens next</h2>
          <ol className="mt-3 grid gap-3 text-[14.5px] text-[#16183d]/75">
            {[
              'Your dashboard opens straight away, shaped for the industry you choose.',
              'Tacksharp reviews the registration and activates it. Email verification is not set up yet, so this review is the verification step.',
              'Connect your WhatsApp number and, if you want calls and AI replies, Plivo, Sarvam and OpenAI. Each connection is tested before it is used.',
              'Invite your team with read-only, operator, manager or admin access.',
            ].map((t, i) => (
              <li key={t} className="flex gap-3"><span className="grid size-6 shrink-0 place-items-center rounded-full bg-[#ebeaf6] text-[12px] font-bold" aria-hidden>{i + 1}</span>{t}</li>
            ))}
          </ol>
        </div>

        {status && !status.enabled ? (
          <div role="status" className="rounded-[20px] border border-[#16183d]/10 bg-white p-8">
            <h2 className="text-[20px] font-bold">Registration is closed right now</h2>
            <p className="mt-2 text-[14.5px] text-[#16183d]/70">New organizations are being opened by Tacksharp directly. If you already have an account, <Link href="/login" className="font-semibold underline">log in</Link>.</p>
          </div>
        ) : (
          <form onSubmit={submit} noValidate className="grid gap-4 rounded-[20px] border border-[#16183d]/10 bg-white p-6 shadow-[0_24px_60px_-36px_rgba(22,24,61,0.45)] sm:p-8">
            <Field error={err('organizationName')} k="organizationName" label="Organization name"><input {...a11y('organizationName')} className={input(Boolean(err('organizationName')))} autoComplete="organization" value={f.organizationName} onChange={(e) => set('organizationName', e.target.value)} /></Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field error={err('adminName')} k="adminName" label="Your name"><input {...a11y('adminName')} className={input(Boolean(err('adminName')))} autoComplete="name" value={f.adminName} onChange={(e) => set('adminName', e.target.value)} /></Field>
              <Field error={err('phone')} k="phone" label="Business phone (optional)" hint="With country code. Used to contact you, not for routing."><input {...a11y('phone')} className={input(Boolean(err('phone')))} autoComplete="tel" inputMode="tel" placeholder="91 98400 12345" value={f.phone} onChange={(e) => set('phone', e.target.value)} /></Field>
            </div>
            <Field error={err('email')} k="email" label="Business email" hint="This is your login."><input {...a11y('email')} type="email" className={input(Boolean(err('email')))} autoComplete="email" inputMode="email" value={f.email} onChange={(e) => set('email', e.target.value)} /></Field>
            <Field error={err('password')} k="password" label="Password" hint="At least 12 characters. A short sentence works well.">
              <span className="relative">
                <input {...a11y('password')} type={show ? 'text' : 'password'} className={cx(input(Boolean(err('password'))), 'pr-12')} autoComplete="new-password" value={f.password} onChange={(e) => set('password', e.target.value)} />
                <button type="button" onClick={() => setShow(!show)} aria-pressed={show} className="absolute top-0.5 right-0.5 grid size-10 place-items-center rounded-[10px] text-[#16183d]/55 hover:text-[#16183d]">
                  <span className="sr-only">{show ? 'Hide password' : 'Show password'}</span>{show ? <EyeOff className="size-4" aria-hidden /> : <Eye className="size-4" aria-hidden />}
                </button>
              </span>
            </Field>
            <Field error={err('industry')} k="industry" label="Industry" hint="Shapes your dashboard and assistant. An admin can change it later.">
              <select {...a11y('industry')} className={input(Boolean(err('industry')))} value={f.industry} onChange={(e) => set('industry', e.target.value)}>
                <option value="">Choose…</option>
                {INDUSTRIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </Field>
            {/* Honeypot: hidden from people and screen readers; automated form fillers complete it and are refused. */}
            <div aria-hidden className="absolute -left-[9999px] h-px w-px overflow-hidden">
              <label htmlFor="website">Website</label>
              <input id="website" tabIndex={-1} autoComplete="off" value={f.website} onChange={(e) => setF({ ...f, website: e.target.value })} />
            </div>
            <div className="grid gap-1">
              <label className="flex items-start gap-2.5 text-[13.5px]">
                <input type="checkbox" className="mt-0.5 size-4" checked={f.acceptTerms} onChange={(e) => set('acceptTerms', e.target.checked)} aria-describedby="acceptTerms-msg" aria-invalid={Boolean(err('acceptTerms'))} />
                <span>I agree to the <Link href="/terms" className="font-semibold underline">terms of service</Link> and the <Link href="/privacy" className="font-semibold underline">privacy policy</Link>.</span>
              </label>
              <span id="acceptTerms-msg" className="text-[12.5px] text-rose-700">{err('acceptTerms') ?? ''}</span>
            </div>
            {error && <p role="alert" className="flex items-start gap-2 rounded-[12px] bg-rose-50 px-3 py-2.5 text-[13.5px] text-rose-800"><AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />{error}</p>}
            <button type="submit" disabled={busy} className="inline-flex h-12 items-center justify-center rounded-[12px] bg-[#16183d] text-[15px] font-semibold text-white hover:bg-[#262a63] disabled:opacity-60">
              {busy ? 'Creating your organization…' : 'Create organization'}
            </button>
            <p className="text-center text-[13.5px] text-[#16183d]/65">Already have an account? <Link href="/login" className="font-semibold text-[#16183d] underline">Log in</Link></p>
          </form>
        )}
      </div>
    </SitePage>
  );
}
