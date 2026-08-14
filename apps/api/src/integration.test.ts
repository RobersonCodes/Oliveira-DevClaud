import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { prisma, Role } from '@oliveira/database';
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

  it('makes invalid login responses identical for existing, unknown and locked accounts', async () => {
    const { body } = await registerUser();
    const existing = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: body.email, password: 'totally-wrong-password' } });
    const unknown = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: `${crypto.randomUUID()}@example.test`, password: 'totally-wrong-password' } });
    await prisma.user.update({ where: { id: (await prisma.user.findUniqueOrThrow({ where: { email: body.email } })).id }, data: { failedLoginAttempts: 5, lockedUntil: new Date(Date.now() + 15 * 60_000) } });
    const lockedOut = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: body.email, password: body.password } });

    const fingerprint = (response: typeof existing) => {
      const headers = { ...response.headers };
      delete headers.date;
      return { statusCode: response.statusCode, headers, body: response.body };
    };
    expect(fingerprint(existing)).toEqual(fingerprint(unknown));
    expect(fingerprint(lockedOut)).toEqual(fingerprint(existing));
    expect(fingerprint(existing)).toMatchObject({ statusCode: 401, body: JSON.stringify({ error: 'INVALID_CREDENTIALS' }) });
    expect(lockedOut.json()).not.toHaveProperty('lockedUntil');
  });

  it('logout clears the session so /me stops working with the old cookie', async () => {
    const { sessionCookie, user } = await registerUser();
    const token = decodeURIComponent(sessionCookie.split('=')[1]!);
    const session = await prisma.session.findUniqueOrThrow({ where: { tokenHash: crypto.createHash('sha256').update(token).digest('hex') } });
    const before = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie: sessionCookie } });
    expect(before.statusCode).toBe(200);

    const logout = await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { cookie: sessionCookie } });
    expect(logout.statusCode).toBe(204);

    const after = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie: sessionCookie } });
    expect(after.statusCode).toBe(401);
    await expect(prisma.auditLog.findFirst({ where: { userId: user.id, action: 'USER_LOGOUT', resourceId: session.id } })).resolves.not.toBeNull();
  });

  it('/me without a session cookie is unauthorized', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/auth/me' });
    expect(response.statusCode).toBe(401);
  });

  it('lists devices and revokes another, all other, expired and current sessions immediately', async () => {
    const registered = await registerUser();
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { 'user-agent': 'Oliveira Mobile Test/1.0' },
      payload: { email: registered.body.email, password: registered.body.password }
    });
    expect(login.statusCode).toBe(200);
    const loginCookie = login.cookies.find(cookie => cookie.name === 'odc_session');
    if (!loginCookie) throw new Error('Login did not set a session cookie');
    const currentCookie = `${loginCookie.name}=${loginCookie.value}`;

    const expired = await prisma.session.create({
      data: { userId: registered.user.id, tokenHash: crypto.randomUUID(), expiresAt: new Date(Date.now() - 1_000) }
    });
    const listed = await app.inject({ method: 'GET', url: '/api/v1/auth/sessions', headers: { cookie: currentCookie } });
    expect(listed.statusCode).toBe(200);
    const sessions = listed.json() as Array<{ id: string; current: boolean; userAgent: string | null; tokenHash?: string }>;
    expect(sessions).toHaveLength(2);
    expect(sessions.find(session => session.current)?.userAgent).toBe('Oliveira Mobile Test/1.0');
    expect(sessions.every(session => session.tokenHash === undefined)).toBe(true);
    await expect(prisma.session.findUnique({ where: { id: expired.id } })).resolves.toBeNull();

    const otherSession = sessions.find(session => !session.current)!;
    const revokeOther = await app.inject({ method: 'DELETE', url: `/api/v1/auth/sessions/${otherSession.id}`, headers: { cookie: currentCookie } });
    expect(revokeOther.statusCode).toBe(204);
    await expect(prisma.auditLog.findFirst({ where: { userId: registered.user.id, action: 'SESSION_REVOKED', resourceId: otherSession.id } })).resolves.not.toBeNull();
    expect((await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie: registered.sessionCookie } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie: currentCookie } })).statusCode).toBe(200);

    const thirdLogin = await app.inject({
      method: 'POST', url: '/api/v1/auth/login',
      payload: { email: registered.body.email, password: registered.body.password }
    });
    const third = thirdLogin.cookies.find(cookie => cookie.name === 'odc_session')!;
    const thirdCookie = `${third.name}=${third.value}`;
    const revokeOthers = await app.inject({ method: 'DELETE', url: '/api/v1/auth/sessions/others', headers: { cookie: currentCookie } });
    expect(revokeOthers.statusCode).toBe(200);
    expect(revokeOthers.json()).toEqual({ revoked: 1 });
    await expect(prisma.auditLog.findFirst({ where: { userId: registered.user.id, action: 'SESSIONS_OTHERS_REVOKED' } })).resolves.not.toBeNull();
    expect((await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie: thirdCookie } })).statusCode).toBe(401);

    const current = sessions.find(session => session.current)!;
    const revokeCurrent = await app.inject({ method: 'DELETE', url: `/api/v1/auth/sessions/${current.id}`, headers: { cookie: currentCookie } });
    expect(revokeCurrent.statusCode).toBe(204);
    expect(revokeCurrent.cookies.some(cookie => cookie.name === 'odc_session')).toBe(true);
    expect((await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie: currentCookie } })).statusCode).toBe(401);
  });

  it('does not let one user enumerate or revoke another user session', async () => {
    const owner = await registerUser();
    const outsider = await registerUser();
    const ownerSessions = await app.inject({ method: 'GET', url: '/api/v1/auth/sessions', headers: { cookie: owner.sessionCookie } });
    const ownerSessionId = ownerSessions.json()[0].id as string;
    const denied = await app.inject({ method: 'DELETE', url: `/api/v1/auth/sessions/${ownerSessionId}`, headers: { cookie: outsider.sessionCookie } });
    expect(denied.statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie: owner.sessionCookie } })).statusCode).toBe(200);
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

