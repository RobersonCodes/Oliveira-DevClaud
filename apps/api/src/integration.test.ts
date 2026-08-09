import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@oliveira/database';
import { buildApp } from './app.js';

// Real Fastify app + real Postgres via app.inject() — no mocked routes, no mocked Prisma. Exercises
// the actual register -> session cookie -> RBAC-gated route chain exactly as a browser would.
let app: FastifyInstance;
const createdUserIds: string[] = [];
const createdOrgIds: string[] = [];

beforeAll(async () => {
  app = await buildApp({ logger: false, disableRateLimit: true });
  await app.ready();
}, 30_000);

afterEach(async () => {
  while (createdOrgIds.length) await prisma.organization.delete({ where: { id: createdOrgIds.pop()! } }).catch(() => undefined);
  while (createdUserIds.length) await prisma.user.delete({ where: { id: createdUserIds.pop()! } }).catch(() => undefined);
});

afterAll(async () => {
  await app.close();
});

function credentials() {
  return { email: `${crypto.randomUUID()}@example.test`, password: 'Correct-Horse-Battery-9', name: 'Test User' };
}

async function registerUser(overrides: Partial<ReturnType<typeof credentials>> = {}) {
  const body = { ...credentials(), ...overrides };
  const response = await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: body });
  expect(response.statusCode).toBe(201);
  const user = response.json();
  createdUserIds.push(user.id);
  const cookie = response.cookies.find(c => c.name === 'odc_session');
  if (!cookie) throw new Error('Registration did not set a session cookie');
  const org = await prisma.organizationMember.findFirstOrThrow({ where: { userId: user.id }, select: { organizationId: true } });
  createdOrgIds.push(org.organizationId);
  return { user, body, sessionCookie: `${cookie.name}=${cookie.value}`, organizationId: org.organizationId };
}

describe('auth flow — register / login / session / logout (real Postgres)', () => {
  it('registers a user, creates their organization as OWNER, and returns a usable session cookie', async () => {
    const { user, sessionCookie, organizationId } = await registerUser();
    const me = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie: sessionCookie } });
    expect(me.statusCode).toBe(200);
    const meBody = me.json();
    expect(meBody.id).toBe(user.id);
    expect(meBody.memberships).toEqual([{ organizationId, role: 'OWNER' }]);
  });

  it('rejects registration with an email that is already in use', async () => {
    const { body } = await registerUser();
    const dup = await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: { ...body, name: 'Someone Else' } });
    expect(dup.statusCode).toBe(409);
  });

  it('logs in with correct credentials and rejects incorrect ones', async () => {
    const { body } = await registerUser();
    const wrong = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: body.email, password: 'totally-wrong-password' } });
    expect(wrong.statusCode).toBe(401);

    const right = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: body.email, password: body.password } });
    expect(right.statusCode).toBe(200);
    expect(right.cookies.some(c => c.name === 'odc_session')).toBe(true);
  });

  it('logout clears the session so /me stops working with the old cookie', async () => {
    const { sessionCookie } = await registerUser();
    const before = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie: sessionCookie } });
    expect(before.statusCode).toBe(200);

    const logout = await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { cookie: sessionCookie } });
    expect(logout.statusCode).toBe(204);

    const after = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie: sessionCookie } });
    expect(after.statusCode).toBe(401);
  });

  it('/me without a session cookie is unauthorized', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/auth/me' });
    expect(response.statusCode).toBe(401);
  });
});

