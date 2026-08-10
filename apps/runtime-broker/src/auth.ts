import crypto from 'node:crypto';
import type { FastifyRequest } from 'fastify';

/**
 * Service-to-service auth for the broker's internal-only API — never exposed to the internet (no
 * host port published in compose; only api/worker on the same compose network can reach it by
 * service name). A shared bearer secret is proportionate for this trust boundary: the real security
 * property the broker provides isn't "reject an untrusted caller" (api/worker are the only intended
 * callers and already hold the token), it's "even a caller holding a valid token cannot construct
 * arbitrary Docker operations" — enforced by the narrow, allowlisted contract itself, not by auth.
 */
function timingSafeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export function requireBrokerAuth(request: FastifyRequest): void {
  const token = process.env.RUNTIME_BROKER_TOKEN;
  if (!token) throw Object.assign(new Error('RUNTIME_BROKER_TOKEN_NOT_CONFIGURED'), { statusCode: 500 });
  const header = request.headers.authorization;
  const presented = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
  if (!presented || !timingSafeEqual(presented, token)) {
    throw Object.assign(new Error('UNAUTHORIZED'), { statusCode: 401 });
  }
}
