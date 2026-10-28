'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { AlertCircle, Eye, EyeOff, Lock, Mail, ShieldCheck } from 'lucide-react';
import { api } from '@/lib/api';
import { INDUSTRIES, INDUSTRY_IDS } from '@/lib/industries';
import { forgetWorkspace } from '@/lib/industry';
import { forgetMe } from '@/lib/restaurant';
import { Button, cx } from '@/components/ui';

export default function LoginPage() {
  return (
    <Suspense>
      <Login />
    </Suspense>
  );
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Decorative: the six industries as AI agents around one platform (purely visual; no data). */
function AgentNetwork() {
  const n = INDUSTRY_IDS.length;
  return (
    <div className="relative mx-auto aspect-square w-full max-w-[380px]" aria-hidden>
      <div className="absolute inset-[14%] rounded-full border border-white/15" />
      <div className="absolute inset-[30%] rounded-full border border-white/10" />
      <svg viewBox="0 0 100 100" className="absolute inset-0 size-full">
        {INDUSTRY_IDS.map((id, i) => {
          const a = (i / n) * Math.PI * 2 - Math.PI / 2;
          return <line key={id} x1="50" y1="50" x2={50 + Math.cos(a) * 36} y2={50 + Math.sin(a) * 36} stroke="white" strokeOpacity="0.18" strokeDasharray="1.5 1.5" strokeWidth="0.4" />;
        })}
      </svg>
      <div className="absolute top-1/2 left-1/2 grid size-[26%] -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-white/10 shadow-[0_0_60px_rgba(255,255,255,0.18)] ring-1 ring-white/25 backdrop-blur">
        <span className="grid size-[62%] place-items-center rounded-full bg-[conic-gradient(from_200deg,#7c5cf0,#e11d48,#f59e0b,#0f9f6e,#7c5cf0)]">
          <span className="size-[42%] rounded-full border-[3px] border-white bg-[#0b1220]" />
        </span>
      </div>
      {INDUSTRY_IDS.map((id, i) => {
        const d = INDUSTRIES[id];
        const a = (i / n) * Math.PI * 2 - Math.PI / 2;
        const Icon = d.icon;
        return (
          <div key={id} className="absolute flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-1.5" style={{ left: `${50 + Math.cos(a) * 36}%`, top: `${50 + Math.sin(a) * 36}%` }}>
            <span className="grid size-12 place-items-center rounded-[14px] bg-white shadow-lg" style={{ color: d.accent }}>
              <Icon className="size-6" />
            </span>
            <span className="rounded-full bg-black/25 px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap text-white/90">{d.short}</span>
          </div>
        );
      })}
    </div>
  );
}

function Login() {
  const router = useRouter();
  const params = useSearchParams();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [show, setShow] = useState(false);
  const [caps, setCaps] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [touched, setTouched] = useState({ email: false, password: false });
  const [forgot, setForgot] = useState(false);
  const emailErr = touched.email && !EMAIL_RE.test(email.trim()) ? 'Enter a valid email address.' : null;
  const passErr = touched.password && !password ? 'Enter your password.' : null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setTouched({ email: true, password: true });
    if (!EMAIL_RE.test(email.trim()) || !password) return;
    setBusy(true);
    setError(null);
    try {
      await api.post('/auth/login', { email: email.trim(), password });
      forgetMe();
      forgetWorkspace();
      const next = params.get('next');
      router.replace(next && next.startsWith('/') && !next.startsWith('//') ? next : '/');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  const field = (bad: boolean) =>
    cx('h-11 w-full rounded-[12px] border bg-white pr-3 pl-10 text-[14px] text-ink placeholder:text-faint outline-none transition focus:ring-4', bad ? 'border-rose focus:ring-rose/15' : 'border-line focus:border-brand focus:ring-brand/15');

  return (
    <div className="grid min-h-dvh bg-canvas lg:grid-cols-[1.05fr_1fr]">
      {/* Brand panel: full on desktop, a compact banner on phones and tablets. */}
      <div className="relative overflow-hidden bg-[radial-gradient(120%_120%_at_0%_0%,#0d5c4a_0%,#16525e_40%,#2d3a8c_75%,#3b2f7a_100%)] px-5 pt-6 pb-8 text-white sm:px-10 lg:flex lg:flex-col lg:justify-between lg:p-12">
        <div className="pointer-events-none absolute -top-24 -right-24 size-72 rounded-full bg-white/10 blur-3xl" aria-hidden />
        <div className="pointer-events-none absolute -bottom-32 -left-16 size-80 rounded-full bg-[#7c5cf0]/30 blur-3xl" aria-hidden />
        <div className="relative flex items-center gap-2.5">
          <span className="grid size-9 place-items-center rounded-full bg-[conic-gradient(from_200deg,#7c5cf0,#e11d48,#f59e0b,#7c5cf0)]">
            <span className="size-3.5 rounded-full border-[3px] border-white bg-[#0b1220]" />
          </span>
          <p className="text-[18px] font-bold">Tacksharp.ai</p>
        </div>
        <div className="relative mt-6 lg:mt-0">
          <h1 className="max-w-lg text-[24px] leading-tight font-bold sm:text-[30px] lg:text-[36px]">AI employees for every kind of business.</h1>
          <p className="mt-2 max-w-md text-[14px] text-white/75 lg:text-[15px]">Conversations, follow-ups, campaigns and operations agents, tuned to your industry, with a person always in control.</p>
          <ul className="mt-4 flex flex-wrap gap-1.5 lg:hidden" aria-label="Industries">
            {INDUSTRY_IDS.map((id) => {
              const d = INDUSTRIES[id];
              const Icon = d.icon;
              return (
                <li key={id} className="inline-flex items-center gap-1.5 rounded-full bg-white/12 px-2.5 py-1 text-[12px] font-medium ring-1 ring-white/15">
                  <Icon className="size-3.5" aria-hidden /> {d.short}
                </li>
              );
            })}
          </ul>
        </div>
        <div className="relative my-8 hidden lg:block">
          <AgentNetwork />
        </div>
        <p className="relative hidden items-center gap-2 text-[12px] text-white/65 lg:flex">
          <ShieldCheck className="size-4" aria-hidden /> Each workspace sees only its own data.
        </p>
      </div>

      <div className="flex items-start justify-center px-5 py-8 sm:px-8 lg:items-center lg:py-12">
        <form onSubmit={submit} noValidate className="w-full max-w-[400px] rounded-[20px] border border-line bg-white p-6 shadow-[0_20px_60px_-30px_rgba(15,23,42,0.35)] sm:p-8">
          <span className="grid size-11 place-items-center rounded-[14px] bg-brand-soft text-brand">
            <Lock className="size-5" aria-hidden />
          </span>
          <h2 className="mt-4 text-[22px] font-bold text-ink">Log in</h2>
          <p className="mt-1 text-[13px] text-muted">Use the email and password your admin gave you.</p>

          <label htmlFor="email" className="mt-6 block text-[13px] font-semibold text-body">Email</label>
          <div className="relative mt-1">
            <Mail className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-faint" aria-hidden />
            <input
              id="email" name="email" type="email" required autoComplete="email" inputMode="email" value={email}
              onChange={(e) => setEmail(e.target.value)} onBlur={() => setTouched((t) => ({ ...t, email: true }))}
              aria-invalid={Boolean(emailErr)} aria-describedby={emailErr ? 'email-err' : undefined} placeholder="you@company.com" className={field(Boolean(emailErr))}
            />
          </div>
          {emailErr && <p id="email-err" className="mt-1 text-[12px] text-rose">{emailErr}</p>}

          <div className="mt-4 flex items-baseline justify-between">
            <label htmlFor="password" className="block text-[13px] font-semibold text-body">Password</label>
            <button type="button" onClick={() => setForgot((f) => !f)} aria-expanded={forgot} className="text-[12.5px] font-semibold text-brand hover:text-brand-dark">
              Forgot password?
            </button>
          </div>
          <div className="relative mt-1">
            <Lock className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-faint" aria-hidden />
            <input
              id="password" name="password" type={show ? 'text' : 'password'} required autoComplete="current-password" value={password}
              onChange={(e) => setPassword(e.target.value)} onBlur={() => setTouched((t) => ({ ...t, password: true }))}
              onKeyUp={(e) => setCaps(e.getModifierState?.('CapsLock') ?? false)}
              aria-invalid={Boolean(passErr)} aria-describedby={passErr ? 'pass-err' : undefined} className={cx(field(Boolean(passErr)), 'pr-12')}
            />
            <button
              type="button" onClick={() => setShow((s) => !s)} aria-pressed={show}
              className="absolute top-1/2 right-1 grid size-10 -translate-y-1/2 place-items-center rounded-[10px] text-muted hover:text-ink"
            >
              <span className="sr-only">{show ? 'Hide password' : 'Show password'}</span>
              {show ? <EyeOff className="size-4" aria-hidden /> : <Eye className="size-4" aria-hidden />}
            </button>
          </div>
          {passErr && <p id="pass-err" className="mt-1 text-[12px] text-rose">{passErr}</p>}
          {caps && <p className="mt-1 text-[12px] text-[#b45309]">Caps Lock is on.</p>}
          {forgot && (
            <p role="note" className="mt-2 rounded-[10px] bg-slate-50 px-3 py-2 text-[12.5px] text-body">
              Ask your workspace admin for a password-reset link (Team & access). The link works once and expires within a few hours.
            </p>
          )}

          {error && (
            <p role="alert" className="mt-4 flex items-start gap-2 rounded-[10px] bg-rose-soft px-3 py-2 text-[13px] text-rose">
              <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden /> {error}
            </p>
          )}
          <Button type="submit" variant="primary" busy={busy} className="mt-6 h-11 w-full text-[14px]">
            Log in
          </Button>
          <p className="mt-5 flex items-center justify-center gap-1.5 text-center text-[11.5px] text-faint">
            <ShieldCheck className="size-3.5" aria-hidden /> Secure session · your data stays in your workspace
          </p>
        </form>
      </div>
    </div>
  );
}
