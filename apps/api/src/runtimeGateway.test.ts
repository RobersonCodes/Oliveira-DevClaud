import crypto from 'node:crypto';
import WebSocket, { WebSocketServer } from 'ws';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '@oliveira/database';
import { DockerIdeEngine } from '@oliveira/ide-engine';
import { buildApp } from './app.js';

const RUNTIME_BASE_DOMAIN = 'runtime.localhost';
const WEB_ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:3000';

function ideHost(workspaceId: string) { return `ide-${workspaceId}.${RUNTIME_BASE_DOMAIN}`; }
function previewHost(workspaceId: string, port: number) { return `preview-${workspaceId}-${port}.${RUNTIME_BASE_DOMAIN}`; }
function originFor(host: string) { return `http://${host}`; }

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

/** Redeems a ticket (Origin: the panel, as a real cross-origin navigation would send) and returns the freshly-issued runtime cookie. */
async function redeemTicketForCookie(host: string, ticket: string) {
  const res = await app.inject({ method: 'GET', url: `/?t=${ticket}`, headers: { host, origin: WEB_ORIGIN } });
  const cookie = res.cookies[0];
  if (!cookie) throw new Error(`ticket redemption against ${host} did not yield a cookie (status ${res.statusCode})`);
  return `${cookie.name}=${cookie.value}`;
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

describe('Runtime Gateway — Origin validation (RFC 6455 §10.2; exact match, never suffix/prefix)', () => {
  it('accepts the ticket-redemption request when Origin is the panel\'s (a real cross-origin navigation sends this)', async () => {
    const { sessionCookie, organizationId } = await registerUser();
    const workspace = await makeWorkspaceFixture(organizationId);
    const { ticket } = (await issueTicket(sessionCookie, workspace.id, 'ide')).json();
    const res = await app.inject({ method: 'GET', url: `/?t=${ticket}`, headers: { host: ideHost(workspace.id), origin: WEB_ORIGIN } });
    expect(res.statusCode).toBe(302);
  });

  it('accepts a same-origin request (Origin exactly equal to the request\'s own host) using an existing cookie', async () => {
    const { sessionCookie, organizationId } = await registerUser();
    const workspace = await makeWorkspaceFixture(organizationId);
    const { ticket } = (await issueTicket(sessionCookie, workspace.id, 'ide')).json();
    const runtimeCookie = await redeemTicketForCookie(ideHost(workspace.id), ticket);
    const res = await app.inject({ method: 'GET', url: '/', headers: { host: ideHost(workspace.id), cookie: runtimeCookie, origin: originFor(ideHost(workspace.id)) } });
    expect(res.statusCode).not.toBe(403);
  });

  it('rejects a request with Origin: null', async () => {
    const { sessionCookie, organizationId } = await registerUser();
    const workspace = await makeWorkspaceFixture(organizationId);
    const { ticket } = (await issueTicket(sessionCookie, workspace.id, 'ide')).json();
    const res = await app.inject({ method: 'GET', url: `/?t=${ticket}`, headers: { host: ideHost(workspace.id), origin: 'null' } });
    expect(res.statusCode).toBe(403);
  });

  it('accepts a ticket-redemption GET with NO Origin header and no Sec-Fetch-Site header — real browsers do not guarantee Origin on GET navigations (Fetch Standard)', async () => {
    // This is the actual golden path: <iframe src="https://ide-x.../?t=..."> is a top-level
    // navigation, and per the Fetch Standard's Origin header algorithm, Origin is not reliably sent
    // on GET/HEAD navigations. Requiring it here would 403 real browsers while only passing this
    // test suite's own explicit-Origin requests — the exact bug this test guards against regressing.
    const { sessionCookie, organizationId } = await registerUser();
    const workspace = await makeWorkspaceFixture(organizationId);
    const { ticket } = (await issueTicket(sessionCookie, workspace.id, 'ide')).json();
    const res = await app.inject({ method: 'GET', url: `/?t=${ticket}`, headers: { host: ideHost(workspace.id) } });
    expect(res.statusCode).toBe(302);
  });

  it('accepts a resource GET with an existing cookie, no Origin, and Sec-Fetch-Mode: navigate — e.g. a full-page reload of the IDE tab', async () => {
    const { sessionCookie, organizationId } = await registerUser();
    const workspace = await makeWorkspaceFixture(organizationId);
    const { ticket } = (await issueTicket(sessionCookie, workspace.id, 'ide')).json();
    const runtimeCookie = await redeemTicketForCookie(ideHost(workspace.id), ticket);
    const res = await app.inject({
      method: 'GET', url: '/',
      headers: { host: ideHost(workspace.id), cookie: runtimeCookie, 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'iframe' }
    });
    expect(res.statusCode).not.toBe(403);
  });

  it('rejects a GET with no Origin but Sec-Fetch-Site indicating a cross-origin subresource/fetch, not a navigation', async () => {
    // The residual gap Origin-presence alone can't close: a browser that (for whatever request type)
    // omits Origin on a GET but still sends Sec-Fetch-Site — a same-site sibling's fetch()-like
    // request that isn't a top-level navigation must still be rejected.
    const { sessionCookie, organizationId } = await registerUser();
    const workspace = await makeWorkspaceFixture(organizationId);
    const { ticket } = (await issueTicket(sessionCookie, workspace.id, 'ide')).json();
    const res = await app.inject({
      method: 'GET', url: `/?t=${ticket}`,
      headers: { host: ideHost(workspace.id), 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'image' }
    });
    expect(res.statusCode).toBe(403);
  });

  it('rejects a POST (mutating) request whose Origin is the panel — the gateway has no endpoint that legitimately needs panel-initiated mutation', async () => {
    const { sessionCookie, organizationId } = await registerUser();
    const workspace = await makeWorkspaceFixture(organizationId);
    const { ticket } = (await issueTicket(sessionCookie, workspace.id, 'ide')).json();
    const runtimeCookie = await redeemTicketForCookie(ideHost(workspace.id), ticket);
    const res = await app.inject({ method: 'POST', url: '/some-action', headers: { host: ideHost(workspace.id), cookie: runtimeCookie, origin: WEB_ORIGIN } });
    expect(res.statusCode).toBe(403);
  });

  it('accepts a POST (mutating) request whose Origin is this exact runtime host', async () => {
    const { sessionCookie, organizationId } = await registerUser();
    const workspace = await makeWorkspaceFixture(organizationId);
    const { ticket } = (await issueTicket(sessionCookie, workspace.id, 'ide')).json();
    const runtimeCookie = await redeemTicketForCookie(ideHost(workspace.id), ticket);
    const res = await app.inject({ method: 'POST', url: '/some-action', headers: { host: ideHost(workspace.id), cookie: runtimeCookie, origin: originFor(ideHost(workspace.id)) } });
    expect(res.statusCode).not.toBe(403);
  });

  it('rejects a duplicated/folded Origin header even if one of the joined values would otherwise match', async () => {
    const { sessionCookie, organizationId } = await registerUser();
    const workspace = await makeWorkspaceFixture(organizationId);
    const { ticket } = (await issueTicket(sessionCookie, workspace.id, 'ide')).json();
    const res = await app.inject({ method: 'GET', url: `/?t=${ticket}`, headers: { host: ideHost(workspace.id), origin: `${WEB_ORIGIN}, https://evil.example` } });
    expect(res.statusCode).toBe(403);
  });

  it('rejects a lookalike/suffix origin that merely contains or extends the real host', async () => {
    const { sessionCookie, organizationId } = await registerUser();
    const workspace = await makeWorkspaceFixture(organizationId);
    const { ticket } = (await issueTicket(sessionCookie, workspace.id, 'ide')).json();
    const lookalikes = [
      `${originFor(ideHost(workspace.id))}.evil.example`, // "starts with the real origin"
      `http://evil.example?${originFor(ideHost(workspace.id))}`, // real origin appears, just not as Origin
      `http://not-${ideHost(workspace.id)}` // similar-looking but different host
    ];
    for (const origin of lookalikes) {
      const res = await app.inject({ method: 'GET', url: `/?t=${ticket}`, headers: { host: ideHost(workspace.id), origin } });
      expect(res.statusCode, `origin "${origin}" should have been rejected`).toBe(403);
    }
  });

  it('rejects the right host with the wrong scheme', async () => {
    const { sessionCookie, organizationId } = await registerUser();
    const workspace = await makeWorkspaceFixture(organizationId);
    const { ticket } = (await issueTicket(sessionCookie, workspace.id, 'ide')).json();
    const res = await app.inject({ method: 'GET', url: `/?t=${ticket}`, headers: { host: ideHost(workspace.id), origin: `https://${ideHost(workspace.id)}` } });
    expect(res.statusCode).toBe(403);
  });

  it('rejects the right host with the wrong port', async () => {
    const { sessionCookie, organizationId } = await registerUser();
    const workspace = await makeWorkspaceFixture(organizationId);
    const { ticket } = (await issueTicket(sessionCookie, workspace.id, 'ide')).json();
    const res = await app.inject({ method: 'GET', url: `/?t=${ticket}`, headers: { host: ideHost(workspace.id), origin: `http://${ideHost(workspace.id)}:9999` } });
    expect(res.statusCode).toBe(403);
  });

  it('CRITICAL: a sibling runtime workspace cannot use its victim\'s valid runtime cookie to access the victim — even though SameSite=Lax + host-only cookie scoping alone would let the request through', async () => {
    // The exact attack: ide-a.runtime.<domain> and ide-b.runtime.<domain> are different origins but
    // the *same registrable site* (RFC6265bis) — SameSite=Lax does not distinguish them. A cookie
    // scoped to B's exact host is sent by the browser whenever a request *targets* B's host,
    // regardless of which origin's script initiated it. Host-only scoping stops A's script from
    // *reading* B's cookie via document.cookie; it never stopped A from *triggering* a request to B
    // that legitimately carries it. This is simulated directly: B's real, valid cookie, attached to
    // a request whose Origin is A — exactly what a browser would send for `new WebSocket(...)`
    // issued by a script running on A's page.
    const { sessionCookie, organizationId } = await registerUser();
    const workspaceA = await makeWorkspaceFixture(organizationId);
    const workspaceB = await makeWorkspaceFixture(organizationId);

    const ticketB = (await issueTicket(sessionCookie, workspaceB.id, 'ide')).json().ticket;
    const victimCookieForB = await redeemTicketForCookie(ideHost(workspaceB.id), ticketB);

    const attack = await app.inject({
      method: 'GET', url: '/',
      headers: { host: ideHost(workspaceB.id), cookie: victimCookieForB, origin: originFor(ideHost(workspaceA.id)) }
    });
    expect(attack.statusCode).toBe(403);
  });
});

describe('Runtime Gateway host routing (real Postgres, in-process via app.inject with a spoofed Host header)', () => {
  it('rejects a request with no ticket and no runtime cookie', async () => {
    const { organizationId } = await registerUser();
    const workspace = await makeWorkspaceFixture(organizationId);
    const res = await app.inject({ method: 'GET', url: '/', headers: { host: ideHost(workspace.id), origin: WEB_ORIGIN } });
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
    const res = await app.inject({ method: 'GET', url: '/', headers: { host: ideHost(workspace.id), cookie: sessionCookie, origin: WEB_ORIGIN } });
    expect(res.statusCode).toBe(401);
  });

  it('a ticket issued for workspace A is rejected against workspace B\'s host', async () => {
    const { sessionCookie, organizationId } = await registerUser();
    const workspaceA = await makeWorkspaceFixture(organizationId);
    const workspaceB = await makeWorkspaceFixture(organizationId);
    const { ticket } = (await issueTicket(sessionCookie, workspaceA.id, 'ide')).json();
    const res = await app.inject({ method: 'GET', url: `/?t=${ticket}`, headers: { host: ideHost(workspaceB.id), origin: WEB_ORIGIN } });
    expect(res.statusCode).toBe(401);
  });

  it('a ticket issued for "ide" is rejected against a "preview" host for the same workspace', async () => {
    const { sessionCookie, organizationId } = await registerUser();
    const workspace = await makeWorkspaceFixture(organizationId);
    await prisma.workspacePort.create({ data: { workspaceId: workspace.id, port: 3000, label: 'app' } });
    const { ticket } = (await issueTicket(sessionCookie, workspace.id, 'ide')).json();
    const res = await app.inject({ method: 'GET', url: `/?t=${ticket}`, headers: { host: previewHost(workspace.id, 3000), origin: WEB_ORIGIN } });
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
    const res = await app.inject({ method: 'GET', url: `/?t=${expired}`, headers: { host: ideHost(workspace.id), origin: WEB_ORIGIN } });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a valid, correctly-scoped ticket for a user who has since been removed from the organization', async () => {
    const { sessionCookie, organizationId } = await registerUser();
    const workspace = await makeWorkspaceFixture(organizationId);
    const { ticket } = (await issueTicket(sessionCookie, workspace.id, 'ide')).json();
    const membership = await prisma.organizationMember.findFirstOrThrow({ where: { organizationId } });
    await prisma.organizationMember.delete({ where: { id: membership.id } });
    const res = await app.inject({ method: 'GET', url: `/?t=${ticket}`, headers: { host: ideHost(workspace.id), origin: WEB_ORIGIN } });
    expect(res.statusCode).toBe(403);
  });

  it('a valid ticket sets a host-only runtime cookie and redirects to the same URL with the ticket stripped', async () => {
    const { sessionCookie, organizationId } = await registerUser();
    const workspace = await makeWorkspaceFixture(organizationId);
    const { ticket } = (await issueTicket(sessionCookie, workspace.id, 'ide')).json();
    const res = await app.inject({ method: 'GET', url: `/some/path?t=${ticket}&x=1`, headers: { host: ideHost(workspace.id), origin: WEB_ORIGIN } });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/some/path?x=1');
    const runtimeCookie = res.cookies.find(c => c.name === `__Host-odc_runtime_ide_${workspace.id}`);
    expect(runtimeCookie).toBeDefined();
    expect(runtimeCookie?.httpOnly).toBe(true);
    expect(runtimeCookie?.secure).toBe(true);
    expect(runtimeCookie?.sameSite).toBe('None');
    expect(runtimeCookie?.path).toBe('/');
    // Host-only: no explicit Domain attribute, so the browser scopes it to this exact subdomain only.
    expect((runtimeCookie as unknown as { domain?: string })?.domain).toBeUndefined();
  });

  it('an existing valid runtime cookie grants access on a later request with no ticket in the URL', async () => {
    const { sessionCookie, organizationId } = await registerUser();
    const workspace = await makeWorkspaceFixture(organizationId);
    const { ticket } = (await issueTicket(sessionCookie, workspace.id, 'ide')).json();
    const runtimeCookie = await redeemTicketForCookie(ideHost(workspace.id), ticket);

    const second = await app.inject({ method: 'GET', url: '/', headers: { host: ideHost(workspace.id), cookie: runtimeCookie, origin: originFor(ideHost(workspace.id)) } });
    // No redirect this time (no fresh ticket consumed) and no auth error — it reaches the proxy
    // handler, which then fails for an unrelated reason (no real Docker/container on this host).
    expect(second.statusCode).not.toBe(401);
    expect(second.statusCode).not.toBe(302);
    expect(second.statusCode).not.toBe(403);
  });

  it('an existing runtime cookie stops granting access once the user is removed from the organization', async () => {
    const { sessionCookie, organizationId } = await registerUser();
    const workspace = await makeWorkspaceFixture(organizationId);
    const { ticket } = (await issueTicket(sessionCookie, workspace.id, 'ide')).json();
    const runtimeCookie = await redeemTicketForCookie(ideHost(workspace.id), ticket);

    const membership = await prisma.organizationMember.findFirstOrThrow({ where: { organizationId } });
    await prisma.organizationMember.delete({ where: { id: membership.id } });

    const second = await app.inject({ method: 'GET', url: '/', headers: { host: ideHost(workspace.id), cookie: runtimeCookie, origin: originFor(ideHost(workspace.id)) } });
    expect(second.statusCode).toBe(403);
  });

  it('rejects a preview request for a port that is no longer registered, even with a previously-issued valid ticket', async () => {
    const { sessionCookie, organizationId } = await registerUser();
    const workspace = await makeWorkspaceFixture(organizationId);
    await prisma.workspacePort.create({ data: { workspaceId: workspace.id, port: 4321, label: 'app' } });
    const { ticket } = (await issueTicket(sessionCookie, workspace.id, 'preview', 4321)).json();
    await prisma.workspacePort.deleteMany({ where: { workspaceId: workspace.id, port: 4321 } });
    const res = await app.inject({ method: 'GET', url: `/?t=${ticket}`, headers: { host: previewHost(workspace.id, 4321), origin: WEB_ORIGIN } });
    expect(res.statusCode).toBe(404);
  });

  it('sends the required security headers on every gateway response, including connect-src \'self\'', async () => {
    const { sessionCookie, organizationId } = await registerUser();
    const workspace = await makeWorkspaceFixture(organizationId);
    const { ticket } = (await issueTicket(sessionCookie, workspace.id, 'ide')).json();
    const res = await app.inject({ method: 'GET', url: `/?t=${ticket}`, headers: { host: ideHost(workspace.id), origin: WEB_ORIGIN } });
    expect(res.headers['content-security-policy']).toContain('frame-ancestors');
    expect(res.headers['content-security-policy']).toContain("connect-src 'self'");
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['permissions-policy']).toBeDefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('an unrecognized runtime-domain host is a plain 404, and does not interfere with normal panel routes', async () => {
    const notAWorkspace = await app.inject({ method: 'GET', url: '/', headers: { host: `ide-not-a-real-id.${RUNTIME_BASE_DOMAIN}`, origin: WEB_ORIGIN } });
    expect(notAWorkspace.statusCode).toBe(404);

    const { sessionCookie } = await registerUser();
    const panelRequest = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie: sessionCookie } });
    expect(panelRequest.statusCode).toBe(200);
  });
});

