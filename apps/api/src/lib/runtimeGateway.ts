import httpProxy from 'http-proxy';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type WebSocket from 'ws';
import { z } from 'zod';
import { prisma, Role } from '@oliveira/database';
import { DockerIdeEngine, IDE_PORT } from '@oliveira/ide-engine';
import { requireOrgRole, hasRole } from './auth.js';
import { bridgeWebSocket } from './wsBridge.js';
import { issueRuntimeTicket, verifyRuntimeTicket, type RuntimeTicketPurpose } from './runtimeTicket.js';

declare module 'fastify' {
  interface FastifyRequest {
    runtimeTarget?: { host: string; port: number };
    // Set by the preHandler when access was granted via a fresh ticket (not an existing runtime
    // cookie) — the handler uses this to mint the cookie and strip the ticket from the URL.
    runtimeNewCookie?: { name: string; value: string };
  }
}

const ide = new DockerIdeEngine();
const proxy = httpProxy.createProxyServer({ ws: false, xfwd: true, changeOrigin: false });
proxy.on('error', (_err, _req, res) => {
  if ('writeHead' in res && !res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
  if ('end' in res) res.end(JSON.stringify({ error: 'RUNTIME_GATEWAY_PROXY_ERROR' }));
});

function runtimeBaseDomain(): string {
  return process.env.RUNTIME_BASE_DOMAIN ?? 'runtime.localhost';
}

interface ParsedRuntimeHost { purpose: RuntimeTicketPurpose; workspaceId: string; port?: number }

function parseRuntimeHost(hostHeader: string | undefined): ParsedRuntimeHost | null {
  if (!hostHeader) return null;
  const host = hostHeader.split(':')[0]!.toLowerCase();
  const base = runtimeBaseDomain().toLowerCase();
  if (!host.endsWith(`.${base}`)) return null;
  const subdomain = host.slice(0, -(base.length + 1));
  const ideMatch = subdomain.match(/^ide-([a-z0-9]+)$/);
  if (ideMatch) return { purpose: 'ide', workspaceId: ideMatch[1]! };
  const previewMatch = subdomain.match(/^preview-([a-z0-9]+)-(\d+)$/);
  if (previewMatch) return { purpose: 'preview', workspaceId: previewMatch[1]!, port: Number(previewMatch[2]) };
  return null;
}

function runtimeHostPattern(): RegExp {
  const escaped = runtimeBaseDomain().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^(ide|preview)-[a-z0-9]+(-\\d+)?\\.${escaped}(:\\d+)?$`, 'i');
}

function runtimeCookieName(parsed: ParsedRuntimeHost): string {
  return parsed.purpose === 'ide' ? `odc_runtime_ide_${parsed.workspaceId}` : `odc_runtime_preview_${parsed.workspaceId}_${parsed.port}`;
}

const RUNTIME_COOKIE_TTL_MS = 12 * 60 * 60 * 1000; // 12h — after this, reloading from the panel (a fresh ticket) is required
const RUNTIME_TICKET_TTL_MS = 60_000; // just long enough for the initial redirect round trip

function matchesTarget(payload: { workspaceId: string; purpose: RuntimeTicketPurpose; port?: number }, parsed: ParsedRuntimeHost): boolean {
  if (payload.workspaceId !== parsed.workspaceId || payload.purpose !== parsed.purpose) return false;
  if (parsed.purpose === 'preview' && payload.port !== parsed.port) return false;
  return true;
}

// Runs as `preHandler` on every request to *.runtime.<domain> — for both the plain-HTTP and the
// WebSocket path through the same route, since @fastify/websocket only sends its 101 once the
// route's own handler/wsHandler runs, strictly after preHandler resolves. A request that fails
// here gets a normal HTTP error response; no upgrade is ever attempted.
//
// Deliberately no Origin allowlist check here, unlike terminals.ts/runtimeProxy.ts: those protect a
// panel-origin resource, so a legitimate request's Origin is always the panel's. Here the legitimate
// caller *is* the runtime origin itself (code-server's own same-origin fetch/WS calls back to
// ide-<id>.runtime.<domain>) or a bare top-level navigation (the ticket redirect), neither of which
// has "the panel" as an Origin to check against. The actual cross-site defense is the credential
// model: a foreign page can't read the ticket (never stored anywhere it could reach), and the
// runtime cookie is SameSite=Lax + host-only, so a foreign origin's fetch/WS calls (unlike a
// top-level navigation) don't carry it at all.
async function requireRuntimeAccess(request: FastifyRequest) {
  const parsed = parseRuntimeHost(request.headers.host);
  if (!parsed) throw Object.assign(new Error('UNKNOWN_RUNTIME_HOST'), { statusCode: 404 });

  const cookieValue = request.cookies?.[runtimeCookieName(parsed)];
  const cookiePayload = cookieValue ? verifyRuntimeTicket(cookieValue) : null;
  const usingExistingCookie = cookiePayload !== null && matchesTarget(cookiePayload, parsed);

  let uid: string;
  if (usingExistingCookie) {
    uid = cookiePayload!.uid;
  } else {
    const ticket = (request.query as Record<string, unknown> | undefined)?.t;
    if (typeof ticket !== 'string') throw Object.assign(new Error('RUNTIME_TICKET_REQUIRED'), { statusCode: 401 });
    const ticketPayload = verifyRuntimeTicket(ticket);
    // Deliberately the same error/status for "invalid signature/expired" and "valid ticket, wrong
    // workspace/purpose/port" — a ticket for workspace A must not distinguish "wrong workspace" from
    // "garbage token" when probed against workspace B's host.
    if (!ticketPayload || !matchesTarget(ticketPayload, parsed)) throw Object.assign(new Error('RUNTIME_TICKET_INVALID'), { statusCode: 401 });
    uid = ticketPayload.uid;
  }

  // Re-checked on *every* request, ticket-path or cookie-path — a runtime cookie can live for
  // hours, and a user removed from the organization partway through that window must lose access
  // on their very next request, not just fail to obtain a new ticket.
  const workspace = await prisma.workspace.findUnique({ where: { id: parsed.workspaceId }, include: { project: true } });
  if (!workspace?.containerId) throw Object.assign(new Error('WORKSPACE_NOT_FOUND'), { statusCode: 404 });
  const membership = await prisma.organizationMember.findFirst({ where: { userId: uid, organizationId: workspace.project.organizationId } });
  if (!membership || !hasRole(membership.role, Role.DEVELOPER)) throw Object.assign(new Error('FORBIDDEN'), { statusCode: 403 });

  if (parsed.purpose === 'preview') {
    const registered = await prisma.workspacePort.findUnique({ where: { workspaceId_port: { workspaceId: parsed.workspaceId, port: parsed.port! } } });
    if (!registered) throw Object.assign(new Error('PREVIEW_PORT_NOT_REGISTERED'), { statusCode: 404 });
  }

  if (!usingExistingCookie) {
    const value = issueRuntimeTicket({ uid, workspaceId: parsed.workspaceId, purpose: parsed.purpose, port: parsed.port }, RUNTIME_COOKIE_TTL_MS);
    request.runtimeNewCookie = { name: runtimeCookieName(parsed), value };
  }

  const host = await ide.internalHost(workspace.containerId);
  request.runtimeTarget = { host, port: parsed.purpose === 'ide' ? IDE_PORT : parsed.port! };
}

function applyRuntimeSecurityHeaders(reply: FastifyReply) {
  // Scoped narrowly to what this proxied, arbitrary/user-controlled content actually needs
  // constrained: who may iframe it, and that it never leaks a referrer (which could carry a ticket
  // in the URL) to whatever the container itself links out to. A full page CSP (script-src etc.)
  // would break the proxied app (code-server, arbitrary preview apps) and isn't this boundary's job.
  reply.header('Content-Security-Policy', `frame-ancestors ${process.env.WEB_ORIGIN ?? 'http://localhost:3000'}`);
  reply.header('Referrer-Policy', 'no-referrer');
  reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  reply.header('X-Content-Type-Options', 'nosniff');
}

function setRuntimeCookie(reply: FastifyReply, cookie: { name: string; value: string } | undefined) {
  if (!cookie) return;
  // No `domain` attribute — host-only, scoped to this *exact* subdomain (e.g.
  // ide-<workspaceId>.runtime.<base>), never sent to a sibling workspace's or preview's subdomain.
  reply.setCookie(cookie.name, cookie.value, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: RUNTIME_COOKIE_TTL_MS / 1000
  });
}

function stripPrefix(url: string | undefined) {
  const raw = url ?? '/';
  const [path, query = ''] = raw.split('?');
  const params = new URLSearchParams(query);
  params.delete('t');
  const rest = params.toString();
  return rest ? `${path}?${rest}` : path!;
}

const OTHER_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const;

export function registerRuntimeGateway(app: FastifyInstance) {
  const httpHandler = async (request: FastifyRequest, reply: FastifyReply) => {
    applyRuntimeSecurityHeaders(reply);
    setRuntimeCookie(reply, request.runtimeNewCookie);
    if (request.runtimeNewCookie) {
      // A ticket was just consumed — never let it linger in the URL bar/history/onward referrers.
      // One extra round trip on first load only; every request after this carries the cookie.
      return reply.redirect(stripPrefix(request.raw.url), 302);
    }
    const { host, port } = request.runtimeTarget!;
    reply.hijack();
    proxy.web(request.raw, reply.raw, { target: `http://${host}:${port}` });
  };

  const wsHandler = async (socket: WebSocket, request: FastifyRequest) => {
    const { host, port } = request.runtimeTarget!;
    const suffix = stripPrefix(request.raw.url);
    await bridgeWebSocket(socket, { targetUrl: `ws://${host}:${port}${suffix}` });
  };

  app.route({ method: 'GET', url: '*', constraints: { host: runtimeHostPattern() }, preHandler: requireRuntimeAccess, handler: httpHandler, wsHandler });
  app.route({ method: [...OTHER_METHODS], url: '*', constraints: { host: runtimeHostPattern() }, preHandler: requireRuntimeAccess, handler: httpHandler });
}

