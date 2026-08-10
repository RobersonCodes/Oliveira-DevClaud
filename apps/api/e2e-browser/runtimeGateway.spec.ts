import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import { test, expect } from '@playwright/test';
import type { FastifyInstance } from 'fastify';
import { prisma } from '@oliveira/database';
import { DockerIdeEngine, IDE_PORT } from '@oliveira/ide-engine';

// Real-Chromium coverage for the exact gap a fake `Origin: ...` header in vitest/app.inject() can't
// surface: whether the *actual* browser-sent headers (Origin present or not, Sec-Fetch-Site/-Mode/
// -Dest) on a genuine cross-origin iframe navigation, its redirect, its asset loads, and a same-
// origin WebSocket it opens, are what requireRuntimeAccess() in runtimeGateway.ts actually expects —
// and that a *different* workspace's page cannot reuse a victim's real, valid runtime cookie.
//
// The "panel" is a real HTTP server on 127.0.0.1, not a context.route()-fulfilled fake origin: Chrome's
// Local Network Access checks block a page whose own address-space is unresolved/ambiguous (which is
// what a purely intercepted, never-actually-connected response looks like to Chrome) from reaching a
// loopback-bound target such as the runtime gateway, with net::ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS
// — discovered by running this suite, not something vitest's app.inject() could ever have caught.
const RUNTIME_BASE_DOMAIN = 'runtime.localhost';
process.env.RUNTIME_BASE_DOMAIN = RUNTIME_BASE_DOMAIN;
process.env.RUNTIME_TICKET_SECRET = 'playwright-e2e-secret-do-not-use-in-prod';

let app: FastifyInstance;
let apiPort: number;
let fakeIdeServer: http.Server;
let fakeIde: WebSocketServer;
let panelServer: http.Server;
let panelPort: number;
const panelPages = new Map<string, string>();
const createdUserIds: string[] = [];
const createdOrgIds: string[] = [];

test.beforeAll(async () => {
  panelServer = http.createServer((req, res) => {
    const html = panelPages.get(req.url ?? '');
    if (!html) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(html);
  });
  await new Promise<void>(resolve => panelServer.listen(0, '127.0.0.1', resolve));
  panelPort = (panelServer.address() as AddressInfo).port;
  process.env.WEB_ORIGIN = `http://app.localhost:${panelPort}`;

  const { buildApp } = await import('../src/app.js');
  app = await buildApp({ logger: false, disableRateLimit: true });
  await app.listen({ port: 0, host: '127.0.0.1' });
  apiPort = (app.server.address() as AddressInfo).port;

  // Stand-in for code-server: a real HTTP+WS server on one port, serving a recognizable page and
  // echoing WS messages — proxied to via the gateway exactly like a real workspace container would be.
  fakeIdeServer = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><html><body id="marker">FAKE_IDE_LOADED_OK</body></html>');
  });
  fakeIde = new WebSocketServer({ server: fakeIdeServer });
  fakeIde.on('connection', ws => ws.on('message', (data, isBinary) => ws.send(data, { binary: isBinary })));
  // Bound to the real, fixed IDE_PORT: the gateway's 'ide' purpose always proxies to that exact
  // port (see runtimeGateway.ts), never a dynamically discovered one.
  await new Promise<void>(resolve => fakeIdeServer.listen(IDE_PORT, '127.0.0.1', resolve));

  // No real Docker on this host — point every workspace's "container" at the fake IDE server above.
  DockerIdeEngine.prototype.internalHost = async () => '127.0.0.1';
});

test.afterAll(async () => {
  for (const id of createdOrgIds) await prisma.organization.delete({ where: { id } }).catch(() => undefined);
  for (const id of createdUserIds) await prisma.user.delete({ where: { id } }).catch(() => undefined);
  await new Promise<void>(resolve => fakeIde.close(() => resolve()));
  await new Promise<void>(resolve => fakeIdeServer.close(() => resolve()));
  await new Promise<void>(resolve => panelServer.close(() => resolve()));
  await app.close();
});

async function registerUserAndOrg() {
  const email = `${crypto.randomUUID()}@example.test`;
  const res = await fetch(`http://127.0.0.1:${apiPort}/api/v1/auth/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'Correct-Horse-Battery-9', name: 'Playwright User' })
  });
  const user = await res.json();
  createdUserIds.push(user.id);
  const cookie = res.headers.get('set-cookie')!.split(';')[0];
  const membership = await prisma.organizationMember.findFirstOrThrow({ where: { userId: user.id } });
  createdOrgIds.push(membership.organizationId);
  return { sessionCookie: cookie, organizationId: membership.organizationId };
}

async function makeWorkspace(organizationId: string) {
  const project = await prisma.project.create({ data: { organizationId, name: 'PW Fixture', slug: `pw-${crypto.randomUUID()}` } });
  return prisma.workspace.create({ data: { projectId: project.id, containerId: 'test-container', status: 'RUNNING' } });
}

async function issueTicket(sessionCookie: string, workspaceId: string): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${apiPort}/api/v1/runtime-tickets`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: sessionCookie },
    body: JSON.stringify({ workspaceId, purpose: 'ide' })
  });
  const body = await res.json();
  return body.ticket as string;
}

