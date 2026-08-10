import crypto from 'node:crypto';
import WebSocket, { WebSocketServer } from 'ws';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '@oliveira/database';
import { DockerIdeEngine } from '@oliveira/ide-engine';
import { buildApp } from './app.js';

const RUNTIME_BASE_DOMAIN = 'runtime.localhost';

let app: FastifyInstance;
const createdUserIds: string[] = [];
const createdOrgIds: string[] = [];

beforeAll(async () => {
  process.env.RUNTIME_BASE_DOMAIN = RUNTIME_BASE_DOMAIN;
  process.env.RUNTIME_TICKET_SECRET = 'test-runtime-ticket-secret-do-not-use-in-prod';
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

// vitest.config.ts sets `restoreMocks: true` (auto-restores before each test) — spies must be
// (re)installed in a `beforeEach`, not `beforeAll`, or they're gone by the time the test body runs.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let internalHostSpy: any;
beforeEach(() => {
  internalHostSpy = vi.spyOn(DockerIdeEngine.prototype, 'internalHost').mockResolvedValue('127.0.0.1');
});

async function registerUser() {
  const email = `${crypto.randomUUID()}@example.test`;
  const response = await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: { email, password: 'Correct-Horse-Battery-9', name: 'Gateway Test User' } });
  const user = response.json();
  createdUserIds.push(user.id);
  const cookie = response.cookies.find(c => c.name === 'odc_session')!;
  const membership = await prisma.organizationMember.findFirstOrThrow({ where: { userId: user.id } });
  createdOrgIds.push(membership.organizationId);
  return { user, sessionCookie: `${cookie.name}=${cookie.value}`, organizationId: membership.organizationId };
}

async function makeWorkspaceFixture(organizationId: string) {
  const project = await prisma.project.create({ data: { organizationId, name: 'Gateway Fixture', slug: `gw-fixture-${crypto.randomUUID()}` } });
  return prisma.workspace.create({ data: { projectId: project.id, containerId: 'test-container-not-real', status: 'RUNNING' } });
}

async function issueTicket(sessionCookie: string, workspaceId: string, purpose: 'ide' | 'preview', port?: number) {
  const res = await app.inject({ method: 'POST', url: '/api/v1/runtime-tickets', headers: { cookie: sessionCookie }, payload: { workspaceId, purpose, port } });
  return res;
}

describe('runtime ticket issuance (POST /api/v1/runtime-tickets, on the panel origin)', () => {
  it('requires authentication', async () => {
    // A real (existing) workspace, no session cookie — isolates "not authenticated" (401) from
    // "workspace lookup happens before auth and 404s first", which is this route's existing
    // ordering (matching every other workspace-scoped route in this codebase, e.g. agents.ts).
    const { organizationId } = await registerUser();
    const workspace = await makeWorkspaceFixture(organizationId);
    const res = await app.inject({ method: 'POST', url: '/api/v1/runtime-tickets', payload: { workspaceId: workspace.id, purpose: 'ide' } });
    expect(res.statusCode).toBe(401);
  });

  it('requires DEVELOPER role in the workspace\'s organization', async () => {
    const owner = await registerUser();
    const outsider = await registerUser();
    const workspace = await makeWorkspaceFixture(owner.organizationId);
    const res = await issueTicket(outsider.sessionCookie, workspace.id, 'ide');
    expect(res.statusCode).toBe(403);
  });

  it('rejects a preview ticket for a port that was never registered', async () => {
    const { sessionCookie, organizationId } = await registerUser();
    const workspace = await makeWorkspaceFixture(organizationId);
    const res = await issueTicket(sessionCookie, workspace.id, 'preview', 5173);
    expect(res.statusCode).toBe(404);
  });

  it('issues a ticket + a URL on the runtime domain, scoped to the requested workspace', async () => {
    const { sessionCookie, organizationId } = await registerUser();
    const workspace = await makeWorkspaceFixture(organizationId);
    const res = await issueTicket(sessionCookie, workspace.id, 'ide');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ticket).toEqual(expect.any(String));
    expect(body.url).toContain(`ide-${workspace.id}.${RUNTIME_BASE_DOMAIN}`);
    expect(body.url).toContain(`t=${body.ticket}`);
  });
});

