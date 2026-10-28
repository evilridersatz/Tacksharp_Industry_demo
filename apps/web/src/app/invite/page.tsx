'use client';

import { useEffect, useState } from 'react';
import { AlertCircle, Eye, EyeOff, KeyRound, ShieldCheck } from 'lucide-react';
import { api } from '@/lib/api';
import { forgetWorkspace } from '@/lib/industry';
import { Button, cx } from '@/components/ui';

type Info = { kind: 'invite' | 'reset'; email: string; role: string; workspace: string; isDemo: boolean; expiresAt: string; existingAccount: boolean };
const field = 'h-11 w-full rounded-[10px] border border-line bg-white px-3 text-[14px] text-ink outline-none focus:border-brand focus:ring-2 focus:ring-brand/20';

/**
 * Invitation / password-reset link: /invite#<token>. The token stays in the URL fragment (never sent to a server or
 * written to access logs) and is posted to the API in the request body.
 */
export default function InvitePage() {
  const [token, setToken] = useState('');
  const [info, setInfo] = useState<Info | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [current, setCurrent] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [fieldError, setFieldError] = useState<string | null>(null);

  useEffect(() => {
    const t = window.location.hash.replace(/^#/, '');
    // Remove the token from the address bar and history once read.
    if (t) history.replaceState(null, '', window.location.pathname);
    setToken(t);
    if (!t) { setError('This link is incomplete. Open the full link you were sent, or ask your workspace admin for a new one.'); return; }
    api.post<Info>('/team/links/inspect', { token: t }).then(setInfo).catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  const needsNew = info ? info.kind === 'reset' || !info.existingAccount : false;
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setFieldError(null);
    if (needsNew) {
      if (password.length < 12) { setFieldError('Choose a password of at least 12 characters.'); return; }
      if (password !== confirm) { setFieldError('The two passwords are different.'); return; }
    } else if (!current) { setFieldError('Enter the password of your existing account.'); return; }
    setBusy(true);
    try {
      await api.post('/team/links/accept', needsNew ? { token, name, password } : { token, currentPassword: current });
      forgetWorkspace();
      window.location.href = '/';
    } catch (err) {
      setFieldError(err instanceof Error ? err.message : String(err));
    } finally { setBusy(false); }
  }

  return (
    <main className="grid min-h-screen place-items-center bg-[#F5F7FC] px-4 py-10">
      <div className="w-full max-w-[440px] rounded-[18px] border border-line bg-white p-6 shadow-sm sm:p-8">
        <p className="flex items-center gap-2 text-[12px] font-semibold tracking-wide text-muted uppercase"><ShieldCheck className="size-4 text-emerald-600" aria-hidden /> Tacksharp.ai secure access</p>
        {error ? (
          <div role="alert" className="mt-4 flex gap-2 rounded-[10px] bg-rose-50 px-3 py-3 text-[13px] text-rose-800"><AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden /><span>{error}</span></div>
        ) : !info ? (
          <p className="mt-4 text-[13px] text-muted">Checking your link…</p>
        ) : (
          <>
            <h1 className="mt-3 text-[22px] font-bold text-ink">{info.kind === 'reset' ? 'Set a new password' : `Join ${info.workspace}`}</h1>
            <p className="mt-1 text-[13.5px] text-body">
              {info.kind === 'reset' ? <>For <b>{info.email}</b>. Your other sessions will be signed out.</> : <><b>{info.email}</b> is invited as <b>{info.role.replace('_', ' ')}</b>{info.role === 'viewer' ? ' (read-only)' : ''}{info.isDemo ? ' to a demo workspace with sample data' : ''}.</>}
            </p>
            <form onSubmit={submit} noValidate className="mt-5 grid gap-3">
              {needsNew ? (
                <>
                  {info.kind === 'invite' && <label className="grid gap-1 text-[13px] font-semibold text-ink">Your name<input className={field} value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" /></label>}
                  <label className="grid gap-1 text-[13px] font-semibold text-ink">New password
                    <span className="relative"><input className={cx(field, 'pr-11')} type={show ? 'text' : 'password'} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" aria-describedby="pw-help" />
                      <button type="button" className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-1.5 text-muted" onClick={() => setShow(!show)} aria-label={show ? 'Hide password' : 'Show password'}>{show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}</button></span>
                    <span id="pw-help" className="text-[12px] font-normal text-muted">At least 12 characters. A short sentence works well.</span>
                  </label>
                  <label className="grid gap-1 text-[13px] font-semibold text-ink">Repeat the password<input className={field} type={show ? 'text' : 'password'} value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" /></label>
                </>
              ) : (
                <label className="grid gap-1 text-[13px] font-semibold text-ink">Password of your existing account
                  <input className={field} type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" />
                  <span className="text-[12px] font-normal text-muted">You already have a Tacksharp account. Confirm it is yours to add this workspace.</span>
                </label>
              )}
              {fieldError && <p role="alert" className="rounded-[10px] bg-rose-50 px-3 py-2 text-[12.5px] text-rose-800">{fieldError}</p>}
              <Button type="submit" variant="primary" busy={busy}><KeyRound className="size-4" /> {info.kind === 'reset' ? 'Save password and sign in' : 'Accept and sign in'}</Button>
              <p className="text-[12px] text-muted">This link works once and expires {new Date(info.expiresAt).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}.</p>
            </form>
          </>
        )}
      </div>
    </main>
  );
}
