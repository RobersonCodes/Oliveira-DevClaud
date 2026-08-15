import crypto from 'node:crypto';
import http from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '@oliveira/database';
import { IDE_PORT } from '@oliveira/ide-engine';
import { startTestBroker } from '@oliveira/runtime-broker/src/testHelpers.js';
import { hashToken } from './lib/auth.js';

// Real listening server + a real `ws`/`http` client, not `app.inject()` — Origin-header rejection
// and the WebSocket upgrade handshake itself can only be exercised through an actual HTTP
// connection, not Fastify's in-process request injection.
let app: FastifyInstance;
let baseUrl: string;
let wsBaseUrl: string;
let port: number;
let broker: Awaited<ReturnType<typeof startTestBroker>>;
let DockerIdeEngine: typeof import('@oliveira/ide-engine').DockerIdeEngine;
const WEB_ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:3000';
const createdUserIds: string[] = [];
const createdOrgIds: string[] = [];

beforeAll(async () => {
  // apps/api/src/routes/{terminals,ide}.ts construct their engine clients once, at module load
  // time — the real broker has to exist (and RUNTIME_BROKER_URL/TOKEN has to point at it) before
  // `./app.js` is ever imported, so this is a dynamic import, not a static one at the top of the
  // file. Without this, `ide.internalHost()` fails by trying (and failing) to reach the
  // unconfigured production default URL, which is a *different* failure than the one the two
  // "fails later, resolving the real container" tests below are actually about.
  broker = await startTestBroker();
  process.env.RUNTIME_BROKER_URL = broker.url;
  process.env.RUNTIME_BROKER_TOKEN = broker.token;
  ({ DockerIdeEngine } = await import('@oliveira/ide-engine'));
  const { buildApp } = await import('./app.js');

  app = await buildApp({ logger: false, disableRateLimit: true });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  port = typeof address === 'object' && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
  wsBaseUrl = `ws://127.0.0.1:${port}`;
}, 30_000);

afterEach(async () => {
  while (createdOrgIds.length) await prisma.organization.delete({ where: { id: createdOrgIds.pop()! } }).catch(() => undefined);
  while (createdUserIds.length) await prisma.user.delete({ where: { id: createdUserIds.pop()! } }).catch(() => undefined);
});

afterAll(async () => {
  await app.close();
  await broker?.close();
});

async function registerUser() {
  const email = `${crypto.randomUUID()}@example.test`;
  const res = await fetch(`${baseUrl}/api/v1/auth/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'Correct-Horse-Battery-9', name: 'WS Test User' })
  });
  const user = await res.json();
  createdUserIds.push(user.id);
  const cookie = res.headers.get('set-cookie')!.split(';')[0];
  const membership = await prisma.organizationMember.findFirstOrThrow({ where: { userId: user.id } });
  createdOrgIds.push(membership.organizationId);
  return { user, cookie, organizationId: membership.organizationId };
}

async function makeWorkspaceFixture(organizationId: string) {
  const project = await prisma.project.create({ data: { organizationId, name: 'WS Fixture', slug: `ws-fixture-${crypto.randomUUID()}` } });
  return prisma.workspace.create({ data: { projectId: project.id, containerId: 'test-container-not-real', status: 'RUNNING' } });
}

async function makeTerminalFixture(organizationId: string, overrides: Partial<{ active: boolean }> = {}) {
  const workspace = await makeWorkspaceFixture(organizationId);
  return prisma.terminalSession.create({ data: { workspaceId: workspace.id, tmuxName: 'test-tmux', title: 'Fixture', active: overrides.active ?? true } });
}

type HandshakeResult = 'open' | { code: number; reason: string };

function attemptHandshake(path: string, headers: Record<string, string>): Promise<HandshakeResult> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${wsBaseUrl}${path}`, { headers });
    const timeout = setTimeout(() => { socket.terminate(); reject(new Error(`WS_HANDSHAKE_TIMEOUT for ${path}`)); }, 5_000);
    let settled = false;
    const settle = (value: HandshakeResult) => { if (settled) return; settled = true; clearTimeout(timeout); resolve(value); };
    // Every rejection path in this app now runs as a normal `preHandler`, which — for a
    // `{websocket:true}`/`wsHandler` route — always completes (or throws) *before* the 101 is ever
    // sent. So a real 'open' here is unambiguous proof of success; no grace window needed.
    socket.on('open', () => { settle('open'); socket.close(); });
    socket.on('close', (code, reasonBuf) => settle({ code, reason: reasonBuf.toString() }));
    socket.on('unexpected-response', (_req, res) => settle({ code: res.statusCode ?? 0, reason: '' }));
    socket.on('error', () => { /* the close/unexpected-response handlers above carry the real signal */ });
  });
}

