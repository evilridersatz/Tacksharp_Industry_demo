'use client';

import { useParams } from 'next/navigation';
import { useState } from 'react';
import { Copy } from 'lucide-react';
import { ApiError, api, useApi } from '@/lib/api';
import { Badge, Button, Card, CardHeader, Skeleton, cx } from '@/components/ui';
import { Dialog, inputCls } from '@/components/textile';
import { OrgStatus, PlatformFrame, when } from '@/components/platform';
import { toast } from '@/components/toast';

type Detail = {
  id: string; name: string; status: string; selfServe: boolean; isDemo: boolean; contactPhone: string | null; createdAt: string; activatedAt: string | null; suspendedAt: string | null; suspendedReason: string | null;
  allowedIndustries: string[] | null; industry: string; industryLabel: string; settableIndustries: Array<{ id: string; label: string }>;
  users: Array<{ id: string; email: string; name: string | null; role: string; lastLoginAt: string | null; disabledAt: string | null; isPlatformAdmin: boolean; resetRequested: boolean }>;
  guests: Array<{ id: string; email: string; role: string }>;
  integrations: Array<{ provider: string; saved: boolean; enabled: boolean; status: string; lastTestAt: string | null; lastSuccessAt: string | null }>;
  channels: Array<{ kind: string; id: string }>;
  usage: Array<{ provider: string; ok: boolean; count: number; units: number; costEstimate: number | null }>;
  audit: Array<{ id: string; actor: string; entityType: string; action: string; createdAt: string }>;
  onboarding: { steps: Array<{ key: string; label: string; done: boolean }>; done: number; total: number };
};
type Link_ = { kind: string; email: string; path: string; expiresAt: string };
const msg = (e: unknown) => (e instanceof ApiError || e instanceof Error ? e.message : String(e));