describe('deprecated /api/v1/proxy/* — blocked in production, still usable during the transition otherwise', () => {
  it('is blocked with 410 when NODE_ENV=production', async () => {
    const productionEnv = {
      NODE_ENV: 'production',
      SECURE_CONFIG_REQUIRED: 'true',
      WEB_ORIGIN: 'https://app.aifunnelpro.com.br',
      DEV_CLOUD_HOST: 'app.aifunnelpro.com.br',
      RUNTIME_BASE_DOMAIN: 'runtime.tiremax.shop',
      RUNTIME_TICKET_SECRET: 'test-runtime-ticket-secret-with-32-bytes',
      RUNTIME_BROKER_TOKEN: 'test-runtime-broker-token-with-32-bytes',
      SECRETS_MASTER_KEY_BASE64: Buffer.alloc(32, 1).toString('base64'),
      DATABASE_URL: process.env.DATABASE_URL ?? 'postgresql://oliveira:oliveira@localhost:5432/devcloud',
      REDIS_URL: process.env.REDIS_URL ?? 'redis://localhost:6379',
      RUNTIME_BROKER_URL: process.env.RUNTIME_BROKER_URL ?? 'http://runtime-broker:5001',
      TRUSTED_PROXY_CIDRS: '127.0.0.1/32',
      SESSION_TTL_DAYS: '14'
    };
    const previousEnv = new Map(Object.keys(productionEnv).map(name => [name, process.env[name]]));
    Object.assign(process.env, productionEnv);
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
      for (const [name, value] of previousEnv) {
        if (value === undefined) delete process.env[name]; else process.env[name] = value;
      }
    }
  });
});

