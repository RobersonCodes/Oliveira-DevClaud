import { isIP } from 'node:net';

function isValidAddressOrCidr(value: string): boolean {
  const slash = value.lastIndexOf('/');
  const address = slash === -1 ? value : value.slice(0, slash);
  const version = isIP(address);
  if (version === 0) return false;
  if (slash === -1) return true;

  const prefixText = value.slice(slash + 1);
  if (!/^\d+$/.test(prefixText)) return false;
  const prefix = Number(prefixText);
  return prefix >= 0 && prefix <= (version === 4 ? 32 : 128);
}

/**
 * Fastify must only honor X-Forwarded-* from the exact reverse proxies that can reach the API.
 * An empty value deliberately disables proxy trust (safe for direct development/test traffic).
 */
export function parseTrustedProxyCidrs(raw = process.env.TRUSTED_PROXY_CIDRS): false | string[] {
  if (!raw?.trim()) return false;
  const entries = raw.split(',').map(value => value.trim());
  if (entries.some(value => !value || !isValidAddressOrCidr(value))) {
    throw new Error('INVALID_TRUSTED_PROXY_CIDRS');
  }
  return entries;
}