export default function PlatformOrganization() {
  const { id } = useParams<{ id: string }>();
  const { data: o, error, reload } = useApi<Detail>(`/platform/organizations/${encodeURIComponent(id)}`, 30_000);
  const [confirm, setConfirm] = useState<null | 'activate' | 'suspend'>(null);
  const [typed, setTyped] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [link, setLink] = useState<Link_ | null>(null);
  const [allowed, setAllowed] = useState<string[] | null | undefined>(undefined);
  const [invite, setInvite] = useState({ email: '', role: 'admin' });

  async function run<T>(key: string, fn: () => Promise<T>, ok?: (r: T) => void) {
    setBusy(key);
    try { const r = await fn(); ok?.(r); await reload(); } catch (e) { toast(msg(e), 'error'); } finally { setBusy(null); }
  }
  const allowedNow = allowed === undefined ? o?.allowedIndustries ?? null : allowed;

  return (
    <PlatformFrame title={o?.name ?? 'Organization'} error={error} reload={reload}>
      {!o ? <Skeleton className="h-[600px]" /> : (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
          <div className="grid content-start gap-4">
            <Card>
              <CardHeader title={o.name} subtitle={`${o.id} · ${o.industryLabel}${o.isDemo ? ' · demo workspace' : ''}${o.selfServe ? ' · self-service signup' : ''}`} action={<OrgStatus status={o.status} />} />
              <div className="grid gap-1 px-5 pb-4 text-[13px]">
                <p>Created {when(o.createdAt)}{o.activatedAt ? ` · activated ${when(o.activatedAt)}` : ''}{o.contactPhone ? ` · contact +${o.contactPhone}` : ''}</p>
                {o.status === 'suspended' && <p className="text-rose-700">Suspended {when(o.suspendedAt)}: {o.suspendedReason}</p>}
                <div className="mt-3 flex flex-wrap gap-2">
                  {o.status !== 'active' && <Button variant="primary" onClick={() => { setConfirm('activate'); setTyped(''); }}>Activate</Button>}
                  {o.status !== 'suspended' && <Button variant="danger" onClick={() => { setConfirm('suspend'); setTyped(''); setReason(''); }}>Suspend</Button>}
                </div>
              </div>
            </Card>

            <Card className="overflow-hidden">
              <CardHeader title="Users" subtitle="Home users of this organization. Guests from other organizations are listed below." />
              <div className="overflow-x-auto">
                <table className="w-full text-[13px]">
                  <thead className="bg-slate-50 text-left text-[12px] text-muted"><tr><th className="px-4 py-2">Person</th><th className="px-4 py-2">Role</th><th className="px-4 py-2">Last login</th><th className="px-4 py-2"><span className="sr-only">Actions</span></th></tr></thead>
                  <tbody>
                    {o.users.map((u) => (
                      <tr key={u.id} className="border-t border-line">
                        <td className="px-4 py-2.5"><p className="font-semibold text-ink">{u.name ?? u.email}</p><p className="text-[12px] text-muted">{u.email}{u.disabledAt ? ' · disabled' : ''}{u.isPlatformAdmin ? ' · platform admin' : ''}</p>{u.resetRequested && <Badge tone="amber">Reset requested</Badge>}</td>
                        <td className="px-4 py-2.5">{u.role}</td>
                        <td className="px-4 py-2.5 text-muted">{when(u.lastLoginAt)}</td>
                        <td className="px-4 py-2.5">
                          <span className="flex justify-end gap-1.5">
                            {!u.disabledAt && <Button busy={busy === `reset-${u.id}`} onClick={() => void run(`reset-${u.id}`, () => api.post<Link_>(`/platform/organizations/${encodeURIComponent(o.id)}/users/${u.id}/reset-link`), setLink)}>Reset link</Button>}
                            <Button variant={u.disabledAt ? 'secondary' : 'danger'} busy={busy === `dis-${u.id}`} onClick={() => void run(`dis-${u.id}`, () => api.post(`/platform/organizations/${encodeURIComponent(o.id)}/users/${u.id}/disable`, { disabled: !u.disabledAt }), () => toast(u.disabledAt ? 'User enabled.' : 'User disabled; their sessions ended.'))}>{u.disabledAt ? 'Enable' : 'Disable'}</Button>
                          </span>
                        </td>
                      </tr>
                    ))}
                    {o.guests.map((g) => <tr key={g.id} className="border-t border-line text-muted"><td className="px-4 py-2.5">{g.email} (guest)</td><td className="px-4 py-2.5">{g.role}</td><td colSpan={2} /></tr>)}
                  </tbody>
                </table>
              </div>
              <form className="grid gap-2 border-t border-line p-4 sm:grid-cols-[minmax(0,1fr)_auto_auto]" onSubmit={(e) => { e.preventDefault(); void run('invite', () => api.post<Link_>(`/platform/organizations/${encodeURIComponent(o.id)}/invitations`, invite), (r) => { setLink(r); setInvite({ email: '', role: 'admin' }); }); }}>
                <label htmlFor="inv-email" className="sr-only">Email to invite</label>
                <input id="inv-email" type="email" className={inputCls} placeholder="Invite someone by email" value={invite.email} onChange={(e) => setInvite({ ...invite, email: e.target.value })} />
                <label htmlFor="inv-role" className="sr-only">Role</label>
                <select id="inv-role" className={cx(inputCls, 'w-auto')} value={invite.role} onChange={(e) => setInvite({ ...invite, role: e.target.value })}>{['admin', 'manager', 'operator', 'viewer'].map((r) => <option key={r}>{r}</option>)}</select>
                <Button type="submit" busy={busy === 'invite'} disabled={!invite.email.trim()}>Create invitation link</Button>
              </form>
            </Card>

            <Card>
              <CardHeader title="Recent audit events" />
              <ul className="grid max-h-80 gap-1 overflow-y-auto px-5 pb-4 text-[12.5px]">
                {o.audit.map((a) => <li key={a.id} className="flex gap-2"><span className="w-32 shrink-0 text-muted">{when(a.createdAt)}</span><span className="font-semibold">{a.action}</span><span className="truncate text-muted">{a.actor}</span></li>)}
                {!o.audit.length && <li className="text-muted">No events yet.</li>}
              </ul>
            </Card>
          </div>

          <div className="grid content-start gap-4">
            <Card>
              <CardHeader title="Onboarding" subtitle={`${o.onboarding.done} of ${o.onboarding.total} steps, from records`} />
              <ul className="grid gap-1.5 px-5 pb-4 text-[13px]">{o.onboarding.steps.map((s) => <li key={s.key} className="flex items-center gap-2"><span className={cx('size-2.5 rounded-full', s.done ? 'bg-emerald-500' : 'bg-slate-300')} aria-hidden /><span className="sr-only">{s.done ? 'Done: ' : 'Not done: '}</span>{s.label}</li>)}</ul>
            </Card>
            <Card>
              <CardHeader title="Integrations" subtitle="Status only. Platform staff never see customer secrets." />
              <ul className="grid gap-2 px-5 pb-4 text-[13px]">
                {o.integrations.map((i) => <li key={i.provider} className="flex items-center justify-between gap-2"><span className="font-semibold">{({ plivo: 'Plivo', sarvam: 'Sarvam', openai: 'OpenAI', whatsapp: 'WhatsApp' } as Record<string, string>)[i.provider] ?? i.provider}</span><span className="flex gap-1.5"><Badge tone={i.status === 'ok' ? 'brand' : i.status === 'failed' ? 'rose' : 'slate'}>{i.status.replace('_', ' ')}</Badge>{i.enabled && <Badge tone="brand">enabled</Badge>}</span></li>)}
              </ul>
              <p className="px-5 pb-4 text-[12px] text-muted">Routed channels: {o.channels.length ? o.channels.map((c) => `${c.kind} ${c.id}`).join(', ') : 'none'}</p>
            </Card>
            <Card>
              <CardHeader title="Permitted industries" subtitle="Which industries this organization may switch to in Settings." />
              <div className="grid gap-2 px-5 pb-4 text-[13px]">
                <label className="flex items-center gap-2"><input type="checkbox" checked={allowedNow === null} onChange={(e) => setAllowed(e.target.checked ? null : [o.industry])} /> All industries</label>
                {allowedNow !== null && o.settableIndustries.map((i) => (
                  <label key={i.id} className="flex items-center gap-2 pl-5"><input type="checkbox" checked={allowedNow.includes(i.id)} onChange={(e) => setAllowed(e.target.checked ? [...allowedNow, i.id] : allowedNow.filter((x) => x !== i.id))} /> {i.label}</label>
                ))}
                <Button busy={busy === 'ind'} disabled={allowedNow !== null && allowedNow.length === 0} onClick={() => void run('ind', () => api.put(`/platform/organizations/${encodeURIComponent(o.id)}/industries`, { allowed: allowedNow }), () => { setAllowed(undefined); toast('Permitted industries saved.'); })}>Save industries</Button>
              </div>
            </Card>
            <Card>
              <CardHeader title="Usage (30 days)" subtitle="Requests this platform made for the organization." />
              <ul className="grid gap-1 px-5 pb-4 text-[13px]">
                {o.usage.map((u) => <li key={`${u.provider}-${u.ok}`} className="flex justify-between"><span>{u.provider} · {u.ok ? 'ok' : 'failed'}</span><span className="tabular">{u.count} · {u.units} units{u.costEstimate !== null ? ` · ≈ ${u.costEstimate.toFixed(2)}` : ''}</span></li>)}
                {!o.usage.length && <li className="text-muted">Nothing recorded.</li>}
              </ul>
            </Card>
          </div>

          <Dialog open={confirm !== null} onClose={() => setConfirm(null)} title={confirm === 'activate' ? 'Activate this organization?' : 'Suspend this organization?'}>
            <form className="grid gap-3 text-[13px]" onSubmit={(e) => {
              e.preventDefault();
              const action = confirm!;
              void run(action, () => api.post(`/platform/organizations/${encodeURIComponent(o.id)}/${action}`, { confirmName: typed, reason }), () => { setConfirm(null); toast(action === 'activate' ? 'Organization activated.' : 'Organization suspended; its sessions ended.'); });
            }}>
              <p className="text-body">{confirm === 'activate' ? 'Its admins are marked verified and test calls become possible.' : 'Every user of this organization is signed out at once and cannot log in. Its data is kept.'}</p>
              {confirm === 'suspend' && <label className="grid gap-1"><span className="font-semibold">Reason (recorded in the audit log)</span><input className={inputCls} value={reason} onChange={(e) => setReason(e.target.value)} /></label>}
              <label className="grid gap-1"><span className="font-semibold">Type <b>{o.name}</b> to confirm</span><input className={inputCls} value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" /></label>
              <div className="flex justify-end gap-2"><Button type="button" onClick={() => setConfirm(null)}>Cancel</Button><Button type="submit" variant={confirm === 'suspend' ? 'danger' : 'primary'} busy={busy === confirm} disabled={typed.trim() !== o.name || (confirm === 'suspend' && reason.trim().length < 3)}>{confirm === 'activate' ? 'Activate' : 'Suspend'}</Button></div>
            </form>
          </Dialog>
          <Dialog open={link !== null} onClose={() => setLink(null)} title={link?.kind === 'reset' ? 'Password-reset link' : 'Invitation link'}>
            {link && (
              <div className="grid gap-3 text-[13px]">
                <p>For <b>{link.email}</b>. Works once, expires {when(link.expiresAt)}. Shown only now: send it privately.</p>
                <input readOnly className={cx(inputCls, 'font-mono text-[12px]')} value={`${typeof window !== 'undefined' ? window.location.origin : ''}${link.path}`} onFocus={(e) => e.currentTarget.select()} aria-label="Link" />
                <div className="flex gap-2"><Button variant="primary" onClick={() => navigator.clipboard.writeText(`${window.location.origin}${link.path}`).then(() => toast('Copied.'), () => toast('Select and copy the link.', 'error'))}><Copy className="size-4" /> Copy link</Button><Button onClick={() => setLink(null)}>Done</Button></div>
              </div>
            )}
          </Dialog>
        </div>
      )}
    </PlatformFrame>
  );
}