describe('terminal WebSocket authorization (real server, real WebSocket handshake)', () => {
  it('rejects a handshake with no Origin header (plain HTTP error, no upgrade)', async () => {
    const { cookie, organizationId } = await registerUser();
    const terminal = await makeTerminalFixture(organizationId);
    const result = await attemptHandshake(`/api/v1/terminals/${terminal.id}/connect`, { cookie });
    expect(result).not.toBe('open');
    expect((result as { code: number }).code).toBe(403);
  });

  it('rejects a handshake from a malicious origin, including lookalike domains', async () => {
    const { cookie, organizationId } = await registerUser();
    const terminal = await makeTerminalFixture(organizationId);
    const maliciousOrigins = [
      'https://evil.example',
      `${WEB_ORIGIN}.evil.example`, // "starts with the real origin" — must not pass a prefix check
      `https://evil.example?${WEB_ORIGIN}`, // real origin appears, just not as the actual Origin
      WEB_ORIGIN.replace('http://', 'https://') // wrong scheme is a different origin entirely
    ];
    for (const origin of maliciousOrigins) {
      const result = await attemptHandshake(`/api/v1/terminals/${terminal.id}/connect`, { cookie, Origin: origin });
      expect(result, `origin "${origin}" should have been rejected`).not.toBe('open');
      expect((result as { code: number }).code).toBe(403);
    }
  });

  it('rejects a handshake with no session cookie', async () => {
    const { organizationId } = await registerUser();
    const terminal = await makeTerminalFixture(organizationId);
    const result = await attemptHandshake(`/api/v1/terminals/${terminal.id}/connect`, { Origin: WEB_ORIGIN });
    expect(result).not.toBe('open');
    expect((result as { code: number }).code).toBe(401);
  });

  it('rejects a handshake with an invalid session cookie', async () => {
    const { organizationId } = await registerUser();
    const terminal = await makeTerminalFixture(organizationId);
    const result = await attemptHandshake(`/api/v1/terminals/${terminal.id}/connect`, { Origin: WEB_ORIGIN, cookie: 'odc_session=not-a-real-token' });
    expect(result).not.toBe('open');
    expect((result as { code: number }).code).toBe(401);
  });

  it('rejects a handshake with an expired session', async () => {
    const { cookie, organizationId } = await registerUser();
    const terminal = await makeTerminalFixture(organizationId);
    const token = decodeURIComponent(cookie.split('=')[1]!);
    await prisma.session.update({ where: { tokenHash: hashToken(token) }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const result = await attemptHandshake(`/api/v1/terminals/${terminal.id}/connect`, { Origin: WEB_ORIGIN, cookie });
    expect(result).not.toBe('open');
    expect((result as { code: number }).code).toBe(401);
  });

  it('rejects a user with no membership in the terminal\'s organization (cross-org access)', async () => {
    const owner = await registerUser();
    const outsider = await registerUser();
    const terminal = await makeTerminalFixture(owner.organizationId);
    const result = await attemptHandshake(`/api/v1/terminals/${terminal.id}/connect`, { Origin: WEB_ORIGIN, cookie: outsider.cookie });
    expect(result).not.toBe('open');
    expect((result as { code: number }).code).toBe(403);
  });

  it('a well-formed, correctly-authorized request passes Origin/cookie/ownership checks before failing for a distinct reason', async () => {
    const { cookie, organizationId } = await registerUser();
    // `active: false` makes the route fail for a *different*, later reason (409 TERMINAL_UNAVAILABLE)
    // instead of an auth-layer 401/403 — proving the request got all the way past Origin/session/RBAC
    // — without needing a real container. The full golden path with a real container/terminal is
    // covered by apps/api/src/e2e.test.ts.
    const terminal = await makeTerminalFixture(organizationId, { active: false });
    const result = await attemptHandshake(`/api/v1/terminals/${terminal.id}/connect`, { Origin: WEB_ORIGIN, cookie });
    expect(result).not.toBe('open');
    expect((result as { code: number }).code).toBe(409);
  });
});

describe('runtime proxy WebSocket authorization (real server, real WebSocket handshake)', () => {
  it('rejects a handshake with no Origin header', async () => {
    const { cookie, organizationId } = await registerUser();
    const workspace = await makeWorkspaceFixture(organizationId);
    const result = await attemptHandshake(`/api/v1/proxy/ide/${workspace.id}/`, { cookie });
    expect(result).not.toBe('open');
    expect((result as { code: number }).code).toBe(403);
  });

  it('rejects a handshake from a malicious/lookalike origin', async () => {
    const { cookie, organizationId } = await registerUser();
    const workspace = await makeWorkspaceFixture(organizationId);
    const result = await attemptHandshake(`/api/v1/proxy/ide/${workspace.id}/`, { cookie, Origin: `${WEB_ORIGIN}.evil.example` });
    expect(result).not.toBe('open');
    expect((result as { code: number }).code).toBe(403);
  });

  it('rejects a handshake with no session cookie', async () => {
    const { organizationId } = await registerUser();
    const workspace = await makeWorkspaceFixture(organizationId);
    const result = await attemptHandshake(`/api/v1/proxy/ide/${workspace.id}/`, { Origin: WEB_ORIGIN });
    expect(result).not.toBe('open');
    expect((result as { code: number }).code).toBe(401);
  });

  it('rejects a user with no membership in the workspace\'s organization (cross-org access)', async () => {
    const owner = await registerUser();
    const outsider = await registerUser();
    const workspace = await makeWorkspaceFixture(owner.organizationId);
    const result = await attemptHandshake(`/api/v1/proxy/ide/${workspace.id}/`, { Origin: WEB_ORIGIN, cookie: outsider.cookie });
    expect(result).not.toBe('open');
    expect((result as { code: number }).code).toBe(403);
  });

  it('a well-formed, correctly-authorized request passes Origin/cookie/role checks (fails later, resolving the real container)', async () => {
    // The fixture's containerId ('test-container-not-real') doesn't exist, so the real broker's
    // real Docker daemon gives a clean 404 for it — but only *after* Origin/session/role have all
    // already passed, which is what this test is actually proving (getting a 404 from a workspace-
    // resolution failure — instead of the 401/403 the earlier tests in this block assert on — is
    // only possible once every explicit authorization check above it in requireIdeAccess() has
    // already succeeded).
    const { cookie, organizationId } = await registerUser();
    const workspace = await makeWorkspaceFixture(organizationId);
    const result = await attemptHandshake(`/api/v1/proxy/ide/${workspace.id}/`, { Origin: WEB_ORIGIN, cookie });
    expect(result).not.toBe('open');
    expect((result as { code: number }).code).toBe(404);
  });

  it('rejects a preview handshake for a port that was never registered on the workspace', async () => {
    const { cookie, organizationId } = await registerUser();
    const workspace = await makeWorkspaceFixture(organizationId);
    const result = await attemptHandshake(`/api/v1/proxy/preview/${workspace.id}/59999/`, { Origin: WEB_ORIGIN, cookie });
    expect(result).not.toBe('open');
    expect((result as { code: number }).code).toBe(404);
  });

  it('a well-formed preview request for a registered port passes every check (fails later, resolving the real container)', async () => {
    const { cookie, organizationId } = await registerUser();
    const workspace = await makeWorkspaceFixture(organizationId);
    await prisma.workspacePort.create({ data: { workspaceId: workspace.id, port: 5173, label: 'vite' } });
    const result = await attemptHandshake(`/api/v1/proxy/preview/${workspace.id}/5173/`, { Origin: WEB_ORIGIN, cookie });
    expect(result).not.toBe('open');
    expect((result as { code: number }).code).toBe(404);
  });
});

describe('upgrade ownership (real server)', () => {
  it('exactly one "upgrade" listener is registered on the shared HTTP server', () => {
    // Regression guard for the P0 this whole file exists to close: runtimeProxy.ts used to register
    // its own global `server.on('upgrade', ...)` alongside @fastify/websocket's own global listener,
    // and the two raced for ownership of every upgrade request server-wide. @fastify/websocket must
    // now be the sole owner.
    expect(app.server.listenerCount('upgrade')).toBe(1);
  });

  it('a rejected handshake never sends a 101 followed by rejection bytes — it gets one clean non-101 HTTP response', async () => {
    const { cookie, organizationId } = await registerUser();
    const workspace = await makeWorkspaceFixture(organizationId);
    const result = await new Promise<{ upgraded: boolean; statusCode?: number; extraDataAfterResponse: boolean }>((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port, path: `/api/v1/proxy/ide/${workspace.id}/`,
        headers: {
          Connection: 'Upgrade', Upgrade: 'websocket',
          'Sec-WebSocket-Version': '13',
          'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'),
          Origin: 'https://evil.example', // deliberately disallowed — this handshake must be rejected
          Cookie: cookie
        }
      });
      const timeout = setTimeout(() => { req.destroy(); reject(new Error('RAW_HANDSHAKE_TIMEOUT')); }, 5_000);
      req.on('upgrade', (_res, socket) => {
        clearTimeout(timeout);
        let extraDataAfterResponse = false;
        socket.on('data', () => { extraDataAfterResponse = true; });
        setTimeout(() => resolve({ upgraded: true, extraDataAfterResponse }), 200);
      });
      req.on('response', res => {
        clearTimeout(timeout);
        let extraDataAfterResponse = false;
        res.on('data', () => {});
        res.on('end', () => setTimeout(() => resolve({ upgraded: false, statusCode: res.statusCode, extraDataAfterResponse }), 200));
        res.socket?.on('data', chunk => { if (res.complete) extraDataAfterResponse = extraDataAfterResponse || chunk.length > 0; });
      });
      req.on('error', reject);
      req.end();
    });
    expect(result.upgraded).toBe(false);
    expect(result.statusCode).toBe(403);
    expect(result.extraDataAfterResponse).toBe(false);
  });
});

