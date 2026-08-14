import crypto from 'node:crypto';
import WebSocket from 'ws';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@oliveira/database';
import { startTestBroker } from '@oliveira/runtime-broker/src/testHelpers.js';

/**
 * Minimal end-to-end test: login → create project → start a REAL workspace container (the actual
 * `oliveira-devcloud/workspace-node:1.0` image, not a lightweight stand-in) → open a real terminal
 * session over a real WebSocket → run a real shell command and read its real output → stop the
 * workspace. Every layer is real: Postgres, Docker, tmux, the WebSocket transport, and — since the
 * Fase 4 Runtime Broker migration — a real broker in front of Docker too. No mocks.
 *
 * Requires: DATABASE_URL, DOCKER_SOCKET, and the workspace image already built
 * (`docker build -t oliveira-devcloud/workspace-node:1.0 infra/workspace-images/node`).
 *
 * RUNTIME_BROKER_URL/TOKEN must be set (to a *running* broker) before `./app.js` is ever imported —
 * apps/api/src/routes/{workspaces,terminals,ide}.ts construct their engine clients once, at module
 * load time, so this test starts its own broker and only then dynamically imports buildApp/
 * DockerWorkspaceEngine, rather than statically importing them at the top of the file.
 */
let app: FastifyInstance;
let baseUrl: string;
let wsBaseUrl: string;
let broker: Awaited<ReturnType<typeof startTestBroker>>;
let DockerWorkspaceEngine: typeof import('@oliveira/workspace-engine').DockerWorkspaceEngine;
const createdUserIds: string[] = [];
const createdOrgIds: string[] = [];
const createdWorkspaceIds: string[] = [];

beforeAll(async () => {
  broker = await startTestBroker();
  process.env.RUNTIME_BROKER_URL = broker.url;
  process.env.RUNTIME_BROKER_TOKEN = broker.token;

  ({ DockerWorkspaceEngine } = await import('@oliveira/workspace-engine'));
  const { buildApp } = await import('./app.js');
  app = await buildApp({ logger: false, disableRateLimit: true });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
  wsBaseUrl = `ws://127.0.0.1:${port}`;
}, 60_000);

afterAll(async () => {
  const engine = new DockerWorkspaceEngine();
  for (const workspaceId of createdWorkspaceIds) {
    const ws = await prisma.workspace.findUnique({ where: { id: workspaceId } }).catch(() => null);
    if (ws?.containerId) await engine.destroy(ws.containerId).catch(() => undefined);
  }
  for (const id of createdOrgIds) await prisma.organization.delete({ where: { id } }).catch(() => undefined);
  for (const id of createdUserIds) await prisma.user.delete({ where: { id } }).catch(() => undefined);
  await app.close();
  await broker?.close();
}, 60_000);

function extractSessionCookie(response: Response): string {
  const raw = response.headers.get('set-cookie');
  if (!raw) throw new Error('No set-cookie header on response');
  return raw.split(';')[0];
}

