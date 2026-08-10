import crypto from 'node:crypto';

// Short-lived, stateless, signed credential handed from the control plane (app.<domain>) to the
// Runtime Gateway (*.runtime.<domain>) — a genuinely different origin — so the browser can prove
// "this user, right now, is allowed into this specific workspace/port for this specific purpose"
// without ever sending the control-plane session cookie there (browsers don't send a cookie
// scoped to one host to a different host, by design — the ticket is the intentional, narrow,
// short-lived bridge across that boundary instead).
//
// Signed (HMAC-SHA256) rather than stored in a DB table: the gateway must validate on every
// subdomain request path with no extra round trip. This is a short-lived BEARER ticket, not a
// single-use one — nothing tracks which tickets have already been redeemed (no jti/consumption
// store), so the same ticket string stays valid for anyone who has it until the 60s TTL elapses,
// same as a short-lived access token. What actually limits the blast radius of a leaked ticket is
// the TTL itself plus scope (bound to one workspace/purpose/port) — early revocation isn't a gap
// this needs to close, because the gateway re-checks live organization membership on *every*
// request regardless of ticket or cookie (see runtimeGateway.ts), so removing a user from the org
// invalidates their access immediately even though a ticket's signature stays valid until expiry.
// If a genuinely single-use guarantee is ever needed, it requires a consumed-jti store (Redis with
// a TTL matching the ticket's own would do) — deliberately not built here to keep this stateless.

export type RuntimeTicketPurpose = 'ide' | 'preview';

export interface RuntimeTicketPayload {
  /** The user this ticket was issued to. */
  uid: string;
  workspaceId: string;
  purpose: RuntimeTicketPurpose;
  /** Required and validated when purpose === 'preview'; absent for 'ide' (which always targets IDE_PORT). */
  port?: number;
  /** Unix ms expiry. */
  exp: number;
}

function secret(): string {
  const value = process.env.RUNTIME_TICKET_SECRET;
  if (!value) throw Object.assign(new Error('RUNTIME_TICKET_SECRET_NOT_CONFIGURED'), { statusCode: 503 });
  return value;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function sign(payloadB64: string): string {
  return crypto.createHmac('sha256', secret()).update(payloadB64).digest('base64url');
}

export function issueRuntimeTicket(payload: Omit<RuntimeTicketPayload, 'exp'>, ttlMs = 60_000): string {
  const full: RuntimeTicketPayload = { ...payload, exp: Date.now() + ttlMs };
  const payloadB64 = base64url(JSON.stringify(full));
  return `${payloadB64}.${sign(payloadB64)}`;
}

/** Returns the payload if the ticket's signature is valid and it hasn't expired; null otherwise.
 *  Does NOT check that the ticket's workspaceId/purpose/port match what's being accessed, or that
 *  the user's organization membership is still current — callers must do both. */
export function verifyRuntimeTicket(ticket: string): RuntimeTicketPayload | null {
  const parts = ticket.split('.');
  if (parts.length !== 2) return null;
  const [payloadB64, signature] = parts as [string, string];
  const expected = sign(payloadB64);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload: RuntimeTicketPayload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof payload.exp !== 'number' || payload.exp < Date.now()) return null;
  if (typeof payload.uid !== 'string' || typeof payload.workspaceId !== 'string') return null;
  if (payload.purpose !== 'ide' && payload.purpose !== 'preview') return null;
  return payload;
}