describe('activity feed + repository promotion (v2.5 schema, real Postgres)', () => {
  it('creating a project with a repositoryUrl also creates a Repository row (project.repositoryUrl is left untouched)', async () => {
    const { sessionCookie, organizationId } = await registerUser();
    const create = await app.inject({
      method: 'POST', url: '/api/v1/projects', headers: { cookie: sessionCookie },
      payload: { organizationId, name: 'Checkout', repositoryUrl: 'https://github.com/example/checkout.git' }
    });
    expect(create.statusCode).toBe(201);
    const project = create.json();
    expect(project.repositoryUrl).toBe('https://github.com/example/checkout.git');

    const repos = await prisma.repository.findMany({ where: { projectId: project.id } });
    expect(repos).toHaveLength(1);
    expect(repos[0]).toMatchObject({ url: 'https://github.com/example/checkout.git', provider: 'GITHUB', defaultBranch: 'main' });
  });

  it('creating a project without a repositoryUrl does not create a Repository row', async () => {
    const { sessionCookie, organizationId } = await registerUser();
    const create = await app.inject({ method: 'POST', url: '/api/v1/projects', headers: { cookie: sessionCookie }, payload: { organizationId, name: 'No Repo Yet' } });
    const project = create.json();
    const repos = await prisma.repository.findMany({ where: { projectId: project.id } });
    expect(repos).toHaveLength(0);
  });

  it('real actions (project creation) show up on the real activity feed, and it is organization-scoped', async () => {
    const { sessionCookie, organizationId } = await registerUser();
    const other = await registerUser();

    await app.inject({ method: 'POST', url: '/api/v1/projects', headers: { cookie: sessionCookie }, payload: { organizationId, name: 'Observed Project' } });

    const feed = await app.inject({ method: 'GET', url: `/api/v1/activity?organizationId=${organizationId}`, headers: { cookie: sessionCookie } });
    expect(feed.statusCode).toBe(200);
    const events = feed.json();
    expect(events.some((e: { type: string }) => e.type === 'project.created')).toBe(true);

    const otherFeed = await app.inject({ method: 'GET', url: `/api/v1/activity?organizationId=${organizationId}`, headers: { cookie: other.sessionCookie } });
    expect(otherFeed.statusCode).toBe(403);
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

describe('secret scopes — cross-tenant resource ownership (real Postgres)', () => {
  it('rejects project/workspace IDs from another organization and accepts the caller tenant', async () => {
    const mine = await registerUser();
    const other = await registerUser();
    const mineProject = await prisma.project.create({ data: { organizationId: mine.organizationId, name: 'Mine', slug: `mine-${crypto.randomUUID()}` } });
    const otherProject = await prisma.project.create({ data: { organizationId: other.organizationId, name: 'Other', slug: `other-${crypto.randomUUID()}` } });
    const otherWorkspace = await prisma.workspace.create({ data: { projectId: otherProject.id } });
    const previousKey = process.env.SECRETS_MASTER_KEY_BASE64;
    process.env.SECRETS_MASTER_KEY_BASE64 = Buffer.alloc(32, 7).toString('base64');
    try {
      const crossProject = await app.inject({
        method: 'POST', url: '/api/v1/secrets', headers: { cookie: mine.sessionCookie },
        payload: { organizationId: mine.organizationId, scope: 'PROJECT', projectId: otherProject.id, kind: 'GENERIC', name: 'CROSS_PROJECT', value: 'never-store-this' }
      });
      expect(crossProject.statusCode).toBe(404);

      const crossWorkspace = await app.inject({
        method: 'POST', url: '/api/v1/secrets', headers: { cookie: mine.sessionCookie },
        payload: { organizationId: mine.organizationId, scope: 'WORKSPACE', workspaceId: otherWorkspace.id, kind: 'GENERIC', name: 'CROSS_WORKSPACE', value: 'never-store-this' }
      });
      expect(crossWorkspace.statusCode).toBe(404);
      expect(await prisma.secret.count({ where: { organizationId: mine.organizationId } })).toBe(0);

      const ownProject = await app.inject({
        method: 'POST', url: '/api/v1/secrets', headers: { cookie: mine.sessionCookie },
        payload: { organizationId: mine.organizationId, scope: 'PROJECT', projectId: mineProject.id, kind: 'GENERIC', name: 'OWN_PROJECT', value: 'stored-only-encrypted' }
      });
      expect(ownProject.statusCode).toBe(201);
      expect(ownProject.json()).not.toHaveProperty('value');
      expect(await prisma.secret.count({ where: { organizationId: mine.organizationId, projectId: mineProject.id } })).toBe(1);
    } finally {
      if (previousKey === undefined) delete process.env.SECRETS_MASTER_KEY_BASE64;
      else process.env.SECRETS_MASTER_KEY_BASE64 = previousKey;
    }
  });

  it('rejects ambiguous resource IDs for every secret scope', async () => {
    const mine = await registerUser();
    const project = await prisma.project.create({ data: { organizationId: mine.organizationId, name: 'Shape', slug: `shape-${crypto.randomUUID()}` } });
    const workspace = await prisma.workspace.create({ data: { projectId: project.id } });
    const invalidPayloads = [
      { scope: 'ORGANIZATION', projectId: project.id },
      { scope: 'PROJECT' },
      { scope: 'PROJECT', projectId: project.id, workspaceId: workspace.id },
      { scope: 'WORKSPACE' },
      { scope: 'WORKSPACE', projectId: project.id, workspaceId: workspace.id }
    ];
    for (const [index, invalid] of invalidPayloads.entries()) {
      const response = await app.inject({
        method: 'POST', url: '/api/v1/secrets', headers: { cookie: mine.sessionCookie },
        payload: { organizationId: mine.organizationId, kind: 'GENERIC', name: `INVALID_${index}`, value: 'not-stored', ...invalid }
      });
      expect(response.statusCode).toBe(400);
    }
    expect(await prisma.secret.count({ where: { organizationId: mine.organizationId } })).toBe(0);
  });
});

describe('complete HTTP authorization matrix (real Postgres, real routes)', () => {
  it('keeps authenticated, tenant roles and host-admin privileges independent', async () => {
    const owner = await registerUser();
    const member = await registerUser();
    const developer = await registerUser();
    const admin = await registerUser();
    const hostAdmin = await registerUser();
    await prisma.organizationMember.createMany({ data: [
      { organizationId: owner.organizationId, userId: developer.user.id, role: Role.DEVELOPER },
      { organizationId: owner.organizationId, userId: admin.user.id, role: Role.ADMIN }
    ] });

    const actors = [
      { name: 'anonymous', cookie: undefined },
      // "member" means an authenticated account with no membership in the target organization.
      { name: 'member', cookie: member.sessionCookie },
      { name: 'developer', cookie: developer.sessionCookie },
      { name: 'admin', cookie: admin.sessionCookie },
      { name: 'owner', cookie: owner.sessionCookie },
      // Host administration is orthogonal and never grants implicit access to a tenant.
      { name: 'host-admin', cookie: hostAdmin.sessionCookie }
    ] as const;
    const headers = (cookie: string | undefined) => cookie ? { cookie } : undefined;

    const expectedAuthenticated = [401, 200, 200, 200, 200, 200];
    const expectedDeveloper = [401, 403, 200, 200, 200, 403];
    const expectedAdmin = [401, 403, 403, 201, 201, 403];
    const expectedOwner = [401, 403, 403, 403, 204, 403];
    const expectedHostAdmin = [401, 403, 403, 403, 403, 200];

    const previousHostAdmins = process.env.HOST_ADMIN_EMAILS;
    process.env.HOST_ADMIN_EMAILS = hostAdmin.body.email;
    try {
      for (const [index, actor] of actors.entries()) {
        const authOnly = await app.inject({ method: 'GET', url: '/api/v1/organizations', headers: headers(actor.cookie) });
        expect(authOnly.statusCode, `${actor.name} -> authenticated`).toBe(expectedAuthenticated[index]);

        const developerRoute = await app.inject({
          method: 'GET',
          url: `/api/v1/projects?organizationId=${owner.organizationId}`,
          headers: headers(actor.cookie)
        });
        expect(developerRoute.statusCode, `${actor.name} -> DEVELOPER`).toBe(expectedDeveloper[index]);

        const adminRoute = await app.inject({
          method: 'POST',
          url: '/api/v1/projects',
          headers: headers(actor.cookie),
          payload: { organizationId: owner.organizationId, name: `Matrix ${actor.name}` }
        });
        expect(adminRoute.statusCode, `${actor.name} -> ADMIN`).toBe(expectedAdmin[index]);

        const disposableProject = await prisma.project.create({
          data: { organizationId: owner.organizationId, name: `Delete ${actor.name}`, slug: `delete-${actor.name}-${crypto.randomUUID()}` }
        });
        const ownerRoute = await app.inject({
          method: 'DELETE',
          url: `/api/v1/projects/${disposableProject.id}`,
          headers: headers(actor.cookie)
        });
        expect(ownerRoute.statusCode, `${actor.name} -> OWNER`).toBe(expectedOwner[index]);

        const hostRoute = await app.inject({ method: 'GET', url: '/api/v1/system', headers: headers(actor.cookie) });
        expect(hostRoute.statusCode, `${actor.name} -> HOST_ADMIN`).toBe(expectedHostAdmin[index]);
      }
    } finally {
      if (previousHostAdmins === undefined) delete process.env.HOST_ADMIN_EMAILS;
      else process.env.HOST_ADMIN_EMAILS = previousHostAdmins;
    }
  });
});

describe('host metrics — platform-operator-only routes (real Postgres)', () => {
  it('rejects anonymous requests to both host metrics endpoints', async () => {
    const legacy = await app.inject({ method: 'GET', url: '/api/v1/system' });
    const summary = await app.inject({ method: 'GET', url: '/api/v1/system/metrics-summary' });
    expect(legacy.statusCode).toBe(401);
    expect(summary.statusCode).toBe(401);
  });

  it('does not treat an organization OWNER as a host operator', async () => {
    const previous = process.env.HOST_ADMIN_EMAILS;
    delete process.env.HOST_ADMIN_EMAILS;
    try {
      const owner = await registerUser();
      const legacy = await app.inject({ method: 'GET', url: '/api/v1/system', headers: { cookie: owner.sessionCookie } });
      expect(legacy.statusCode).toBe(503);
    } finally {
      if (previous === undefined) delete process.env.HOST_ADMIN_EMAILS;
      else process.env.HOST_ADMIN_EMAILS = previous;
    }
  });

  it('allows only an explicitly configured host operator', async () => {
    const previous = process.env.HOST_ADMIN_EMAILS;
    const operator = await registerUser();
    const otherOwner = await registerUser();
    process.env.HOST_ADMIN_EMAILS = operator.body.email.toUpperCase();
    try {
      const denied = await app.inject({ method: 'GET', url: '/api/v1/system', headers: { cookie: otherOwner.sessionCookie } });
      expect(denied.statusCode).toBe(403);
      const legacy = await app.inject({ method: 'GET', url: '/api/v1/system', headers: { cookie: operator.sessionCookie } });
      expect(legacy.statusCode).toBe(200);
      expect(legacy.json()).toHaveProperty('workspaces');
      const summary = await app.inject({ method: 'GET', url: '/api/v1/system/metrics-summary', headers: { cookie: operator.sessionCookie } });
      expect(summary.statusCode).toBe(200);
      expect(summary.json()).toHaveProperty('host.cpus');
      expect(summary.json()).toHaveProperty('queues.status', 'ok');
      expect(summary.json().queues.queues.map((queue: { name: string }) => queue.name)).toEqual([
        'oliveira-orchestrations',
        'oliveira-setup'
      ]);
    } finally {
      if (previous === undefined) delete process.env.HOST_ADMIN_EMAILS;
      else process.env.HOST_ADMIN_EMAILS = previous;
    }
  });
});

describe('agent cancellation — keeps AgentTask, OrchestrationStep and Orchestration in sync (real Postgres)', () => {
  it('cancelling an agent tied to a RUNNING orchestration step cancels the step and the orchestration too', async () => {
    const { sessionCookie, organizationId } = await registerUser();
    const project = await app.inject({ method: 'POST', url: '/api/v1/projects', headers: { cookie: sessionCookie }, payload: { organizationId, name: 'Cancel Sync Project' } });
    expect(project.statusCode).toBe(201);

    // Fixture built directly against Postgres (not via POST /workspaces) so this test doesn't need a
    // real Docker daemon: the behavior under test is DB-state synchronization, and the route already
    // swallows engine.cancel() failures (`.catch(() => undefined)`) for exactly this reason — a
    // workspace whose container no longer exists must still update its records correctly.
    const workspace = await prisma.workspace.create({ data: { projectId: project.json().id, containerId: 'test-container-not-real', status: 'RUNNING' } });
    const orchestration = await prisma.orchestration.create({ data: { workspaceId: workspace.id, title: 'Test orchestration', objective: 'Prove cancel sync', status: 'RUNNING', startedAt: new Date() } });
    const task = await prisma.agentTask.create({ data: { workspaceId: workspace.id, agent: 'CLAUDE', title: 'Do the thing', prompt: 'Do the thing', status: 'RUNNING', startedAt: new Date() } });
    const step = await prisma.orchestrationStep.create({ data: { orchestrationId: orchestration.id, key: 'do-the-thing', title: 'Do the thing', type: 'AGENT', agent: 'CLAUDE', prompt: 'Do the thing', status: 'RUNNING', agentTaskId: task.id, startedAt: new Date() } });

    const cancel = await app.inject({ method: 'POST', url: `/api/v1/agents/${task.id}/cancel`, headers: { cookie: sessionCookie } });
    expect(cancel.statusCode).toBe(200);

    const [taskAfter, stepAfter, orchestrationAfter] = await Promise.all([
      prisma.agentTask.findUniqueOrThrow({ where: { id: task.id } }),
      prisma.orchestrationStep.findUniqueOrThrow({ where: { id: step.id } }),
      prisma.orchestration.findUniqueOrThrow({ where: { id: orchestration.id } })
    ]);
    expect(taskAfter.status).toBe('CANCELLED');
    expect(stepAfter.status).toBe('CANCELLED');
    expect(orchestrationAfter.status).toBe('CANCELLED');
  });

  it('cancelling a standalone agent task with no orchestration step still succeeds', async () => {
    const { sessionCookie, organizationId } = await registerUser();
    const project = await app.inject({ method: 'POST', url: '/api/v1/projects', headers: { cookie: sessionCookie }, payload: { organizationId, name: 'Standalone Cancel Project' } });
    const workspace = await prisma.workspace.create({ data: { projectId: project.json().id, containerId: 'test-container-not-real', status: 'RUNNING' } });
    const task = await prisma.agentTask.create({ data: { workspaceId: workspace.id, agent: 'CODEX', title: 'Ad-hoc task', prompt: 'Ad-hoc task', status: 'RUNNING', startedAt: new Date() } });

    const cancel = await app.inject({ method: 'POST', url: `/api/v1/agents/${task.id}/cancel`, headers: { cookie: sessionCookie } });
    expect(cancel.statusCode).toBe(200);
    expect((await prisma.agentTask.findUniqueOrThrow({ where: { id: task.id } })).status).toBe('CANCELLED');
  });

  it('never overwrites a task/step/orchestration that a concurrent worker tick already completed', async () => {
    const { sessionCookie, organizationId } = await registerUser();
    const project = await app.inject({ method: 'POST', url: '/api/v1/projects', headers: { cookie: sessionCookie }, payload: { organizationId, name: 'Race Cancel Project' } });
    const workspace = await prisma.workspace.create({ data: { projectId: project.json().id, containerId: 'test-container-not-real', status: 'RUNNING' } });
    const orchestration = await prisma.orchestration.create({ data: { workspaceId: workspace.id, title: 'Test orchestration', objective: 'Prove cancel never clobbers a real completion', status: 'RUNNING', startedAt: new Date() } });
    const task = await prisma.agentTask.create({ data: { workspaceId: workspace.id, agent: 'CLAUDE', title: 'Finishes first', prompt: 'Finishes first', status: 'RUNNING', startedAt: new Date() } });
    const step = await prisma.orchestrationStep.create({ data: { orchestrationId: orchestration.id, key: 'finishes-first', title: 'Finishes first', type: 'AGENT', agent: 'CLAUDE', prompt: 'Finishes first', status: 'RUNNING', agentTaskId: task.id, startedAt: new Date() } });

    // Simulate the worker's tick() winning the race and completing the step/task/orchestration
    // *between* the API reading the task and writing its cancellation — the exact window the CAS
    // guard in the /cancel route has to defend.
    await prisma.$transaction([
      prisma.agentTask.update({ where: { id: task.id }, data: { status: 'COMPLETED', exitCode: 0, finishedAt: new Date(), reviewStatus: 'READY' } }),
      prisma.orchestrationStep.update({ where: { id: step.id }, data: { status: 'COMPLETED', exitCode: 0, finishedAt: new Date() } }),
      prisma.orchestration.update({ where: { id: orchestration.id }, data: { status: 'WAITING_REVIEW' } })
    ]);

    const cancel = await app.inject({ method: 'POST', url: `/api/v1/agents/${task.id}/cancel`, headers: { cookie: sessionCookie } });
    expect(cancel.statusCode).toBe(200);

    const [taskAfter, stepAfter, orchestrationAfter] = await Promise.all([
      prisma.agentTask.findUniqueOrThrow({ where: { id: task.id } }),
      prisma.orchestrationStep.findUniqueOrThrow({ where: { id: step.id } }),
      prisma.orchestration.findUniqueOrThrow({ where: { id: orchestration.id } })
    ]);
    expect(taskAfter.status).toBe('COMPLETED');
    expect(stepAfter.status).toBe('COMPLETED');
    expect(orchestrationAfter.status).toBe('WAITING_REVIEW');
  });
});

describe('critical transition CAS and idempotency (real Postgres + Redis)', () => {
  it('starts a draft orchestration once and treats a repeated start as idempotent', async () => {
    const owner = await registerUser();
    const project = await prisma.project.create({ data: { organizationId: owner.organizationId, name: 'Start CAS', slug: `start-cas-${crypto.randomUUID()}` } });
    const workspace = await prisma.workspace.create({ data: { projectId: project.id } });
    const orchestration = await prisma.orchestration.create({ data: { workspaceId: workspace.id, title: 'Start once', objective: 'Prove idempotent start', status: 'DRAFT' } });

    const first = await app.inject({ method: 'POST', url: `/api/v1/orchestrations/${orchestration.id}/start`, headers: { cookie: owner.sessionCookie } });
    const second = await app.inject({ method: 'POST', url: `/api/v1/orchestrations/${orchestration.id}/start`, headers: { cookie: owner.sessionCookie } });

    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ ok: true, alreadyStarted: false });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ ok: true, alreadyStarted: true });
    expect((await prisma.orchestration.findUniqueOrThrow({ where: { id: orchestration.id } })).status).toBe('QUEUED');
    expect(await prisma.auditLog.count({ where: { resourceId: orchestration.id, action: 'ORCHESTRATION_STARTED' } })).toBe(1);
  });

  it('serializes concurrent start/cancel and never resurrects a cancelled orchestration', async () => {
    const owner = await registerUser();
    const project = await prisma.project.create({ data: { organizationId: owner.organizationId, name: 'Race CAS', slug: `race-cas-${crypto.randomUUID()}` } });
    const workspace = await prisma.workspace.create({ data: { projectId: project.id } });
    const orchestration = await prisma.orchestration.create({ data: { workspaceId: workspace.id, title: 'Race safely', objective: 'Prove cancellation wins terminally', status: 'DRAFT' } });

    const [start, cancel] = await Promise.all([
      app.inject({ method: 'POST', url: `/api/v1/orchestrations/${orchestration.id}/start`, headers: { cookie: owner.sessionCookie } }),
      app.inject({ method: 'POST', url: `/api/v1/orchestrations/${orchestration.id}/cancel`, headers: { cookie: owner.sessionCookie } })
    ]);

    expect([200, 409]).toContain(start.statusCode);
    expect(cancel.statusCode).toBe(200);
    expect((await prisma.orchestration.findUniqueOrThrow({ where: { id: orchestration.id } })).status).toBe('CANCELLED');
    const restart = await app.inject({ method: 'POST', url: `/api/v1/orchestrations/${orchestration.id}/start`, headers: { cookie: owner.sessionCookie } });
    expect(restart.statusCode).toBe(409);
    expect((await prisma.orchestration.findUniqueOrThrow({ where: { id: orchestration.id } })).status).toBe('CANCELLED');
  });

  it('never lets cancellation overwrite terminal orchestration or setup completion', async () => {
    const owner = await registerUser();
    const project = await prisma.project.create({ data: { organizationId: owner.organizationId, name: 'Terminal CAS', slug: `terminal-cas-${crypto.randomUUID()}` } });
    const workspace = await prisma.workspace.create({ data: { projectId: project.id } });
    const orchestration = await prisma.orchestration.create({ data: { workspaceId: workspace.id, title: 'Already done', objective: 'Stay complete', status: 'COMPLETED', finishedAt: new Date() } });
    const setup = await prisma.setupJob.create({ data: { workspaceId: workspace.id, organizationId: owner.organizationId, status: 'READY', stage: 'READY', progress: 100, finishedAt: new Date() } });

    const orchestrationCancel = await app.inject({ method: 'POST', url: `/api/v1/orchestrations/${orchestration.id}/cancel`, headers: { cookie: owner.sessionCookie } });
    const setupCancel = await app.inject({ method: 'POST', url: `/api/v1/setup/jobs/${setup.id}/cancel`, headers: { cookie: owner.sessionCookie } });

    expect(orchestrationCancel.statusCode).toBe(409);
    expect(setupCancel.statusCode).toBe(409);
    expect((await prisma.orchestration.findUniqueOrThrow({ where: { id: orchestration.id } })).status).toBe('COMPLETED');
    expect((await prisma.setupJob.findUniqueOrThrow({ where: { id: setup.id } })).status).toBe('READY');
  });

  it('makes setup cancellation idempotent without duplicating audit events', async () => {
    const owner = await registerUser();
    const project = await prisma.project.create({ data: { organizationId: owner.organizationId, name: 'Setup CAS', slug: `setup-cas-${crypto.randomUUID()}` } });
    const workspace = await prisma.workspace.create({ data: { projectId: project.id } });
    const setup = await prisma.setupJob.create({ data: { workspaceId: workspace.id, organizationId: owner.organizationId, status: 'RUNNING', stage: 'INSTALLING_DEPS' } });

    const first = await app.inject({ method: 'POST', url: `/api/v1/setup/jobs/${setup.id}/cancel`, headers: { cookie: owner.sessionCookie } });
    const second = await app.inject({ method: 'POST', url: `/api/v1/setup/jobs/${setup.id}/cancel`, headers: { cookie: owner.sessionCookie } });

    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(202);
    expect((await prisma.setupJob.findUniqueOrThrow({ where: { id: setup.id } })).status).toBe('CANCEL_REQUESTED');
    expect(await prisma.auditLog.count({ where: { resourceId: setup.id, action: 'WORKSPACE_PROVISION_CANCEL_REQUESTED' } })).toBe(1);
  });

  it('claims agent review rejection once and makes repeats idempotent', async () => {
    const owner = await registerUser();
    const project = await prisma.project.create({ data: { organizationId: owner.organizationId, name: 'Agent Review CAS', slug: `agent-review-cas-${crypto.randomUUID()}` } });
    const workspace = await prisma.workspace.create({ data: { projectId: project.id, containerId: 'test-container-not-used' } });
    const task = await prisma.agentTask.create({ data: { workspaceId: workspace.id, agent: 'CODEX', title: 'Review once', prompt: 'Reject exactly once', status: 'COMPLETED', reviewStatus: 'READY', finishedAt: new Date() } });

    const first = await app.inject({ method: 'POST', url: `/api/v1/agents/${task.id}/reject`, headers: { cookie: owner.sessionCookie } });
    const second = await app.inject({ method: 'POST', url: `/api/v1/agents/${task.id}/reject`, headers: { cookie: owner.sessionCookie } });

    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ ok: true, alreadyRejected: false });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ ok: true, alreadyRejected: true });
    expect((await prisma.agentTask.findUniqueOrThrow({ where: { id: task.id } })).reviewStatus).toBe('REJECTED');
    expect(await prisma.auditLog.count({ where: { resourceId: task.id, action: 'AGENT_CHANGES_REJECTED' } })).toBe(1);
  });
});