const ticketRequestSchema = z.object({
  workspaceId: z.string().cuid(),
  purpose: z.enum(['ide', 'preview']),
  port: z.number().int().min(1).max(65535).optional()
}).refine(v => v.purpose === 'ide' || typeof v.port === 'number', { message: 'port is required when purpose is "preview"' });

export async function registerRuntimeTicketRoute(app: FastifyInstance) {
  app.post('/api/v1/runtime-tickets', async request => {
    const body = ticketRequestSchema.parse(request.body);
    const workspace = await prisma.workspace.findUnique({ where: { id: body.workspaceId }, include: { project: true } });
    if (!workspace) throw Object.assign(new Error('WORKSPACE_NOT_FOUND'), { statusCode: 404 });
    const { user } = await requireOrgRole(request, workspace.project.organizationId, Role.DEVELOPER);
    if (body.purpose === 'preview') {
      const registered = await prisma.workspacePort.findUnique({ where: { workspaceId_port: { workspaceId: body.workspaceId, port: body.port! } } });
      if (!registered) throw Object.assign(new Error('PREVIEW_PORT_NOT_REGISTERED'), { statusCode: 404 });
    }
    const ticket = issueRuntimeTicket({ uid: user.id, workspaceId: body.workspaceId, purpose: body.purpose, port: body.port }, RUNTIME_TICKET_TTL_MS);
    const base = runtimeBaseDomain();
    const host = body.purpose === 'ide' ? `ide-${body.workspaceId}.${base}` : `preview-${body.workspaceId}-${body.port}.${base}`;
    const scheme = process.env.NODE_ENV === 'production' ? 'https' : 'http';
    return { ticket, expiresAt: new Date(Date.now() + RUNTIME_TICKET_TTL_MS).toISOString(), url: `${scheme}://${host}/?t=${ticket}` };
  });
}
