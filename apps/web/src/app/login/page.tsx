'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { Lock } from 'lucide-react';
import { api } from '@/lib/api';
import { Button } from '@/components/ui';

export default function LoginPage() {
  return (
    <Suspense>
      <Login />
    </Suspense>
  );
}

function Login() {
  const router = useRouter();
  const params = useSearchParams();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(form: FormData) {
    setBusy(true);
    setError(null);
    try {
      await api.post('/auth/login', { email: form.get('email'), password: form.get('password') });
      const next = params.get('next');
      router.replace(next && next.startsWith('/') && !next.startsWith('//') ? next : '/');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const input = 'mt-1 h-10 w-full rounded-[10px] border border-line px-3 text-[14px] text-ink placeholder:text-faint';
  return (
    <div className="grid min-h-screen lg:grid-cols-2">
      <div className="hidden flex-col justify-between bg-gradient-to-br from-[#0d5c4a] via-[#16525e] to-[#3b3f8f] p-10 text-white lg:flex">
        <p className="text-[18px] font-bold">Tacksharp.ai</p>
        <div>
          <h1 className="max-w-md text-[34px] leading-tight font-bold">Every new lead is contacted. Every call is answered.</h1>
          <p className="mt-3 max-w-md text-[15px] text-white/75">WhatsApp, AI calls in Tamil, Tanglish and English, and your CRM in one place.</p>
        </div>
        <p className="text-[12px] text-white/60">AI employees platform</p>
      </div>
      <div className="flex items-center justify-center p-6">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit(new FormData(e.currentTarget));
          }}
          className="w-full max-w-sm"
        >
          <span className="grid size-10 place-items-center rounded-full bg-brand-soft text-brand">
            <Lock className="size-5" />
          </span>
          <h2 className="mt-4 text-[22px] font-bold text-ink">Log in</h2>
          <p className="mt-1 text-[13px] text-muted">Use the email and password your admin gave you.</p>
          <label className="mt-5 block text-[13px] font-semibold text-body">
            Email
            <input name="email" type="email" required autoComplete="email" className={input} />
          </label>
          <label className="mt-3 block text-[13px] font-semibold text-body">
            Password
            <input name="password" type="password" required autoComplete="current-password" className={input} />
          </label>
          {error && <p role="alert" className="mt-3 rounded-[10px] bg-rose-soft px-3 py-2 text-[13px] text-rose">{error}</p>}
          <Button type="submit" variant="primary" busy={busy} className="mt-5 h-10 w-full">
            Log in
          </Button>
        </form>
      </div>
    </div>
  );
}