function ideHost(workspaceId: string) { return `ide-${workspaceId}.${RUNTIME_BASE_DOMAIN}:${apiPort}`; }
function panelOrigin() { return `http://app.localhost:${panelPort}`; }
function serveAtPanel(path: string, iframeSrc: string) {
  panelPages.set(path, `<!doctype html><html><body><iframe id="ide" src="${iframeSrc}"></iframe></body></html>`);
  return `${panelOrigin()}${path}`;
}
function ideFrame(page: import('@playwright/test').Page) {
  return page.frame({ url: (u: URL) => u.hostname.startsWith('ide-') });
}

test.describe('Runtime Gateway — real browser (Chromium)', () => {
  test('an iframe embedded in a real panel page navigates through the ticket redirect and loads the real proxied content, with no header spoofing', async ({ page }) => {
    const { sessionCookie, organizationId } = await registerUserAndOrg();
    const workspace = await makeWorkspace(organizationId);
    const ticket = await issueTicket(sessionCookie, workspace.id);
    const iframeSrc = `http://${ideHost(workspace.id)}/?t=${ticket}`;
    const url = serveAtPanel('/panel-test-page', iframeSrc);

    await page.goto(url);
    await expect.poll(() => ideFrame(page), { timeout: 10_000 }).not.toBeNull();
    const frame = ideFrame(page)!;

    await expect.poll(() => frame.url(), { timeout: 10_000 }).not.toContain('t=');
    await expect(frame.locator('#marker')).toHaveText('FAKE_IDE_LOADED_OK', { timeout: 10_000 });
  });

  test('a same-origin WebSocket opened from inside the loaded IDE frame succeeds', async ({ page }) => {
    const { sessionCookie, organizationId } = await registerUserAndOrg();
    const workspace = await makeWorkspace(organizationId);
    const ticket = await issueTicket(sessionCookie, workspace.id);
    const host = ideHost(workspace.id);
    const url = serveAtPanel('/panel-test-page-2', `http://${host}/?t=${ticket}`);

    await page.goto(url);
    await expect.poll(() => ideFrame(page), { timeout: 10_000 }).not.toBeNull();
    const frame = ideFrame(page)!;
    await expect(frame.locator('#marker')).toHaveText('FAKE_IDE_LOADED_OK', { timeout: 10_000 });

    const result = await frame.evaluate(targetHost => new Promise(resolve => {
      const ws = new WebSocket(`ws://${targetHost}/`);
      ws.onopen = () => { ws.close(); resolve('open'); };
      ws.onerror = () => resolve('error');
      ws.onclose = (ev: CloseEvent) => resolve(`closed:${ev.code}`);
      setTimeout(() => resolve('timeout'), 8_000);
    }), host);
    expect(result).toBe('open');
  });

  test('CRITICAL: a sibling workspace\'s frame cannot open a WebSocket into the victim workspace, even though the real browser attaches the victim\'s valid cookie automatically', async ({ page, context }) => {
    const { sessionCookie, organizationId } = await registerUserAndOrg();
    const workspaceVictim = await makeWorkspace(organizationId);
    const workspaceAttacker = await makeWorkspace(organizationId);
    const victimTicket = await issueTicket(sessionCookie, workspaceVictim.id);
    const attackerTicket = await issueTicket(sessionCookie, workspaceAttacker.id);
    const victimHost = ideHost(workspaceVictim.id);
    const attackerHost = ideHost(workspaceAttacker.id);

    // Step 1: the victim actually visits their own IDE first, so the browser holds a real, valid,
    // httpOnly runtime cookie scoped to victimHost — exactly as it would after a normal session.
    const victimUrl = serveAtPanel('/panel-victim', `http://${victimHost}/?t=${victimTicket}`);
    await page.goto(victimUrl);
    await expect.poll(() => ideFrame(page), { timeout: 10_000 }).not.toBeNull();
    const victimCookies = (await context.cookies()).filter(c => c.domain === victimHost.split(':')[0]);
    expect(victimCookies.length, 'the victim visit must have actually set a runtime cookie for its own host').toBeGreaterThan(0);

    // Step 2: navigate the SAME browser context (same cookie jar) to the attacker's own workspace —
    // simulating the attacker's malicious/compromised code running inside their own, legitimately-
    // owned workspace frame.
    const attackerUrl = serveAtPanel('/panel-attacker', `http://${attackerHost}/?t=${attackerTicket}`);
    await page.goto(attackerUrl);
    await expect.poll(() => ideFrame(page), { timeout: 10_000 }).not.toBeNull();
    const attackerFrame = ideFrame(page)!;
    await expect(attackerFrame.locator('#marker')).toHaveText('FAKE_IDE_LOADED_OK', { timeout: 10_000 });

    // Step 3: from *inside the attacker's own frame*, attempt to open a WebSocket into the victim's
    // host. The browser will (correctly — host-only cookie scoping is about who can *read* a cookie,
    // not who can *target* the host it belongs to; SameSite governs the initiating document's
    // top-level site, not which host receives the request) attach the victim's real cookie to this
    // request, because the destination is victimHost. Only the server's Origin check can refuse it.
    const attackResult = await attackerFrame.evaluate(target => new Promise(resolve => {
      const ws = new WebSocket(`ws://${target}/`);
      ws.onopen = () => { ws.close(); resolve('open'); };
      ws.onerror = () => resolve('error');
      ws.onclose = (ev: CloseEvent) => resolve(`closed:${ev.code}`);
      setTimeout(() => resolve('timeout'), 8_000);
    }), victimHost);
    expect(attackResult).not.toBe('open');
  });
});
