'use client';

import { useState } from 'react';
import { Copy, KeyRound, Link2, Mail, ShieldCheck, UserMinus, UserPlus } from 'lucide-react';
import { ApiError, api, useApi } from '@/lib/api';
import { useWorkspace } from '@/lib/industry';
import { PageHeader } from '@/components/shell';
import { Button, Card, ErrorBanner, Skeleton, cx } from '@/components/ui';
import { Pill } from '@/components/vertical-ui';
import { Dialog, Label, inputCls } from '@/components/textile';

type Member = { userId: string; email: string; name: string | null; role: string; access: 'home' | 'member'; lastLoginAt: string | null; disabled: boolean; since: string };
type Invitation = { id: string; kind: 'invite' | 'reset'; email: string; role: string; expiresAt: string; createdAt: string };
type Team = { members: Member[]; invitations: Invitation[]; roles: string[]; emailDelivery: 'not_configured' };
type Link = { id: string; kind: 'invite' | 'reset'; email: string; role: string; expiresAt: string; path: string };

const ROLE_HELP: Record<string, string> = {
  admin: 'Everything in this workspace, including people and settings',
  manager: 'Runs operations, sales, marketing and contact tests',
  sales: 'Customers, leads and sales',
  operations: 'Stock, dispatch, orders and tasks',
  front_desk: 'Hotel reservations and guests',
  reception: 'Hospital appointments and patients',
  insurance: 'Insurance cases',
  technician: 'VisionOps devices and incidents',
  finance: 'Invoices, payments and collections',
  marketing: 'Campaigns and content (sending needs approval)',
  operator: 'Day-to-day work: customers, orders, bookings, stock, incidents. No people, settings or integrations',
  viewer: 'Read-only: can look around, cannot change anything',
};
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'never');