describe('projects — RBAC-gated routes (real Postgres)', () => {
  it('an OWNER can create a project in their own organization and read it back', async () => {
    const { sessionCookie, organizationId } = await registerUser();
    const create = await app.inject({
      method: 'POST', url: '/api/v1/projects', headers: { cookie: sessionCookie },
      payload: { organizationId, name: 'Checkout Service' }
    });
    expect(create.statusCode).toBe(201);
    const project = create.json();
    expect(project.slug).toBe('checkout-service');

    const list = await app.inject({ method: 'GET', url: `/api/v1/projects?organizationId=${organizationId}`, headers: { cookie: sessionCookie } });
    expect(list.statusCode).toBe(200);
    expect(list.json().map((p: { id: string }) => p.id)).toContain(project.id);

    const get = await app.inject({ method: 'GET', url: `/api/v1/projects/${project.id}`, headers: { cookie: sessionCookie } });
    expect(get.statusCode).toBe(200);
    expect(get.json().id).toBe(project.id);
  });

  it('a user with no membership in the organization is forbidden from creating or listing its projects', async () => {
    const owner = await registerUser();
    const outsider = await registerUser();

    const create = await app.inject({
      method: 'POST', url: '/api/v1/projects', headers: { cookie: outsider.sessionCookie },
      payload: { organizationId: owner.organizationId, name: 'Should Not Exist' }
    });
    expect(create.statusCode).toBe(403);

    const list = await app.inject({ method: 'GET', url: `/api/v1/projects?organizationId=${owner.organizationId}`, headers: { cookie: outsider.sessionCookie } });
    expect(list.statusCode).toBe(403);
  });

  it('an unauthenticated request is rejected before any RBAC check', async () => {
    const { organizationId } = await registerUser();
    const response = await app.inject({ method: 'GET', url: `/api/v1/projects?organizationId=${organizationId}` });
    expect(response.statusCode).toBe(401);
  });

  it('duplicate project names in the same organization get an incrementing slug, not a collision', async () => {
    const { sessionCookie, organizationId } = await registerUser();
    const first = await app.inject({ method: 'POST', url: '/api/v1/projects', headers: { cookie: sessionCookie }, payload: { organizationId, name: 'API Gateway' } });
    const second = await app.inject({ method: 'POST', url: '/api/v1/projects', headers: { cookie: sessionCookie }, payload: { organizationId, name: 'API Gateway' } });
    expect(first.json().slug).toBe('api-gateway');
    expect(second.json().slug).toBe('api-gateway-1');
  });
});

describe('organizations — membership-scoped listing (real Postgres)', () => {
  it('only returns organizations the caller is a member of', async () => {
    const mine = await registerUser();
    const other = await registerUser();
    const list = await app.inject({ method: 'GET', url: '/api/v1/organizations', headers: { cookie: mine.sessionCookie } });
    expect(list.statusCode).toBe(200);
    const ids = list.json().map((o: { id: string }) => o.id);
    expect(ids).toContain(mine.organizationId);
    expect(ids).not.toContain(other.organizationId);
  });
});

describe('rate limiting — the /register route\'s stricter per-route limit actually engages', () => {
  let limitedApp: FastifyInstance;
  const limitedUserIds: string[] = [];

  beforeAll(async () => {
    limitedApp = await buildApp({ logger: false });
    await limitedApp.ready();
  }, 30_000);

  afterAll(async () => {
    const memberships = await prisma.organizationMember.findMany({ where: { userId: { in: limitedUserIds } } });
    for (const m of memberships) await prisma.organization.delete({ where: { id: m.organizationId } }).catch(() => undefined);
    for (const id of limitedUserIds) await prisma.user.delete({ where: { id } }).catch(() => undefined);
    await limitedApp.close();
  });

  it('returns 429 after 5 registrations from the same caller within the window', async () => {
    const statusCodes: number[] = [];
    for (let i = 0; i < 6; i++) {
      const response = await limitedApp.inject({ method: 'POST', url: '/api/v1/auth/register', payload: credentials() });
      statusCodes.push(response.statusCode);
      if (response.statusCode === 201) limitedUserIds.push(response.json().id);
    }
    expect(statusCodes.slice(0, 5)).toEqual([201, 201, 201, 201, 201]);
    expect(statusCodes[5]).toBe(429);
  });
});