describe('E2E — login → project → real workspace → real terminal → run a command → stop workspace', () => {
  it('runs the full journey against real Postgres + real Docker + a real workspace image', async () => {
    // 1. Register (creates the user, their organization as OWNER, and a session cookie).
    const email = `${crypto.randomUUID()}@example.test`;
    const registerRes = await fetch(`${baseUrl}/api/v1/auth/register`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: 'Correct-Horse-Battery-9', name: 'E2E User' })
    });
    expect(registerRes.status).toBe(201);
    const user = await registerRes.json();
    createdUserIds.push(user.id);
    const sessionCookie = extractSessionCookie(registerRes);

    const membership = await prisma.organizationMember.findFirstOrThrow({ where: { userId: user.id } });
    createdOrgIds.push(membership.organizationId);

    // 2. Create a project (no repositoryUrl — this E2E path exercises workspace/terminal
    // lifecycle, not the separate async clone/provision pipeline).
    const projectRes = await fetch(`${baseUrl}/api/v1/projects`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: sessionCookie },
      body: JSON.stringify({ organizationId: membership.organizationId, name: 'E2E Project' })
    });
    expect(projectRes.status).toBe(201);
    const project = await projectRes.json();

    // 3. Start a real workspace container from the real image.
    const workspaceRes = await fetch(`${baseUrl}/api/v1/workspaces`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: sessionCookie },
      body: JSON.stringify({ projectId: project.id, cpuLimit: 0.5, memoryMb: 512, pidsLimit: 96, diskMb: 512, maxRuntimeMinutes: 15 })
    });
    expect(workspaceRes.status).toBe(201);
    const workspace = await workspaceRes.json();
    createdWorkspaceIds.push(workspace.id);
    expect(workspace.status).toBe('RUNNING');
    expect(workspace.containerId).toBeTruthy();
    expect(workspace).toMatchObject({ cpuLimit: 0.5, memoryMb: 512, pidsLimit: 96, diskMb: 512, maxRuntimeMinutes: 15 });
    expect(workspace.runtimeStartedAt).toBeTruthy();

    // 4. Open a terminal session (creates a real tmux session inside the real container).
    const terminalRes = await fetch(`${baseUrl}/api/v1/terminals`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: sessionCookie },
      body: JSON.stringify({ workspaceId: workspace.id, title: 'E2E terminal' })
    });
    expect(terminalRes.status).toBe(201);
    const terminal = await terminalRes.json();

    // 5. Connect over a real WebSocket and run a real command, reading the real output back.
    const marker = `ODC_E2E_${crypto.randomUUID().replace(/-/g, '')}`;
    const output = await new Promise<string>((resolve, reject) => {
      // A real browser always sends Origin on a WebSocket handshake; the server now rejects
      // handshakes without it (see apps/api/src/lib/wsOrigin.ts), so this has to be set explicitly
      // for a raw `ws` client to represent what an actual browser connection looks like.
      const socket = new WebSocket(`${wsBaseUrl}/api/v1/terminals/${terminal.id}/connect`, { headers: { cookie: sessionCookie, Origin: process.env.WEB_ORIGIN ?? 'http://localhost:3000' } });
      let buffer = '';
      let sent = false;
      const timeout = setTimeout(() => { socket.close(); reject(new Error('Timed out waiting for command output over the terminal WebSocket')); }, 20_000);
      socket.on('message', (data: Buffer) => {
        buffer += data.toString('utf8');
        if (!sent) {
          // The server only registers its own `message` handler once terminalEngine.connect()
          // resolves (a real docker exec against the real container) — sending immediately on the
          // client's `open` event races that and the input is silently dropped. Waiting for the
          // first inbound message (the tmux screen's initial paint) proves the server side is
          // ready. `\r` is a real Enter keypress for a PTY in canonical mode; `\n` alone is not
          // reliably treated as one.
          sent = true;
          setTimeout(() => socket.send(`echo ${marker}\r`), 500);
          return;
        }
        if (buffer.split(marker).length >= 3) {
          // The marker appears at least twice: once echoed back as the typed command, once as the
          // actual `echo` output — safe to conclude the command really ran, not just was received.
          clearTimeout(timeout);
          socket.close();
          resolve(buffer);
        }
      });
      socket.on('error', reject);
    });
    expect(output).toContain(marker);
    expect(output.split(marker).length).toBeGreaterThanOrEqual(3); // typed command + echoed output (+ shell artifacts)

    // 6. Close the terminal and stop the workspace through the real API.
    const closeRes = await fetch(`${baseUrl}/api/v1/terminals/${terminal.id}`, { method: 'DELETE', headers: { cookie: sessionCookie } });
    expect(closeRes.status).toBe(204);

    const stopRes = await fetch(`${baseUrl}/api/v1/workspaces/${workspace.id}/stop`, { method: 'POST', headers: { cookie: sessionCookie } });
    expect(stopRes.status).toBe(200);
    const stopped = await stopRes.json();
    expect(stopped.status).toBe('STOPPED');

    const inspectRes = await fetch(`${baseUrl}/api/v1/workspaces/${workspace.id}`, { headers: { cookie: sessionCookie } });
    const inspected = await inspectRes.json();
    expect(inspected.runtime.running).toBe(false);
  }, 90_000);
});