export default function TeamPage() {
  const { workspace } = useWorkspace();
  const { data, error, reload } = useApi<Team>('/team', 0);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('viewer');
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [link, setLink] = useState<Link | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<Member | null>(null);
  const forbidden = error && /permission/.test(error);

  async function run<T>(key: string, fn: () => Promise<T>, ok?: (r: T) => void) {
    setBusy(key); setMsg(null);
    try { const r = await fn(); ok?.(r); await reload(); } catch (e) { setMsg({ tone: 'error', text: e instanceof ApiError || e instanceof Error ? e.message : String(e) }); } finally { setBusy(null); }
  }
  const invite = (e: React.FormEvent) => {
    e.preventDefault();
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) { setMsg({ tone: 'error', text: 'Enter a valid email address.' }); return; }
    void run('invite', () => api.post<Link>('/team/invitations', { email: email.trim(), role }), (r) => { setLink(r); setEmail(''); });
  };

  return (
    <>
      <PageHeader title="Team & access" crumb="Setup" />
      {forbidden ? (
        <Card className="p-6 text-[13.5px] text-body"><p className="font-semibold text-ink">Only workspace admins manage access.</p><p className="mt-1">Ask an admin of {workspace?.name ?? 'this workspace'} to invite people or change roles.</p></Card>
      ) : error && !data ? <ErrorBanner message={error} onRetry={reload} /> : !data ? <Skeleton className="h-96" /> : (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
          <Card className="overflow-hidden">
            <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-3">
              <h2 className="text-[14px] font-semibold text-ink">People with access to {workspace?.name ?? 'this workspace'}</h2>
              <span className="text-[12px] text-muted">{data.members.length} people</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead className="bg-slate-50 text-left text-[11.5px] font-semibold tracking-wide text-muted uppercase">
                  <tr><th className="px-4 py-2">Person</th><th className="px-4 py-2">Role</th><th className="px-4 py-2">Last login</th><th className="px-4 py-2"><span className="sr-only">Actions</span></th></tr>
                </thead>
                <tbody>
                  {data.members.map((m) => (
                    <tr key={m.userId} className="border-t border-line align-middle">
                      <td className="px-4 py-2.5"><p className="font-semibold text-ink">{m.name ?? m.email}</p><p className="text-[12px] text-muted">{m.email}{m.access === 'member' ? ' · guest from another workspace' : ''}{m.disabled ? ' · disabled' : ''}</p></td>
                      <td className="px-4 py-2.5">
                        <label className="sr-only" htmlFor={`role-${m.userId}`}>Role of {m.email}</label>
                        <select id={`role-${m.userId}`} className={cx(inputCls.replace('w-full', 'w-auto'), 'h-9 py-1')} value={m.role} disabled={m.disabled || busy !== null} onChange={(e) => void run(`role-${m.userId}`, () => api.patch(`/team/members/${m.userId}`, { role: e.target.value }), () => setMsg({ tone: 'ok', text: `Role changed for ${m.email}. It applies to their open sessions within seconds.` }))}>
                          {data.roles.map((r) => <option key={r} value={r}>{r.replace('_', ' ')}</option>)}
                        </select>
                      </td>
                      <td className="px-4 py-2.5 text-[12px] text-muted">{when(m.lastLoginAt)}</td>
                      <td className="px-4 py-2.5">
                        <span className="flex justify-end gap-1.5">
                          {m.access === 'home' && !m.disabled && <Button busy={busy === `reset-${m.userId}`} onClick={() => void run(`reset-${m.userId}`, () => api.post<Link>(`/team/members/${m.userId}/reset-link`, {}), setLink)} title="Create a one-time password-reset link"><KeyRound className="size-4" /><span className="sr-only sm:not-sr-only">Reset link</span></Button>}
                          {!m.disabled && <Button onClick={() => setConfirmRemove(m)} title="Remove access"><UserMinus className="size-4" /><span className="sr-only sm:not-sr-only">Remove</span></Button>}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          <div className="grid content-start gap-4">
            <Card className="p-4">
              <h2 className="flex items-center gap-2 text-[14px] font-semibold text-ink"><UserPlus className="size-4" aria-hidden /> Invite someone</h2>
              <form onSubmit={invite} noValidate className="mt-3 grid gap-3">
                <Label text="Email address"><input className={inputCls} type="email" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} /></Label>
                <div className="grid gap-1">
                  <label htmlFor="invite-role" className="text-[12.5px] font-semibold text-body">Invite as</label>
                  <select id="invite-role" className={inputCls} value={role} onChange={(e) => setRole(e.target.value)} aria-describedby="invite-role-help">{data.roles.map((r) => <option key={r} value={r}>{r.replace('_', ' ')}</option>)}</select>
                  <span id="invite-role-help" className="text-[12px] text-muted">{ROLE_HELP[role]}</span>
                </div>
                <Button type="submit" variant="primary" busy={busy === 'invite'}><Link2 className="size-4" /> Create invitation link</Button>
                <p className="flex items-start gap-1.5 text-[12px] text-muted"><Mail className="mt-0.5 size-3.5 shrink-0" aria-hidden />Email sending is not configured, so nothing is emailed. Copy the link and send it to the person yourself. It works once and expires.</p>
              </form>
            </Card>

            {msg && <p role={msg.tone === 'error' ? 'alert' : 'status'} className={cx('rounded-[10px] px-3 py-2 text-[12.5px]', msg.tone === 'ok' ? 'bg-emerald-50 text-emerald-800' : 'bg-rose-50 text-rose-800')}>{msg.text}</p>}

            <Card className="p-4">
              <h2 className="text-[14px] font-semibold text-ink">Open links</h2>
              {data.invitations.length === 0 ? <p className="mt-2 text-[12.5px] text-muted">No open invitation or reset links.</p> : (
                <ul className="mt-2 grid gap-2">
                  {data.invitations.map((i) => (
                    <li key={i.id} className="flex flex-wrap items-center gap-2 text-[12.5px]">
                      <Pill tone={i.kind === 'invite' ? 'blue' : 'amber'}>{i.kind === 'invite' ? 'invitation' : 'password reset'}</Pill>
                      <span className="font-semibold text-ink">{i.email}</span><span className="text-muted">{i.role.replace('_', ' ')} · expires {when(i.expiresAt)}</span>
                      <Button className="ml-auto" busy={busy === `revoke-${i.id}`} onClick={() => void run(`revoke-${i.id}`, () => api.post(`/team/invitations/${i.id}/revoke`, {}))}>Revoke</Button>
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-3 flex items-start gap-1.5 text-[12px] text-muted"><ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-emerald-600" aria-hidden />People see only the workspaces they are given. Removing someone ends their sessions here at once.</p>
            </Card>
          </div>
        </div>
      )}

      <LinkDialog link={link} onClose={() => setLink(null)} />
      <Dialog open={confirmRemove !== null} onClose={() => setConfirmRemove(null)} title="Remove access?">
        {confirmRemove && (
          <>
            <p className="text-[13px] text-body">{confirmRemove.access === 'member' ? `${confirmRemove.email} will lose access to this workspace. Their own workspace is not affected.` : `${confirmRemove.email} belongs to this workspace, so their account will be disabled: they cannot log in, and open sessions end now.`}</p>
            <div className="mt-4 flex justify-end gap-2"><Button onClick={() => setConfirmRemove(null)}>Cancel</Button><Button variant="danger" busy={busy === 'remove'} onClick={() => { const m = confirmRemove; setConfirmRemove(null); void run('remove', () => api.delete(`/team/members/${m.userId}`), () => setMsg({ tone: 'ok', text: `${m.email} no longer has access.` })); }}>Remove access</Button></div>
          </>
        )}
      </Dialog>
    </>
  );
}

function LinkDialog({ link, onClose }: { link: Link | null; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const url = link && typeof window !== 'undefined' ? `${window.location.origin}${link.path}` : '';
  return (
    <Dialog open={link !== null} onClose={() => { setCopied(false); onClose(); }} title={link?.kind === 'reset' ? 'Password-reset link' : 'Invitation link'}>
      {link && (
        <div className="grid gap-3 text-[13px] text-body">
          <p>For <b className="text-ink">{link.email}</b>{link.kind === 'invite' ? ` as ${link.role.replace('_', ' ')}` : ''}. It works once and expires {when(link.expiresAt)}. This is the only time it is shown.</p>
          <label className="sr-only" htmlFor="share-link">Link</label>
          <input id="share-link" readOnly className={cx(inputCls, 'font-mono text-[12px]')} value={url} onFocus={(e) => e.currentTarget.select()} />
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" onClick={async () => { try { await navigator.clipboard.writeText(url); setCopied(true); } catch { (document.getElementById('share-link') as HTMLInputElement | null)?.select(); } }}><Copy className="size-4" /> {copied ? 'Copied' : 'Copy link'}</Button>
            <Button onClick={() => { setCopied(false); onClose(); }}>Done</Button>
          </div>
          <p className="text-[12px] text-muted">Send it privately (for example in a direct message). Anyone with the link can use it once until it expires; revoke it from Open links if it was sent to the wrong person.</p>
        </div>
      )}
    </Dialog>
  );
}
