import { errorMessage } from '../common/logger.js';
import type { FetchLike, ProviderResult } from '../integrations/provider-clients.js';

/** Office mail (Gmail / Google Workspace) over IMAP with an app password. Read-only: only envelopes, never bodies. */
export type MailSummary = {
  ok: boolean;
  account: string;
  unread: number;
  total: number;
  recent: Array<{ from: string; subject: string; at: string | null; unread: boolean }>;
  message: string;
};

export type ImapLike = {
  connect(): Promise<void>;
  logout(): Promise<void>;
  status(path: string, q: { messages?: boolean; unseen?: boolean }): Promise<{ messages?: number; unseen?: number } | false>;
  getMailboxLock(path: string, o?: { readOnly?: boolean }): Promise<{ release(): void }>;
  search(q: Record<string, unknown>, o?: { uid?: boolean }): Promise<number[] | false | undefined>;
  fetchAll(range: number[] | string, q: Record<string, unknown>, o?: { uid?: boolean }): Promise<Array<{ envelope?: { from?: Array<{ name?: string; address?: string }>; subject?: string; date?: Date }; flags?: Set<string> }>>;
};
export type ImapFactory = (o: { host: string; port: number; user: string; pass: string }) => Promise<ImapLike>;

export const defaultImap: ImapFactory = async (o) => {
  // Loaded lazily: the API starts and runs without it until a business connects office mail.
  const { ImapFlow } = (await import('imapflow')) as unknown as { ImapFlow: new (opts: Record<string, unknown>) => ImapLike };
  return new ImapFlow({ host: o.host, port: o.port, secure: true, auth: { user: o.user, pass: o.pass }, logger: false, connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000, disableAutoIdle: true });
};

const maskMail = (a: string) => a.replace(/^(.{2}).*(@.*)$/, '$1•••$2');

export async function checkOfficeMail(cfg: { email?: string; host?: string }, secrets: { appPassword?: string }, factory: ImapFactory = defaultImap): Promise<MailSummary> {
  const account = cfg.email ? maskMail(cfg.email) : '';
  if (!cfg.email || !secrets.appPassword) return { ok: false, account, unread: 0, total: 0, recent: [], message: 'Office mail is not connected (Integrations → Office mail).' };
  const client = await factory({ host: cfg.host || 'imap.gmail.com', port: 993, user: cfg.email, pass: secrets.appPassword.replace(/\s+/g, '') });
  try {
    await client.connect();
    const st = await client.status('INBOX', { messages: true, unseen: true });
    const lock = await client.getMailboxLock('INBOX', { readOnly: true });
    let recent: MailSummary['recent'] = [];
    try {
      const since = new Date(Date.now() - 7 * 86_400_000);
      const uids = (await client.search({ since }, { uid: true })) || [];
      const last = uids.slice(-10);
      if (last.length) {
        const msgs = await client.fetchAll(last, { envelope: true, flags: true }, { uid: true });
        recent = msgs.reverse().map((m) => {
          const f = m.envelope?.from?.[0];
          return { from: (f?.name || f?.address || 'unknown').slice(0, 80), subject: (m.envelope?.subject || '(no subject)').slice(0, 140), at: m.envelope?.date ? new Date(m.envelope.date).toISOString() : null, unread: !m.flags?.has('\\Seen') };
        });
      }
    } finally {
      lock.release();
    }
    const unread = st ? st.unseen ?? 0 : 0;
    return { ok: true, account, unread, total: st ? st.messages ?? 0 : 0, recent, message: `${unread} unread in the inbox.` };
  } catch (e) {
    const msg = errorMessage(e);
    const auth = /auth|credential|invalid|login|password/i.test(msg);
    return { ok: false, account, unread: 0, total: 0, recent: [], message: auth ? 'Gmail refused the login: use an app password (Google account → Security → 2-Step Verification → App passwords) and check IMAP is on.' : `Could not read the inbox (${msg.slice(0, 120)}).` };
  } finally {
    await client.logout().catch(() => undefined);
  }
}

/** Integrations → Office mail → Test: a read-only login and inbox count. */
export async function officeMailTest(cfg: { email?: string; host?: string }, secrets: { appPassword?: string }, factory: ImapFactory = defaultImap): Promise<ProviderResult> {
  const started = Date.now();
  const r = await checkOfficeMail(cfg, secrets, factory);
  return r.ok
    ? { ok: true, latencyMs: Date.now() - started, message: `Signed in to ${r.account}: ${r.unread} unread of ${r.total} in the inbox. Read-only; nothing is changed.` }
    : { ok: false, latencyMs: Date.now() - started, errorCode: /refused the login/.test(r.message) ? 'auth_failed' : 'provider_error', message: r.message };
}

/** Instagram professional account: followers, posts and recent post engagement (Graph API, the Page token). */
export type InstagramSummary = {
  ok: boolean;
  username?: string;
  followers?: number;
  posts?: number;
  recent: Array<{ caption: string; likes: number; comments: number; at: string; link?: string }>;
  message: string;
};

export async function checkInstagram(fetchImpl: FetchLike, token: string | undefined, igId: string | undefined, version = process.env.WHATSAPP_API_VERSION ?? 'v23.0'): Promise<InstagramSummary> {
  if (!token || !igId) return { ok: false, recent: [], message: 'Instagram is not connected (Integrations → Instagram & Messenger, with the Instagram account ID).' };
  const base = `https://graph.facebook.com/${version}/${encodeURIComponent(igId)}`;
  const get = async (url: string) => {
    const r = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
    const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    if (!r.ok) throw new Error(String((j.error as { message?: string } | undefined)?.message ?? `HTTP ${r.status}`).replaceAll(token, '***'));
    return j;
  };
  try {
    const [acct, media] = await Promise.all([get(`${base}?fields=username,followers_count,media_count`), get(`${base}/media?fields=caption,like_count,comments_count,timestamp,permalink&limit=5`)]);
    const rows = (media.data as Array<Record<string, unknown>> | undefined) ?? [];
    return {
      ok: true,
      username: typeof acct.username === 'string' ? acct.username : undefined,
      followers: Number(acct.followers_count) || 0,
      posts: Number(acct.media_count) || 0,
      recent: rows.map((m) => ({ caption: String(m.caption ?? '').slice(0, 120), likes: Number(m.like_count) || 0, comments: Number(m.comments_count) || 0, at: String(m.timestamp ?? ''), link: typeof m.permalink === 'string' ? m.permalink : undefined })),
      message: 'Read from Instagram.',
    };
  } catch (e) {
    return { ok: false, recent: [], message: `Instagram could not be read: ${errorMessage(e).slice(0, 160)}. The Page token needs instagram_basic (and instagram_manage_insights for insights).` };
  }
}