describe('Runtime Gateway host routing (real Postgres, in-process via app.inject with a spoofed Host header)', () => {
  it('rejects a request with no ticket and no runtime cookie', async () => {
    const { organizationId } = await registerUser();
    const workspace = await makeWorkspaceFixture(organizationId);
    const res = await app.inject({ method: 'GET', url: '/', headers: { host: `ide-${workspace.id}.${RUNTIME_BASE_DOMAIN}` } });
    expect(res.statusCode).toBe(401);
  });

  it('does not accept the control-plane session cookie as runtime authentication', async () => {
    // Proves the gateway never trusts odc_session — even handed to it directly (which a real browser
    // never would, since it's scoped to a different host) — as a substitute for a runtime ticket/
    // cookie. This is the server-side half of "a preview can't reuse the panel's session"; the
    // browser-side half (a different host simply never receives that cookie) is structural, not
    // something this process can misconfigure away.
    const { sessionCookie, organizationId } = await registerUser();
    const workspace = await makeWorkspaceFixture(organizationId);
    const res = await app.inject({ method: 'GET', url: '/', headers: { host: `ide-${workspace.id}.${RUNTIME_BASE_DOMAIN}`, cookie: sessionCookie } });
    expect(res.statusCode).toBe(401);
  });

  it('a ticket issued for workspace A is rejected against workspace B\'s host', async () => {
    const { sessionCookie, organizationId } = await registerUser();
    const workspaceA = await makeWorkspaceFixture(organizationId);
    const workspaceB = await makeWorkspaceFixture(organizationId);
    const { ticket } = (await issueTicket(sessionCookie, workspaceA.id, 'ide')).json();
    const res = await app.inject({ method: 'GET', url: `/?t=${ticket}`, headers: { host: `ide-${workspaceB.id}.${RUNTIME_BASE_DOMAIN}` } });
    expect(res.statusCode).toBe(401);
  });

  it('a ticket issued for "ide" is rejected against a "preview" host for the same workspace', async () => {
    const { sessionCookie, organizationId } = await registerUser();
    const workspace = await makeWorkspaceFixture(organizationId);
    await prisma.workspacePort.create({ data: { workspaceId: workspace.id, port: 3000, label: 'app' } });
    const { ticket } = (await issueTicket(sessionCookie, workspace.id, 'ide')).json();
    const res = await app.inject({ method: 'GET', url: `/?t=${ticket}`, headers: { host: `preview-${workspace.id}-3000.${RUNTIME_BASE_DOMAIN}` } });
    expect(res.statusCode).toBe(401);
  });

  it('rejects an expired ticket', async () => {
    const { sessionCookie, organizationId } = await registerUser();
    const workspace = await makeWorkspaceFixture(organizationId);
    // Directly craft an already-expired ticket rather than waiting out a real 60s TTL.
    const { issueRuntimeTicket } = await import('./lib/runtimeTicket.js');
    const owner = await prisma.organizationMember.findFirstOrThrow({ where: { organizationId } });
    const expired = issueRuntimeTicket({ uid: owner.userId, workspaceId: workspace.id, purpose: 'ide' }, -1);
    void sessionCookie;
    const res = await app.inject({ method: 'GET', url: `/?t=${expired}`, headers: { host: `ide-${workspace.id}.${RUNTIME_BASE_DOMAIN}` } });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a valid, correctly-scoped ticket for a user who has since been removed from the organization', async () => {
    const { sessionCookie, organizationId } = await registerUser();
    const workspace = await makeWorkspaceFixture(organizationId);
    const { ticket } = (await issueTicket(sessionCookie, workspace.id, 'ide')).json();
    const membership = await prisma.organizationMember.findFirstOrThrow({ where: { organizationId } });
    await prisma.organizationMember.delete({ where: { id: membership.id } });
    const res = await app.inject({ method: 'GET', url: `/?t=${ticket}`, headers: { host: `ide-${workspace.id}.${RUNTIME_BASE_DOMAIN}` } });
    expect(res.statusCode).toBe(403);
  });

  it('a valid ticket sets a host-only runtime cookie and redirects to the same URL with the ticket stripped', async () => {
    const { sessionCookie, organizationId } = await registerUser();
    const workspace = await makeWorkspaceFixture(organizationId);
    const { ticket } = (await issueTicket(sessionCookie, workspace.id, 'ide')).json();
    const res = await app.inject({ method: 'GET', url: `/some/path?t=${ticket}&x=1`, headers: { host: `ide-${workspace.id}.${RUNTIME_BASE_DOMAIN}` } });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/some/path?x=1');
    const runtimeCookie = res.cookies.find(c => c.name === `odc_runtime_ide_${workspace.id}`);
    expect(runtimeCookie).toBeDefined();
    expect(runtimeCookie?.httpOnly).toBe(true);
    // Host-only: no explicit Domain attribute, so the browser scopes it to this exact subdomain only.
    expect((runtimeCookie as unknown as { domain?: string })?.domain).toBeUndefined();
  });

  it('an existing valid runtime cookie grants access on a later request with no ticket in the URL', async () => {
    const { sessionCookie, organizationId } = await registerUser();
    const workspace = await makeWorkspaceFixture(organizationId);
    const { ticket } = (await issueTicket(sessionCookie, workspace.id, 'ide')).json();
    const first = await app.inject({ method: 'GET', url: `/?t=${ticket}`, headers: { host: `ide-${workspace.id}.${RUNTIME_BASE_DOMAIN}` } });
    const runtimeCookie = first.cookies.find(c => c.name === `odc_runtime_ide_${workspace.id}`)!;

    const second = await app.inject({ method: 'GET', url: '/', headers: { host: `ide-${workspace.id}.${RUNTIME_BASE_DOMAIN}`, cookie: `${runtimeCookie.name}=${runtimeCookie.value}` } });
    // No redirect this time (no fresh ticket consumed) and no auth error — it reaches the proxy
    // handler, which then fails for an unrelated reason (no real Docker/container on this host).
    expect(second.statusCode).not.toBe(401);
    expect(second.statusCode).not.toBe(302);
  });

  it('an existing runtime cookie stops granting access once the user is removed from the organization', async () => {
    const { sessionCookie, organizationId } = await registerUser();
    const workspace = await makeWorkspaceFixture(organizationId);
    const { ticket } = (await issueTicket(sessionCookie, workspace.id, 'ide')).json();
    const first = await app.inject({ method: 'GET', url: `/?t=${ticket}`, headers: { host: `ide-${workspace.id}.${RUNTIME_BASE_DOMAIN}` } });
    const runtimeCookie = first.cookies.find(c => c.name === `odc_runtime_ide_${workspace.id}`)!;

    const membership = await prisma.organizationMember.findFirstOrThrow({ where: { organizationId } });
    await prisma.organizationMember.delete({ where: { id: membership.id } });

    const second = await app.inject({ method: 'GET', url: '/', headers: { host: `ide-${workspace.id}.${RUNTIME_BASE_DOMAIN}`, cookie: `${runtimeCookie.name}=${runtimeCookie.value}` } });
    expect(second.statusCode).toBe(403);
  });

  it('rejects a preview request for a port that is no longer registered, even with a previously-issued valid ticket', async () => {
    const { sessionCookie, organizationId } = await registerUser();
    const workspace = await makeWorkspaceFixture(organizationId);
    await prisma.workspacePort.create({ data: { workspaceId: workspace.id, port: 4321, label: 'app' } });
    const { ticket } = (await issueTicket(sessionCookie, workspace.id, 'preview', 4321)).json();
    await prisma.workspacePort.deleteMany({ where: { workspaceId: workspace.id, port: 4321 } });
    const res = await app.inject({ method: 'GET', url: `/?t=${ticket}`, headers: { host: `preview-${workspace.id}-4321.${RUNTIME_BASE_DOMAIN}` } });
    expect(res.statusCode).toBe(404);
  });

  it('sends the required security headers on every gateway response', async () => {
    const { sessionCookie, organizationId } = await registerUser();
    const workspace = await makeWorkspaceFixture(organizationId);
    const { ticket } = (await issueTicket(sessionCookie, workspace.id, 'ide')).json();
    const res = await app.inject({ method: 'GET', url: `/?t=${ticket}`, headers: { host: `ide-${workspace.id}.${RUNTIME_BASE_DOMAIN}` } });
    expect(res.headers['content-security-policy']).toContain('frame-ancestors');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['permissions-policy']).toBeDefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('an unrecognized runtime-domain host is a plain 404, and does not interfere with normal panel routes', async () => {
    const notAWorkspace = await app.inject({ method: 'GET', url: '/', headers: { host: `ide-not-a-real-id.${RUNTIME_BASE_DOMAIN}` } });
    expect(notAWorkspace.statusCode).toBe(404);

    const { sessionCookie } = await registerUser();
    const panelRequest = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie: sessionCookie } });
    expect(panelRequest.statusCode).toBe(200);
  });
});

