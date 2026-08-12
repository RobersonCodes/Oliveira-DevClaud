import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { registerRateLimits } from './lib/rateLimits.js';

describe('layered rate limits', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('keeps health checks available while limiting ordinary anonymous traffic by IP', async () => {
    app = Fastify({ logger: false });
    await registerRateLimits(app, { ipMax: 2, userMax: 100, organizationMax: 100 });
    app.get('/health', { config: { rateLimit: false } }, async () => ({ ok: true }));
    app.get('/ordinary', async () => ({ ok: true }));

    expect((await app.inject('/ordinary')).statusCode).toBe(200);
    expect((await app.inject('/ordinary')).statusCode).toBe(200);
    expect((await app.inject('/ordinary')).statusCode).toBe(429);
    expect((await app.inject('/health')).statusCode).toBe(200);
  });

  it('preserves the stricter per-IP register and login route budgets', async () => {
    app = await buildApp({ logger: false, trustedProxies: false });
    const invalidCredentials = { method: 'POST' as const, payload: {} };

    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await app.inject({ ...invalidCredentials, url: '/api/v1/auth/register' })).statusCode).toBe(400);
    }
    const blockedRegister = await app.inject({ ...invalidCredentials, url: '/api/v1/auth/register' });
    expect(blockedRegister.statusCode).toBe(429);
    expect(blockedRegister.headers['retry-after']).toBeDefined();

    for (let attempt = 0; attempt < 8; attempt += 1) {
      expect((await app.inject({ ...invalidCredentials, url: '/api/v1/auth/login' })).statusCode).toBe(400);
    }
    expect((await app.inject({ ...invalidCredentials, url: '/api/v1/auth/login' })).statusCode).toBe(429);
  });

  it('limits one authenticated user across different IPs and organizations', async () => {
    app = Fastify({ logger: false });
    await registerRateLimits(app, { ipMax: 100, userMax: 2, organizationMax: 100 });
    app.get('/protected', async request => {
      const user = String(request.headers['x-test-user']);
      const organization = String(request.headers['x-test-organization']);
      await request.enforceIdentityRateLimit('user', user);
      await request.enforceIdentityRateLimit('organization', organization);
      return { ok: true };
    });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await app.inject({
        url: '/protected',
        remoteAddress: `198.51.100.${attempt + 1}`,
        headers: { 'x-test-user': 'user-a', 'x-test-organization': `org-${attempt}` }
      });
      expect(response.statusCode).toBe(200);
    }
    const blocked = await app.inject({
      url: '/protected',
      remoteAddress: '198.51.100.30',
      headers: { 'x-test-user': 'user-a', 'x-test-organization': 'org-3' }
    });
    expect(blocked.statusCode).toBe(429);
  });

  it('limits aggregate organization traffic across different users and IPs', async () => {
    app = Fastify({ logger: false });
    await registerRateLimits(app, { ipMax: 100, userMax: 100, organizationMax: 2 });
    app.get('/protected', async request => {
      await request.enforceIdentityRateLimit('user', String(request.headers['x-test-user']));
      await request.enforceIdentityRateLimit('organization', 'org-shared');
      return { ok: true };
    });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await app.inject({
        url: '/protected',
        remoteAddress: `203.0.113.${attempt + 1}`,
        headers: { 'x-test-user': `user-${attempt}` }
      });
      expect(response.statusCode).toBe(200);
    }
    const blocked = await app.inject({
      url: '/protected',
      remoteAddress: '203.0.113.30',
      headers: { 'x-test-user': 'user-3' }
    });
    expect(blocked.statusCode).toBe(429);
  });

  it('charges the same identity only once when authorization is checked repeatedly in one request', async () => {
    app = Fastify({ logger: false });
    await registerRateLimits(app, { ipMax: 100, userMax: 1, organizationMax: 1 });
    app.get('/protected', async request => {
      await request.enforceIdentityRateLimit('user', 'user-a');
      await request.enforceIdentityRateLimit('user', 'user-a');
      await request.enforceIdentityRateLimit('organization', 'org-a');
      await request.enforceIdentityRateLimit('organization', 'org-a');
      return { ok: true };
    });

    expect((await app.inject('/protected')).statusCode).toBe(200);
    expect((await app.inject('/protected')).statusCode).toBe(429);
  });

  it('returns a scoped retry response through the real API error boundary', async () => {
    app = await buildApp({ logger: false, trustedProxies: false });
    app.get('/__test/identity-limit', async request => {
      await request.enforceIdentityRateLimit('user', 'user-at-limit');
      return { ok: true };
    });

    for (let attempt = 0; attempt < 120; attempt += 1) {
      const response = await app.inject({
        url: '/__test/identity-limit',
        remoteAddress: `198.51.${Math.floor(attempt / 250)}.${(attempt % 250) + 1}`
      });
      expect(response.statusCode).toBe(200);
    }
    const blocked = await app.inject({
      url: '/__test/identity-limit',
      remoteAddress: '203.0.113.250'
    });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers['retry-after']).toBeDefined();
    expect(blocked.json()).toEqual({ error: 'RATE_LIMIT_EXCEEDED', scope: 'user' });
  });
});
