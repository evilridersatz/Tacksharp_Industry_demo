import plivo from 'plivo';

export type SignedRequest = {
  method: string;
  originalUrl: string;
  protocol?: string;
  header(name: string): string | undefined;
};

export type PlivoSignatureOptions = {
  enabled: boolean;
  authToken: string;
  publicBaseUrl: string;
};

/**
 * Plivo V3 webhook signature check, shared by every Plivo callback (calls, ready calls, feedback calls).
 *
 * Plivo signs the exact URL it called. Behind a tunnel or proxy that URL is PUBLIC_BASE_URL + path; when
 * PUBLIC_BASE_URL is written slightly differently (trailing slash, http vs https behind a TLS proxy) the URL the
 * proxy forwarded is tried as well. Either way the signature itself must match the account's auth token, so
 * accepting the second form does not weaken the check: without the token nobody can produce a valid signature.
 *
 * Returns ok=false with a reason (never the token or the signature) when the request must be rejected.
 */
export function checkPlivoSignature(req: SignedRequest, body: Record<string, string>, opts: PlivoSignatureOptions): { ok: boolean; reason?: string } {
  if (!opts.enabled) return { ok: true, reason: 'validation_disabled' };
  if (!opts.authToken) return { ok: false, reason: 'auth_token_missing' };
  const signature = req.header('x-plivo-signature-v3');
  const nonce = req.header('x-plivo-signature-v3-nonce');
  if (!signature || !nonce) return { ok: false, reason: 'signature_missing' };
  const method = req.method.toUpperCase();
  for (const url of candidateUrls(req, opts.publicBaseUrl)) {
    try {
      if (plivo.validateV3Signature(method, url, nonce, opts.authToken, signature, method === 'POST' ? body : {})) return { ok: true };
    } catch {
      // A malformed URL or method: try the next form, then reject.
    }
  }
  return { ok: false, reason: 'signature_mismatch' };
}

function candidateUrls(req: SignedRequest, publicBaseUrl: string): string[] {
  const urls = new Set<string>();
  const base = publicBaseUrl.replace(/\/+$/, '');
  if (base) urls.add(`${base}${req.originalUrl}`);
  const host = (req.header('x-forwarded-host') ?? req.header('host') ?? '').split(',')[0].trim();
  if (host) {
    const proto = (req.header('x-forwarded-proto') ?? req.protocol ?? 'https').split(',')[0].trim();
    urls.add(`${proto}://${host}${req.originalUrl}`);
  }
  return [...urls];
}