describe('IDE proxy — actually functions end-to-end through the route, not just a successful handshake', () => {
  // The one piece deliberately not exercised against a real workspace container is network
  // resolution itself — `DockerIdeEngine.internalHost()` is stubbed to point at a real local
  // WebSocket server standing in for code-server, bound to the real IDE_PORT, so the relay target is
  // fully controllable instead of depending on a real container's IP. Everything else
  // (Origin, session, RBAC, the route/preHandler/wsHandler wiring, and the bridge relay itself) is
  // exercised for real, end-to-end, through the actual HTTP server.
  let fakeIde: WebSocketServer;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let internalHostSpy: any;

  beforeAll(async () => {
    fakeIde = new WebSocketServer({ port: IDE_PORT, host: '127.0.0.1' });
    fakeIde.on('connection', (ws, req) => {
      ws.on('message', (data, isBinary) => ws.send(Buffer.concat([Buffer.from('echo:'), Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer)]), { binary: isBinary }));
      ws.send(`connected:${req.url}`);
    });
    await new Promise<void>(resolve => fakeIde.once('listening', resolve));
  });

  afterAll(async () => {
    await new Promise<void>(resolve => fakeIde.close(() => resolve()));
  });

  // vitest.config.ts sets `restoreMocks: true`, which auto-restores every mock *before each test*
  // (like an implicit global beforeEach) — a spy installed in this describe's own `beforeAll` would
  // already be torn down by the time the test body runs. A `beforeEach` scoped to this describe
  // block runs after that global restore, so the spy is still in effect for the actual test.
  beforeEach(() => {
    internalHostSpy = vi.spyOn(DockerIdeEngine.prototype, 'internalHost').mockResolvedValue('127.0.0.1');
  });

  it('relays a real message through Origin+session+RBAC validation, the route, and the bridge to the "container" and back', async () => {
    const { cookie, organizationId } = await registerUser();
    const workspace = await makeWorkspaceFixture(organizationId);

    const client = new WebSocket(`${wsBaseUrl}/api/v1/proxy/ide/${workspace.id}/some/sub/path`, { headers: { cookie, Origin: WEB_ORIGIN } });
    try {
      const opened = new Promise<void>((resolve, reject) => { client.once('open', () => resolve()); client.once('error', reject); client.once('unexpected-response', (_r, res) => reject(new Error(`unexpected ${res.statusCode}`))); });
      await opened;

      // Proves the suffix path (everything after /api/v1/proxy/ide/<id>/) was forwarded to the
      // upstream unchanged — the fake IDE echoes back the URL it received on connect.
      const greeting = await new Promise<string>(resolve => client.once('message', data => resolve(data.toString())));
      expect(greeting).toBe('connected:/some/sub/path');

      const echoed = new Promise<string>(resolve => client.once('message', data => resolve(data.toString())));
      client.send('ping through the proxy');
      expect(await echoed).toBe('echo:ping through the proxy');
    } finally {
      client.close();
    }
  });
});

