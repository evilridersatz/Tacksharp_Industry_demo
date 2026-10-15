import { log } from './logger.js';

/**
 * Error reporting that says WHICH dependency failed and HOW, without secrets.
 *
 * Node's fetch reports every network failure as "fetch failed" and keeps the real reason ("connect ETIMEDOUT
 * 157.240.1.1:443") in error.cause; ioredis reports a Redis connect timeout as a bare "connect ETIMEDOUT"; the
 * MariaDB driver says "(conn:-1, no: 45028) pool timeout". Logging only error.message made these look alike.
 */

export type Dependency = 'redis' | 'database' | 'meta_graph' | 'plivo' | 'sarvam' | 'llm' | 'unknown';

type ErrLike = { name?: string; message?: string; code?: string | number; syscall?: string; address?: string; port?: number; cause?: unknown; dependency?: Dependency };

/** "fetch failed <- connect ETIMEDOUT (ETIMEDOUT connect 157.240.1.1:443)": message plus the cause chain (max 3). */
export function describeError(error: unknown): string {
  const parts: string[] = [];
  let e: unknown = error;
  for (let depth = 0; e && depth < 3; depth++) {
    if (typeof e !== 'object') {
      parts.push(String(e));
      break;
    }
    const x = e as ErrLike;
    const detail = [x.code, x.syscall, x.address ? `${x.address}${x.port ? `:${x.port}` : ''}` : ''].filter(Boolean).join(' ');
    parts.push(`${x.message ?? x.name ?? 'error'}${detail && !(x.message ?? '').includes(String(x.code)) ? ` (${detail})` : ''}`);
    e = x.cause;
  }
  return parts.join(' <- ').slice(0, 500);
}

/** Every code / message in the cause chain, lower-cased, for classification. */
function chain(error: unknown): { codes: string[]; text: string } {
  const codes: string[] = [];
  const texts: string[] = [];
  let e: unknown = error;
  for (let depth = 0; e && typeof e === 'object' && depth < 4; depth++) {
    const x = e as ErrLike;
    if (x.code !== undefined) codes.push(String(x.code).toUpperCase());
    texts.push(`${x.name ?? ''} ${x.message ?? ''} ${x.syscall ?? ''}`);
    e = x.cause;
  }
  return { codes, text: texts.join(' ').toLowerCase() };
}

/** Which dependency an error came from: an explicit tag wins; otherwise recognisable driver / client messages. */
export function dependencyOf(error: unknown, fallback: Dependency = 'unknown'): Dependency {
  const tagged = (error as ErrLike | undefined)?.dependency;
  if (tagged) return tagged;
  const { text } = chain(error);
  // Provider names first: "WHATSAPP_PHONE_NUMBER_ID missing" must not read as a database error code.
  if (/whatsapp|graph\.facebook/.test(text)) return 'meta_graph';
  if (/sarvam/.test(text)) return 'sarvam';
  if (/plivo/.test(text)) return 'plivo';
  if (/prisma|\(conn:|pool timeout|sqlstate|\ber_[a-z_]+\b|mariadb|mysql/.test(text)) return 'database';
  if (/redis|ioredis|maxretriesperrequest|connection is closed/.test(text)) return 'redis';
  return fallback;
}

/**
 * The request never reached the provider (DNS, refused, connect timeout): retrying cannot duplicate anything.
 * Contrast with a timeout AFTER the request was sent, where the provider may already have acted.
 */
export function isConnectFailure(error: unknown): boolean {
  const { codes, text } = chain(error);
  if (codes.some((c) => ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT'].includes(c))) return true;
  return /connect etimedout|connect econnrefused|syscall connect|\bconnect\b.*timed? ?out/.test(text) || (codes.includes('ETIMEDOUT') && /\bconnect\b/.test(text));
}

/** The request may have been received and acted on, but no answer came back (read timeout, reset, abort). */
export function isAmbiguousNetworkFailure(error: unknown): boolean {
  if (isConnectFailure(error)) return false;
  const { codes, text } = chain(error);
  return (
    codes.some((c) => ['ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'ETIMEDOUT', 'ABORT_ERR', '23'].includes(c)) ||
    /timeouterror|aborterror|operation was aborted|timed out|other side closed|socket hang up/.test(text)
  );
}

/**
 * Logs repeated identical errors once per window instead of on every reconnect attempt (BullMQ re-emits a Redis
 * connect timeout every few seconds while Redis is unreachable), with the dependency named.
 */
export class ErrorThrottle {
  private readonly seen = new Map<string, { at: number; suppressed: number }>();
  constructor(private readonly windowMs = 60_000, private readonly now: () => number = Date.now) {}

  report(event: string, error: unknown, extra: Record<string, unknown> = {}, fallback: Dependency = 'unknown'): boolean {
    const dependency = dependencyOf(error, fallback);
    const detail = describeError(error);
    const key = `${event}|${dependency}|${detail}`;
    const hit = this.seen.get(key);
    const t = this.now();
    if (hit && t - hit.at < this.windowMs) {
      hit.suppressed++;
      return false;
    }
    log.error(event, { ...extra, dependency, error: detail, ...(hit?.suppressed ? { repeatedSinceLastLog: hit.suppressed } : {}) });
    this.seen.set(key, { at: t, suppressed: 0 });
    if (this.seen.size > 200) this.seen.clear();
    return true;
  }
}
