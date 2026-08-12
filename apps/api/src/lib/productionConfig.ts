import { isIP } from 'node:net';
import { parseTrustedProxyCidrs } from './trustedProxy.js';

const PLACEHOLDER = /(?:replace-with|change-me|changeme|todo)/i;

function required(env: NodeJS.ProcessEnv, name: string, errors: string[]): string {
  const value = env[name]?.trim();
  if (!value || PLACEHOLDER.test(value)) {
    errors.push(`${name}_REQUIRED`);
    return '';
  }
  return value;
}

function validateUrl(
  env: NodeJS.ProcessEnv,
  name: string,
  protocols: readonly string[],
  errors: string[]
): URL | undefined {
  const value = required(env, name, errors);
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (!protocols.includes(url.protocol)) throw new Error('protocol');
    return url;
  } catch {
    errors.push(`${name}_INVALID`);
    return undefined;
  }
}

function validateStrongSecret(env: NodeJS.ProcessEnv, name: string, errors: string[]) {
  const value = required(env, name, errors);
  if (value && Buffer.byteLength(value, 'utf8') < 32) errors.push(`${name}_TOO_SHORT`);
}

function validateMasterKey(env: NodeJS.ProcessEnv, errors: string[]) {
  const value = required(env, 'SECRETS_MASTER_KEY_BASE64', errors);
  if (!value) return;
  const decoded = Buffer.from(value, 'base64');
  const supplied = value.replace(/=+$/, '');
  const canonical = decoded.toString('base64').replace(/=+$/, '');
  if (decoded.length !== 32 || supplied !== canonical) errors.push('SECRETS_MASTER_KEY_BASE64_INVALID');
}

function validateRuntimeDomain(env: NodeJS.ProcessEnv, errors: string[]) {
  const value = required(env, 'RUNTIME_BASE_DOMAIN', errors).toLowerCase();
  if (!value) return;
  const labels = value.split('.');
  const validLabels = labels.length >= 2 && labels.every(label =>
    label.length > 0 &&
    label.length <= 63 &&
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
  );
  if (!validLabels || isIP(value) !== 0 || value === 'localhost' || value.endsWith('.localhost')) {
    errors.push('RUNTIME_BASE_DOMAIN_INVALID');
  }
}

/**
 * Production has no development fallbacks: the process must prove that secure cookies are active,
 * origins are HTTPS-only, secrets have usable entropy and forwarded identity comes from an exact
 * proxy allowlist. Error messages contain variable names only, never secret values.
 */
export function validateProductionConfig(env: NodeJS.ProcessEnv = process.env): void {
  const secureConfigRequired = env.SECURE_CONFIG_REQUIRED?.trim().toLowerCase() === 'true';
  if (env.NODE_ENV !== 'production' && !secureConfigRequired) return;

  const errors: string[] = [];
  if (env.NODE_ENV !== 'production') errors.push('NODE_ENV_MUST_BE_PRODUCTION');
  if (!secureConfigRequired) errors.push('SECURE_CONFIG_REQUIRED_MUST_BE_TRUE');

  const webOrigin = validateUrl(env, 'WEB_ORIGIN', ['https:'], errors);
  if (webOrigin) {
    const configured = env.WEB_ORIGIN!.trim();
    if (configured !== webOrigin.origin || webOrigin.username || webOrigin.password) {
      errors.push('WEB_ORIGIN_MUST_BE_EXACT_HTTPS_ORIGIN');
    }
    const panelHost = required(env, 'DEV_CLOUD_HOST', errors).toLowerCase();
    if (panelHost && panelHost !== webOrigin.hostname.toLowerCase()) {
      errors.push('DEV_CLOUD_HOST_MUST_MATCH_WEB_ORIGIN');
    }
  } else {
    required(env, 'DEV_CLOUD_HOST', errors);
  }

  validateRuntimeDomain(env, errors);
  validateStrongSecret(env, 'RUNTIME_TICKET_SECRET', errors);
  validateStrongSecret(env, 'RUNTIME_BROKER_TOKEN', errors);
  validateMasterKey(env, errors);

  validateUrl(env, 'DATABASE_URL', ['postgres:', 'postgresql:'], errors);
  validateUrl(env, 'REDIS_URL', ['redis:', 'rediss:'], errors);
  validateUrl(env, 'RUNTIME_BROKER_URL', ['http:', 'https:'], errors);

  const trustedProxies = parseTrustedProxyCidrs(env.TRUSTED_PROXY_CIDRS);
  if (trustedProxies === false) {
    errors.push('TRUSTED_PROXY_CIDRS_REQUIRED');
  } else if (trustedProxies.some(value => value === '0.0.0.0/0' || value === '::/0')) {
    errors.push('TRUSTED_PROXY_CIDRS_TOO_BROAD');
  }

  const sessionTtl = Number(env.SESSION_TTL_DAYS);
  if (!Number.isInteger(sessionTtl) || sessionTtl < 1 || sessionTtl > 30) {
    errors.push('SESSION_TTL_DAYS_INVALID');
  }

  if (errors.length > 0) {
    throw new Error(`INVALID_PRODUCTION_CONFIGURATION: ${[...new Set(errors)].sort().join(', ')}`);
  }
}