describe('preview proxy — actually functions end-to-end through the route', () => {
  const PREVIEW_PORT = 47_211;
  let fakePreview: WebSocketServer;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let internalHostSpy: any;

  beforeAll(async () => {
    fakePreview = new WebSocketServer({ port: PREVIEW_PORT, host: '127.0.0.1' });
    fakePreview.on('connection', ws => ws.on('message', (data, isBinary) => ws.send(Buffer.concat([Buffer.from('echo:'), Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer)]), { binary: isBinary })));
    await new Promise<void>(resolve => fakePreview.once('listening', resolve));
  });

  afterAll(async () => {
    await new Promise<void>(resolve => fakePreview.close(() => resolve()));
  });

  beforeEach(() => {
    internalHostSpy = vi.spyOn(DockerIdeEngine.prototype, 'internalHost').mockResolvedValue('127.0.0.1');
  });

  it('relays a real message through the registered-port check, RBAC, and the bridge to the "container" preview and back', async () => {
    const { cookie, organizationId } = await registerUser();
    const workspace = await makeWorkspaceFixture(organizationId);
    await prisma.workspacePort.create({ data: { workspaceId: workspace.id, port: PREVIEW_PORT, label: 'preview' } });

    const client = new WebSocket(`${wsBaseUrl}/api/v1/proxy/preview/${workspace.id}/${PREVIEW_PORT}/`, { headers: { cookie, Origin: WEB_ORIGIN } });
    try {
      const opened = new Promise<void>((resolve, reject) => { client.once('open', () => resolve()); client.once('error', reject); client.once('unexpected-response', (_r, res) => reject(new Error(`unexpected ${res.statusCode}`))); });
      await opened;
      const echoed = new Promise<string>(resolve => client.once('message', data => resolve(data.toString())));
      client.send('ping through the preview proxy');
      expect(await echoed).toBe('echo:ping through the preview proxy');
    } finally {
      client.close();
    }
  });
});