describe('Runtime Gateway — actually relays real traffic end-to-end (real listening server, real WebSocket)', () => {
  let fakeIde: WebSocketServer;
  let wsBaseUrl: string;

  beforeAll(async () => {
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    wsBaseUrl = `ws://127.0.0.1:${port}`;

    fakeIde = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    fakeIde.on('connection', ws => ws.on('message', (data, isBinary) => ws.send(Buffer.concat([Buffer.from('echo:'), Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer)]), { binary: isBinary })));
    await new Promise<void>(resolve => fakeIde.once('listening', resolve));
  });

  afterAll(async () => {
    await new Promise<void>(resolve => fakeIde.close(() => resolve()));
  });

  beforeEach(() => {
    internalHostSpy = vi.spyOn(DockerIdeEngine.prototype, 'internalHost').mockImplementation(async () => '127.0.0.1');
  });

  it('relays a real message through Origin validation, ticket validation, the gateway route, and the bridge', async () => {
    const { sessionCookie, organizationId } = await registerUser();
    const workspace = await makeWorkspaceFixture(organizationId);
    const fakePort = (fakeIde.address() as { port: number }).port;
    await prisma.workspacePort.create({ data: { workspaceId: workspace.id, port: fakePort, label: 'preview' } });
    const { ticket } = (await issueTicket(sessionCookie, workspace.id, 'preview', fakePort)).json();
    const host = previewHost(workspace.id, fakePort);

    const client = new WebSocket(`${wsBaseUrl}/?t=${ticket}`, { headers: { host, origin: originFor(host) } });
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

  it('rejects the same WebSocket handshake when Origin is a sibling runtime host instead of its own', async () => {
    const { sessionCookie, organizationId } = await registerUser();
    const workspace = await makeWorkspaceFixture(organizationId);
    const fakePort = (fakeIde.address() as { port: number }).port;
    await prisma.workspacePort.create({ data: { workspaceId: workspace.id, port: fakePort, label: 'preview' } });
    const { ticket } = (await issueTicket(sessionCookie, workspace.id, 'preview', fakePort)).json();
    const host = previewHost(workspace.id, fakePort);
    const siblingWorkspace = await makeWorkspaceFixture(organizationId);

    const client = new WebSocket(`${wsBaseUrl}/?t=${ticket}`, { headers: { host, origin: originFor(ideHost(siblingWorkspace.id)) } });
    const rejected = await new Promise<number>((resolve, reject) => {
      client.once('unexpected-response', (_r, res) => resolve(res.statusCode ?? 0));
      client.once('open', () => reject(new Error('handshake unexpectedly succeeded')));
      client.once('error', () => {});
      setTimeout(() => reject(new Error('timed out waiting for rejection')), 5_000);
    });
    expect(rejected).toBe(403);
  });
});
