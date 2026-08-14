import { describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { validateProductionConfig } from './productionConfig.js';

function validProductionEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'production',
    SECURE_CONFIG_REQUIRED: 'true',
    WEB_ORIGIN: 'https://app.aifunnelpro.com.br',
    DEV_CLOUD_HOST: 'app.aifunnelpro.com.br',
    RUNTIME_BASE_DOMAIN: 'runtime.tiremax.shop',
    RUNTIME_TICKET_SECRET: 'runtime-ticket-secret-with-32-bytes',
    RUNTIME_BROKER_TOKEN: 'runtime-broker-token-with-32-bytes',
    SECRETS_MASTER_KEY_BASE64: Buffer.alloc(32, 7).toString('base64'),
    DATABASE_URL: 'postgresql://oliveira:secret@postgres:5432/devcloud',
    REDIS_URL: 'redis://redis:6379',
    RUNTIME_BROKER_URL: 'http://runtime-broker:5001',
    TRUSTED_PROXY_CIDRS: '172.30.0.1/32',
    SESSION_TTL_DAYS: '14',
    ...overrides
  };
}

describe('production configuration boundary', () => {
  it('keeps development usable without production-only configuration', () => {
    expect(() => validateProductionConfig({ NODE_ENV: 'development' })).not.toThrow();
  });

  it('cannot be forced into insecure cookie mode when secure configuration is required', () => {
    expect(() => validateProductionConfig(validProductionEnv({ NODE_ENV: 'development' })))
      .toThrow('NODE_ENV_MUST_BE_PRODUCTION');
  });

  it('is wired into application boot before Fastify starts', async () => {
    const names = ['NODE_ENV', 'SECURE_CONFIG_REQUIRED', 'WEB_ORIGIN'] as const;
    const previous = new Map(names.map(name => [name, process.env[name]]));
    process.env.NODE_ENV = 'production';
    process.env.SECURE_CONFIG_REQUIRED = 'true';
    delete process.env.WEB_ORIGIN;
    try {
      await expect(buildApp({ logger: false })).rejects.toThrow('WEB_ORIGIN_REQUIRED');
    } finally {
      for (const [name, value] of previous) {
        if (value === undefined) delete process.env[name]; else process.env[name] = value;
      }
    }
  });

  it('accepts a complete production configuration', () => {
    expect(() => validateProductionConfig(validProductionEnv())).not.toThrow();
  });

  it.each([
    'SECURE_CONFIG_REQUIRED',
    'WEB_ORIGIN',
    'DEV_CLOUD_HOST',
    'RUNTIME_BASE_DOMAIN',
    'RUNTIME_TICKET_SECRET',
    'RUNTIME_BROKER_TOKEN',
    'SECRETS_MASTER_KEY_BASE64',
    'DATABASE_URL',
    'REDIS_URL',
    'RUNTIME_BROKER_URL',
    'TRUSTED_PROXY_CIDRS',
    'SESSION_TTL_DAYS'
  ])('rejects missing production setting %s', name => {
    const env = validProductionEnv();
    delete env[name];
    expect(() => validateProductionConfig(env)).toThrow(name);
  });

  it.each([
    'http://app.aifunnelpro.com.br',
    'https://app.aifunnelpro.com.br/path',
    'https://user:password@app.aifunnelpro.com.br'
  ])('requires WEB_ORIGIN to be an exact credential-free HTTPS origin: %s', origin => {
    expect(() => validateProductionConfig(validProductionEnv({ WEB_ORIGIN: origin })))
      .toThrow(/WEB_ORIGIN_(?:INVALID|MUST_BE_EXACT_HTTPS_ORIGIN)/);
  });

  it('requires the panel host to match WEB_ORIGIN', () => {
    expect(() => validateProductionConfig(validProductionEnv({ DEV_CLOUD_HOST: 'other.example' })))
      .toThrow('DEV_CLOUD_HOST_MUST_MATCH_WEB_ORIGIN');
  });

  it.each(['localhost', 'runtime.localhost', '127.0.0.1', '*.runtime.tiremax.shop', 'single-label'])(
    'rejects a development or malformed runtime domain: %s', domain => {
      expect(() => validateProductionConfig(validProductionEnv({ RUNTIME_BASE_DOMAIN: domain })))
        .toThrow('RUNTIME_BASE_DOMAIN_INVALID');
    }
  );

  it('rejects weak or placeholder service secrets and a malformed master key', () => {
    expect(() => validateProductionConfig(validProductionEnv({ RUNTIME_TICKET_SECRET: 'short' })))
      .toThrow('RUNTIME_TICKET_SECRET_TOO_SHORT');
    expect(() => validateProductionConfig(validProductionEnv({ RUNTIME_BROKER_TOKEN: 'replace-with-token' })))
      .toThrow('RUNTIME_BROKER_TOKEN_REQUIRED');
    expect(() => validateProductionConfig(validProductionEnv({ SECRETS_MASTER_KEY_BASE64: 'not-base64' })))
      .toThrow('SECRETS_MASTER_KEY_BASE64_INVALID');
  });

  it('rejects placeholders embedded inside connection URLs', () => {
    expect(() => validateProductionConfig(validProductionEnv({
      DATABASE_URL: 'postgresql://oliveira:replace-with-password@postgres:5432/devcloud'
    }))).toThrow('DATABASE_URL_REQUIRED');
  });

  it('rejects a proxy allowlist that trusts the entire internet', () => {
    expect(() => validateProductionConfig(validProductionEnv({ TRUSTED_PROXY_CIDRS: '0.0.0.0/0' })))
      .toThrow('TRUSTED_PROXY_CIDRS_TOO_BROAD');
    expect(() => validateProductionConfig(validProductionEnv({ TRUSTED_PROXY_CIDRS: '::/0' })))
      .toThrow('TRUSTED_PROXY_CIDRS_TOO_BROAD');
  });

  it.each(['0', '31', 'not-a-number'])('bounds the session lifetime: %s', ttl => {
    expect(() => validateProductionConfig(validProductionEnv({ SESSION_TTL_DAYS: ttl })))
      .toThrow('SESSION_TTL_DAYS_INVALID');
  });

  it('never includes secret values in validation errors', () => {
    const leaked = 'replace-with-super-sensitive-value';
    try {
      validateProductionConfig(validProductionEnv({ RUNTIME_TICKET_SECRET: leaked }));
      throw new Error('expected validation to fail');
    } catch (error) {
      expect(String(error)).not.toContain(leaked);
      expect(String(error)).toContain('RUNTIME_TICKET_SECRET_REQUIRED');
    }
  });
});