describe('dead-letter review and manual reprocessing (real Postgres + Redis)', () => {
  async function createDeadLetterFixture() {
    const owner = await registerUser();
    const project = await prisma.project.create({ data: { organizationId: owner.organizationId, name: 'DLQ project', slug: `dlq-${crypto.randomUUID()}` } });
    const workspace = await prisma.workspace.create({ data: { projectId: project.id } });
    const setup = await prisma.setupJob.create({ data: { workspaceId: workspace.id, organizationId: owner.organizationId, status: 'FAILED', stage: 'FAILED', errorCode: 'WORKSPACE_HAS_NO_CONTAINER', finishedAt: new Date() } });
    const deadLetter = await prisma.deadLetterJob.create({ data: { organizationId: owner.organizationId, workspaceId: workspace.id, queue: 'SETUP', sourceId: setup.id, sourceJobId: `setup-${crypto.randomUUID()}`, payload: { setupJobId: setup.id }, errorCode: 'WORKSPACE_HAS_NO_CONTAINER', attempts: 1 } });
    return { owner, project, workspace, setup, deadLetter };
  }

  it('lists only an organization administrator\'s sanitized dead letters', async () => {
    const fixture = await createDeadLetterFixture();
    const otherOwner = await registerUser();
    const allowed = await app.inject({ method: 'GET', url: `/api/v1/dead-letters?organizationId=${fixture.owner.organizationId}`, headers: { cookie: fixture.owner.sessionCookie } });
    const denied = await app.inject({ method: 'GET', url: `/api/v1/dead-letters?organizationId=${fixture.owner.organizationId}`, headers: { cookie: otherOwner.sessionCookie } });

    expect(allowed.statusCode).toBe(200);
    expect(allowed.json()).toEqual([expect.objectContaining({ id: fixture.deadLetter.id, payload: { setupJobId: fixture.setup.id }, errorCode: 'WORKSPACE_HAS_NO_CONTAINER' })]);
    expect(JSON.stringify(allowed.json())).not.toContain('errorMessage');
    expect(denied.statusCode).toBe(403);
  });

  it('resolves an open dead letter idempotently and audits only the winning transition', async () => {
    const fixture = await createDeadLetterFixture();
    const url = `/api/v1/dead-letters/${fixture.deadLetter.id}/resolve`;
    const [first, second] = await Promise.all([
      app.inject({ method: 'POST', url, headers: { cookie: fixture.owner.sessionCookie }, payload: { note: 'Reviewed; no retry required' } }),
      app.inject({ method: 'POST', url, headers: { cookie: fixture.owner.sessionCookie }, payload: { note: 'Reviewed concurrently' } })
    ]);

    expect([first.json(), second.json()]).toEqual(expect.arrayContaining([
      { ok: true, alreadyResolved: false },
      { ok: true, alreadyResolved: true }
    ]));
    expect((await prisma.deadLetterJob.findUniqueOrThrow({ where: { id: fixture.deadLetter.id } })).status).toBe('RESOLVED');
    expect(await prisma.auditLog.count({ where: { action: 'DEAD_LETTER_RESOLVED', resourceId: fixture.deadLetter.id } })).toBe(1);
  });

  it('serializes concurrent requeue requests into one child SetupJob and one audit event', async () => {
    const fixture = await createDeadLetterFixture();
    const url = `/api/v1/dead-letters/${fixture.deadLetter.id}/requeue`;
    const [first, second] = await Promise.all([
      app.inject({ method: 'POST', url, headers: { cookie: fixture.owner.sessionCookie } }),
      app.inject({ method: 'POST', url, headers: { cookie: fixture.owner.sessionCookie } })
    ]);

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    const deadLetter = await prisma.deadLetterJob.findUniqueOrThrow({ where: { id: fixture.deadLetter.id } });
    const children = await prisma.setupJob.findMany({ where: { parentJobId: fixture.setup.id } });
    expect(deadLetter.status).toBe('REQUEUED');
    expect(children).toHaveLength(1);
    expect(deadLetter.requeuedSourceId).toBe(children[0]!.id);
    expect(await prisma.auditLog.count({ where: { action: 'DEAD_LETTER_REQUEUED', resourceId: fixture.deadLetter.id } })).toBe(1);
  });

  it('does not requeue a manually resolved dead letter', async () => {
    const fixture = await createDeadLetterFixture();
    await prisma.deadLetterJob.update({ where: { id: fixture.deadLetter.id }, data: { status: 'RESOLVED', resolutionNote: 'closed' } });
    const response = await app.inject({ method: 'POST', url: `/api/v1/dead-letters/${fixture.deadLetter.id}/requeue`, headers: { cookie: fixture.owner.sessionCookie } });
    expect(response.statusCode).toBe(409);
    expect(await prisma.setupJob.count({ where: { parentJobId: fixture.setup.id } })).toBe(0);
  });
});