describe('deprecated /api/v1/proxy/* — blocked in production, still usable during the transition otherwise', () => {
  it('is blocked with 410 when NODE_ENV=production', async () => {
    const previousEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const prodApp = await buildApp({ logger: false, disableRateLimit: true });
      await prodApp.ready();
      try {
        const { organizationId, sessionCookie } = await registerUser();
        const workspace = await makeWorkspaceFixture(organizationId);
        const res = await prodApp.inject({ method: 'GET', url: `/api/v1/proxy/ide/${workspace.id}/`, headers: { cookie: sessionCookie, origin: process.env.WEB_ORIGIN ?? 'http://localhost:3000' } });
        expect(res.statusCode).toBe(410);
      } finally {
        await prodApp.close();
      }
    } finally {
      if (previousEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousEnv;
    }
  });
});

describe('Runtime Gateway — actually relays real traffic end-to-end (real listening server, real WebSocket)', () => {
  let fakeIde: WebSocketServer;
  let wsBaseUrl: string;
  let port: number;

  beforeAll(async () => {
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    port = typeof address === 'object' && address ? address.port : 0;
    wsBaseUrl = `ws://127.0.0.1:${port}`;

    fakeIde = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    fakeIde.on('connection', ws => ws.on('message', (data, isBinary) => ws.send(Buffer.concat([Buffer.from('echo:'), Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer)]), { binary: isBinary })));
    await new Promise<void>(resolve => fakeIde.once('listening', resolve));
  });

  afterAll(async () => {
    await new Promise<void>(resolve => fakeIde.close(() => resolve()));
  });

  beforeEach(() => {
    const fakePort = (fakeIde.address() as { port: number }).port;
    internalHostSpy = vi.spyOn(DockerIdeEngine.prototype, 'internalHost').mockImplementation(async () => '127.0.0.1');
    // The gateway always targets IDE_PORT (13337) for ide-* hosts, which nothing is listening on in
    // this test — so this specific describe block instead proves the relay mechanics generically via
    // a raw WebSocket connection carrying a spoofed Host that resolves through the exact same
    // preHandler/wsHandler/bridge path preview traffic uses, pointed at the fake server's real port.
    void fakePort;
  });

  it('relays a real message through ticket validation, the gateway route, and the bridge', async () => {
    const { sessionCookie, organizationId } = await registerUser();
    const workspace = await makeWorkspaceFixture(organizationId);
    const fakePort = (fakeIde.address() as { port: number }).port;
    await prisma.workspacePort.create({ data: { workspaceId: workspace.id, port: fakePort, label: 'preview' } });
    const { ticket } = (await issueTicket(sessionCookie, workspace.id, 'preview', fakePort)).json();

    const client = new WebSocket(`${wsBaseUrl}/?t=${ticket}`, { headers: { host: `preview-${workspace.id}-${fakePort}.${RUNTIME_BASE_DOMAIN}` } });
    try {
      const opened = new Promise<void>((resolve, reject) => { client.once('open', () => resolve()); client.once('error', reject); client.once('unexpected-response', (_r, res) => reject(new Error(`unexpected ${res.statusCode}`))); });
      await opened;
      const echoed = new Promise<string>(resolve => client.once('message', data => resolve(data.toString())));
      client.send('ping through the runtime gateway');
      expect(await echoed).toBe('echo:ping through the runtime gateway');
    } finally {
      client.close();
    }
  });
});
