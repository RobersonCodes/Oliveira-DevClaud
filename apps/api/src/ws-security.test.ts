import crypto from 'node:crypto';
import WebSocket from 'ws';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@oliveira/database';
import { hashToken } from './lib/auth.js';
import { buildApp } from './app.js';

// Real listening server + a real `ws` client, not `app.inject()` — Origin-header rejection and the
// raw `app.server.on('upgrade', ...)` handler in runtimeProxy.ts can only be exercised through an
// actual WebSocket handshake, not Fastify's in-process request injection.
let app: FastifyInstance;
let baseUrl: string;
let wsBaseUrl: string;
const WEB_ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:3000';
const createdUserIds: string[] = [];
const createdOrgIds: string[] = [];

beforeAll(async () => {
  app = await buildApp({ logger: false, disableRateLimit: true });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
  wsBaseUrl = `ws://127.0.0.1:${port}`;
}, 30_000);

afterEach(async () => {
  while (createdOrgIds.length) await prisma.organization.delete({ where: { id: createdOrgIds.pop()! } }).catch(() => undefined);
  while (createdUserIds.length) await prisma.user.delete({ where: { id: createdUserIds.pop()! } }).catch(() => undefined);
});

afterAll(async () => {
  await app.close();
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
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const settle = (value: HandshakeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (graceTimer) clearTimeout(graceTimer);
      resolve(value);
    };
    socket.on('open', () => {
      // `{websocket:true}` fastify routes complete the WS handshake unconditionally and only decide
      // whether to keep the connection *after* opening it (the app-level check runs inside the route
      // handler, post-upgrade) — so `open` firing is not proof of authorization by itself. Give the
      // server a brief window to close the connection for an unauthorized request before treating
      // "opened and stayed open" as a real success.
      graceTimer = setTimeout(() => { settle('open'); socket.close(); }, 300);
    });
    socket.on('close', (code, reasonBuf) => settle({ code, reason: reasonBuf.toString() }));
    socket.on('unexpected-response', (_req, res) => settle({ code: res.statusCode ?? 0, reason: '' }));
    socket.on('error', () => { /* the close/unexpected-response handlers above carry the real signal */ });
  });
}

describe('terminal WebSocket authorization (real server, real WebSocket handshake)', () => {
  it('rejects a handshake with no Origin header', async () => {
    const { cookie, organizationId } = await registerUser();
    const terminal = await makeTerminalFixture(organizationId);
    const result = await attemptHandshake(`/api/v1/terminals/${terminal.id}/connect`, { cookie });
    expect(result).not.toBe('open');
    expect((result as { code: number }).code).toBe(1008);
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
      expect((result as { code: number }).code).toBe(1008);
    }
  });

  it('rejects a handshake with no session cookie', async () => {
    const { organizationId } = await registerUser();
    const terminal = await makeTerminalFixture(organizationId);
    const result = await attemptHandshake(`/api/v1/terminals/${terminal.id}/connect`, { Origin: WEB_ORIGIN });
    expect(result).not.toBe('open');
  });

  it('rejects a handshake with an invalid session cookie', async () => {
    const { organizationId } = await registerUser();
    const terminal = await makeTerminalFixture(organizationId);
    const result = await attemptHandshake(`/api/v1/terminals/${terminal.id}/connect`, { Origin: WEB_ORIGIN, cookie: 'odc_session=not-a-real-token' });
    expect(result).not.toBe('open');
  });

  it('rejects a handshake with an expired session', async () => {
    const { cookie, organizationId } = await registerUser();
    const terminal = await makeTerminalFixture(organizationId);
    const token = decodeURIComponent(cookie.split('=')[1]!);
    await prisma.session.update({ where: { tokenHash: hashToken(token) }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const result = await attemptHandshake(`/api/v1/terminals/${terminal.id}/connect`, { Origin: WEB_ORIGIN, cookie });
    expect(result).not.toBe('open');
  });

  it('rejects a user with no membership in the terminal\'s organization (cross-org access)', async () => {
    const owner = await registerUser();
    const outsider = await registerUser();
    const terminal = await makeTerminalFixture(owner.organizationId);
    const result = await attemptHandshake(`/api/v1/terminals/${terminal.id}/connect`, { Origin: WEB_ORIGIN, cookie: outsider.cookie });
    expect(result).not.toBe('open');
  });

  it('a well-formed, correctly-authorized request passes Origin/cookie/ownership checks (no real container needed to prove this)', async () => {
    const { cookie, organizationId } = await registerUser();
    // `active: false` makes the route fail for a *different*, later reason (TERMINAL_UNAVAILABLE)
    // instead of a real Docker connection — proving the request got past Origin/session/RBAC first,
    // without needing a real container (the golden path with a real container is covered by
    // apps/api/src/e2e.test.ts).
    const terminal = await makeTerminalFixture(organizationId, { active: false });
    const result = await attemptHandshake(`/api/v1/terminals/${terminal.id}/connect`, { Origin: WEB_ORIGIN, cookie });
    expect(result).not.toBe('open');
    expect((result as { code: number; reason: string }).reason).toBe('TERMINAL_UNAVAILABLE');
  });
});

describe('runtime proxy WebSocket authorization (real server, real WebSocket handshake)', () => {
  it('rejects a handshake with no Origin header', async () => {
    const { cookie, organizationId } = await registerUser();
    const workspace = await makeWorkspaceFixture(organizationId);
    const result = await attemptHandshake(`/api/v1/proxy/ide/${workspace.id}/`, { cookie });
    expect(result).not.toBe('open');
  });

  it('rejects a handshake from a malicious/lookalike origin', async () => {
    const { cookie, organizationId } = await registerUser();
    const workspace = await makeWorkspaceFixture(organizationId);
    const result = await attemptHandshake(`/api/v1/proxy/ide/${workspace.id}/`, { cookie, Origin: `${WEB_ORIGIN}.evil.example` });
    expect(result).not.toBe('open');
  });

  it('rejects a handshake with no session cookie', async () => {
    const { organizationId } = await registerUser();
    const workspace = await makeWorkspaceFixture(organizationId);
    const result = await attemptHandshake(`/api/v1/proxy/ide/${workspace.id}/`, { Origin: WEB_ORIGIN });
    expect(result).not.toBe('open');
  });

  it('rejects a user with no membership in the workspace\'s organization (cross-org access)', async () => {
    const owner = await registerUser();
    const outsider = await registerUser();
    const workspace = await makeWorkspaceFixture(owner.organizationId);
    const result = await attemptHandshake(`/api/v1/proxy/ide/${workspace.id}/`, { Origin: WEB_ORIGIN, cookie: outsider.cookie });
    expect(result).not.toBe('open');
  });
});