describe('job duration quota contracts (real Postgres + Redis)', () => {
  it('persists bounded deadlines for direct agents, orchestrations and setup jobs', async () => {
    const owner = await registerUser();
    const project = await prisma.project.create({ data: { organizationId: owner.organizationId, name: 'Quota project', slug: `quota-${crypto.randomUUID()}` } });
    const workspace = await prisma.workspace.create({ data: { projectId: project.id, containerId: 'quota-container-not-used', status: 'RUNNING', runtimeStartedAt: new Date() } });

    const agent = await app.inject({ method: 'POST', url: '/api/v1/agents', headers: { cookie: owner.sessionCookie }, payload: { workspaceId: workspace.id, agent: 'CODEX', title: 'Bounded agent', prompt: 'Respect the deadline', maxDurationSeconds: 90, startNow: false } });
    const orchestration = await app.inject({ method: 'POST', url: '/api/v1/orchestrations', headers: { cookie: owner.sessionCookie }, payload: { workspaceId: workspace.id, title: 'Bounded orchestration', objective: 'Respect the deadline', maxDurationSeconds: 120, startNow: false, steps: [{ key: 'typecheck', title: 'Typecheck', type: 'SYSTEM', command: 'npm run typecheck' }] } });
    const setup = await app.inject({ method: 'POST', url: `/api/v1/setup/${workspace.id}/provision`, headers: { cookie: owner.sessionCookie }, payload: { clone: false, install: false, startIde: false, registerPorts: false, maxDurationSeconds: 180 } });

    expect(agent.statusCode).toBe(201);
    expect(agent.json().maxDurationSeconds).toBe(90);
    expect(orchestration.statusCode).toBe(201);
    expect(orchestration.json().maxDurationSeconds).toBe(120);
    expect(setup.statusCode).toBe(202);
    expect(setup.json().maxDurationSeconds).toBe(180);

    const cancelled = await app.inject({ method: 'POST', url: `/api/v1/setup/jobs/${setup.json().id}/cancel`, headers: { cookie: owner.sessionCookie } });
    expect(cancelled.statusCode).toBe(200);
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
