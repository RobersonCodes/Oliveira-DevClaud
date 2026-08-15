import httpProxy from 'http-proxy';
import type { IncomingMessage } from 'node:http';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type WebSocket from 'ws';
import { z } from 'zod';
import { prisma, Role } from '@oliveira/database';
import { DockerIdeEngine, IDE_PORT } from '@oliveira/ide-engine';
import { requireOrgRole, hasRole } from './auth.js';
import { audit } from './audit.js';
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
proxy.on('proxyRes', proxyRes => applyRuntimeSecurityHeadersToProxyResponse(proxyRes));
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

// Every distinct (workspaceId, purpose, port) triple gets its own subdomain (parseRuntimeHost above)
// and therefore its own cookie name here — cookies are not port-isolated on a shared host, so two
// preview ports on the *same* workspace deliberately get two different hostnames/cookies too, not
// just different workspaces.
function runtimeCookieName(parsed: ParsedRuntimeHost): string {
  // __Host- makes Secure + Path=/ + no Domain browser-enforced invariants. A sibling runtime can
  // still execute arbitrary JavaScript, but the browser will reject any attempt to shadow this
  // credential with a same-named parent-domain cookie.
  return parsed.purpose === 'ide'
    ? `__Host-odc_runtime_ide_${parsed.workspaceId}`
    : `__Host-odc_runtime_preview_${parsed.workspaceId}_${parsed.port}`;
}

const RUNTIME_COOKIE_TTL_MS = 12 * 60 * 60 * 1000; // 12h — after this, reloading from the panel (a fresh ticket) is required
const RUNTIME_TICKET_TTL_MS = 60_000; // just long enough for the initial redirect round trip

function matchesTarget(payload: { workspaceId: string; purpose: RuntimeTicketPurpose; port?: number }, parsed: ParsedRuntimeHost): boolean {
  if (payload.workspaceId !== parsed.workspaceId || payload.purpose !== parsed.purpose) return false;
  if (parsed.purpose === 'preview' && payload.port !== parsed.port) return false;
  return true;
}

// BACKGROUND: an earlier version of this file had *no* Origin check, on the theory that a foreign
// origin's fetch/WS calls don't carry the (SameSite=Lax, host-only) runtime cookie. That reasoning
// is wrong for siblings under the same runtime base domain: SameSite compares the *registrable
// site* (RFC6265bis), not the exact origin, and ide-a.runtime.<domain> / ide-b.runtime.<domain> are
// same-site to each other. So workspace A's own (malicious/compromised) JS can open
// `wss://ide-b.runtime.<domain>/...` and the browser attaches B's cookie — the destination host is
// what determines which cookie goes out, not who initiated the request. Host-only scoping means A
// can't *read* B's cookie, but never stopped A from *triggering* a request that legitimately carries
// it. Per RFC 6455 §10.2, only an exact server-side Origin check closes this for WebSocket.
//
// A SECOND, opposite mistake followed from over-correcting that: requiring Origin on *every* request
// uniformly (including plain GET) breaks the real flow. Per the Fetch Standard's Origin header
// algorithm (https://fetch.spec.whatwg.org/#origin-header), Origin is NOT reliably sent on GET/HEAD
// requests, particularly top-level navigations — and the ticket redemption flow is exactly a
// cross-origin top-level navigation (`<iframe src="https://ide-x.../?t=...">`), immediately followed
// by a same-origin navigation (the 302 redirect), then ordinary same-origin asset GETs from
// code-server's own page. Requiring Origin on all of those would 403 the golden path in real
// browsers even though app.inject()/raw `ws` test clients (which set headers explicitly) never catch
// it. RFC 6455 §10.2, by contrast, DOES guarantee Origin on every WebSocket handshake — browsers
// always send it there, unlike plain GET navigations — so WS keeps a hard requirement.
//
// The policy is therefore split by what actually guarantees Origin:
//  - WebSocket handshake: Origin is REQUIRED and must equal this exact host's own origin — never the
//    panel's (a WS connection is never a top-level navigation *from* the panel; it's always code-
//    server's own same-origin call back to itself).
//  - Mutating HTTP (POST/PUT/PATCH/DELETE): fetch/XHR always sends Origin regardless of method
//    (unlike navigations), so this is REQUIRED too, and — same as WS — only this exact host's own
//    origin is accepted. Nothing on the gateway needs the panel to call it with a mutating method.
//  - GET/HEAD: Origin is validated *if present* (must be the panel or this exact host — this alone
//    still blocks a sibling's fetch()/XHR-based attempt, since those always carry Origin per spec),
//    but its absence is NOT itself a rejection reason. Sec-Fetch-Site is checked as the secondary
//    signal in that case: a `cross-site`/`same-site` value paired with a `Sec-Fetch-Mode` other than
//    `navigate` means "this is a subresource/fetch-like request from another origin, not a top-level
//    navigation" and is rejected even without Origin — closing the residual gap for clients that
//    support Sec-Fetch-* but happen to omit Origin on some subresource GET. If neither header is
//    present (very old browser, or a non-browser client), the request falls through to the
//    ticket/cookie credential check below, which is a real, scoped, short-lived, live-membership-
//    checked secret on its own — exactly the case the ticket path was designed to stand on its own
//    for (a bare GET has no side effects to forge in the first place).
const WS_UPGRADE_HEADER = 'websocket';
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function isWebSocketUpgradeRequest(request: FastifyRequest): boolean {
  const upgrade = request.headers.upgrade;
  return typeof upgrade === 'string' && upgrade.toLowerCase() === WS_UPGRADE_HEADER;
}

function ownOrigin(request: FastifyRequest): string {
  return `${request.protocol}://${request.headers.host}`;
}

function isWellFormedOrigin(origin: unknown): origin is string {
  // A folded/duplicated Origin header (Node joins repeated non-special headers with ", ") must never
  // be treated as a match even if one of the joined values happens to look right.
  return typeof origin === 'string' && origin.length > 0 && !origin.includes(',');
}

function requireExactOwnOrigin(request: FastifyRequest, context: string) {
  const origin = request.headers.origin;
  if (!isWellFormedOrigin(origin) || origin !== ownOrigin(request)) {
    throw Object.assign(new Error(`ORIGIN_NOT_ALLOWED_${context}`), { statusCode: 403 });
  }
}

function validateOriginForGetOrHead(request: FastifyRequest) {
  const origin = request.headers.origin;
  if (isWellFormedOrigin(origin)) {
    const panelOrigin = process.env.WEB_ORIGIN ?? 'http://localhost:3000';
    if (origin !== ownOrigin(request) && origin !== panelOrigin) {
      throw Object.assign(new Error('ORIGIN_NOT_ALLOWED_GET'), { statusCode: 403 });
    }
    return;
  }
  if (origin !== undefined) throw Object.assign(new Error('ORIGIN_NOT_ALLOWED_GET'), { statusCode: 403 }); // malformed/duplicated
  // Origin genuinely absent — fall back to Sec-Fetch-Site/-Mode, sent reliably by every modern
  // browser regardless of whether Origin itself was included.
  const site = request.headers['sec-fetch-site'];
  const mode = request.headers['sec-fetch-mode'];
  const isCrossOriginButNotANavigation = (site === 'cross-site' || site === 'same-site') && mode !== 'navigate';
  if (isCrossOriginButNotANavigation) throw Object.assign(new Error('ORIGIN_NOT_ALLOWED_GET_SEC_FETCH'), { statusCode: 403 });
}

// Runs as `preHandler` on every request to *.runtime.<domain> — for both the plain-HTTP and the
// WebSocket path through the same route, since @fastify/websocket only sends its 101 once the
// route's own handler/wsHandler runs, strictly after preHandler resolves. A request that fails
// here gets a normal HTTP error response; no upgrade is ever attempted.
async function requireRuntimeAccess(request: FastifyRequest) {
  const parsed = parseRuntimeHost(request.headers.host);
  if (!parsed) throw Object.assign(new Error('UNKNOWN_RUNTIME_HOST'), { statusCode: 404 });

  // Checked before touching the ticket/cookie at all — a cross-workspace or cross-site request
  // should never get far enough to learn whether a ticket/cookie would otherwise have worked.
  if (isWebSocketUpgradeRequest(request)) requireExactOwnOrigin(request, 'WS');
  else if (MUTATING_METHODS.has(request.method)) requireExactOwnOrigin(request, 'MUTATION');
  else validateOriginForGetOrHead(request);

  const cookieValue = request.cookies?.[runtimeCookieName(parsed)];
  const cookiePayload = cookieValue ? verifyRuntimeTicket(cookieValue) : null;
  const usingExistingCookie = cookiePayload !== null && matchesTarget(cookiePayload, parsed);

  let credential: { uid: string; sid: string };
  if (usingExistingCookie) {
    credential = cookiePayload!;
  } else {
    const ticket = (request.query as Record<string, unknown> | undefined)?.t;
    if (typeof ticket !== 'string') throw Object.assign(new Error('RUNTIME_TICKET_REQUIRED'), { statusCode: 401 });
    const ticketPayload = verifyRuntimeTicket(ticket);
    // Deliberately the same error/status for "invalid signature/expired" and "valid ticket, wrong
    // workspace/purpose/port" — a ticket for workspace A must not distinguish "wrong workspace" from
    // "garbage token" when probed against workspace B's host.
    if (!ticketPayload || !matchesTarget(ticketPayload, parsed)) throw Object.assign(new Error('RUNTIME_TICKET_INVALID'), { statusCode: 401 });
    credential = ticketPayload;
  }

  // Re-checked on *every* request, ticket-path or cookie-path — a runtime cookie can live for
  // hours, but a revoked/expired control-plane session or removed organization membership must
  // lose access on the very next request or handshake, not just fail to obtain a new ticket.
  const liveSession = await prisma.session.findUnique({ where: { id: credential.sid } });
  if (!liveSession || liveSession.userId !== credential.uid || liveSession.expiresAt <= new Date()) {
    throw Object.assign(new Error('RUNTIME_SESSION_INVALID'), { statusCode: 401 });
  }
  const workspace = await prisma.workspace.findUnique({ where: { id: parsed.workspaceId }, include: { project: true } });
  if (!workspace?.containerId) throw Object.assign(new Error('WORKSPACE_NOT_FOUND'), { statusCode: 404 });
  const membership = await prisma.organizationMember.findFirst({ where: { userId: credential.uid, organizationId: workspace.project.organizationId } });
  if (!membership || !hasRole(membership.role, Role.DEVELOPER)) throw Object.assign(new Error('FORBIDDEN'), { statusCode: 403 });
  await request.enforceIdentityRateLimit?.('user', credential.uid);
  await request.enforceIdentityRateLimit?.('organization', workspace.project.organizationId);

  if (parsed.purpose === 'preview') {
    const registered = await prisma.workspacePort.findUnique({ where: { workspaceId_port: { workspaceId: parsed.workspaceId, port: parsed.port! } } });
    if (!registered) throw Object.assign(new Error('PREVIEW_PORT_NOT_REGISTERED'), { statusCode: 404 });
  }

  if (!usingExistingCookie) {
    const value = issueRuntimeTicket({ ...credential, workspaceId: parsed.workspaceId, purpose: parsed.purpose, port: parsed.port }, RUNTIME_COOKIE_TTL_MS);
    request.runtimeNewCookie = { name: runtimeCookieName(parsed), value };
  }

  const host = await ide.internalHost(workspace.containerId);
  request.runtimeTarget = { host, port: parsed.purpose === 'ide' ? IDE_PORT : parsed.port! };
}

function runtimeSecurityHeaders(): Record<string, string> {
  return {
    'content-security-policy': `frame-ancestors ${process.env.WEB_ORIGIN ?? 'http://localhost:3000'}; connect-src 'self'`,
    'referrer-policy': 'no-referrer',
    'permissions-policy': 'camera=(), microphone=(), geolocation=()',
    'x-content-type-options': 'nosniff'
  };
}

function applyRuntimeSecurityHeadersToProxyResponse(proxyRes: IncomingMessage) {
  // http-proxy copies upstream headers to ServerResponse *after* the gateway handler runs. Mutate
  // proxyRes itself so a workspace-controlled server cannot weaken the gateway's CSP/referrer/
  // permissions boundary or restore X-Frame-Options after we removed Helmet's global value.
  for (const [name, value] of Object.entries(runtimeSecurityHeaders())) proxyRes.headers[name] = value;
  delete proxyRes.headers['x-frame-options'];
}

function applyRuntimeSecurityHeaders(reply: FastifyReply) {
  // Scoped narrowly to what this proxied, arbitrary/user-controlled content actually needs
  // constrained: who may iframe it, and that it never leaks a referrer (which could carry a ticket
  // in the URL) to whatever the container itself links out to. A full page CSP (script-src etc.)
  // would break the proxied app (code-server, arbitrary preview apps) and isn't this boundary's job.
  // connect-src 'self' is defense in depth against the same sibling-subdomain attack the Origin
  // check above closes server-side: per CSP Level 3 §6.4.5, connect-src governs fetch/XHR/WebSocket
  // destinations, so even if the Origin check ever regressed, a browser enforcing this page's CSP
  // would still refuse a same-page script's attempt to open a WebSocket to a *different* origin
  // (including a sibling workspace's).
  //
  // Set directly on the raw response, not via reply.header(): the non-redirect path below calls
  // reply.hijack() and lets http-proxy write straight to reply.raw, which bypasses Fastify's normal
  // header-serialization step entirely — anything queued through reply.header() before a hijack is
  // silently never sent. Only discovered by running this in a real browser: vitest's app.inject()
  // still reports reply.getHeader() correctly (it reads Fastify's own buffered state, not the actual
  // wire bytes), so this exact loss was invisible to every prior test.
  for (const [name, value] of Object.entries(runtimeSecurityHeaders())) reply.raw.setHeader(name, value);
  // @fastify/helmet sets this globally (SAMEORIGIN) before this handler ever runs, which would
  // otherwise block the very cross-origin embed (panel iframing a runtime host) this route exists
  // for — and unlike our own headers above, Helmet sets it early enough via onRequest that it
  // *does* survive hijacking, so it must be explicitly removed rather than just outweighed by CSP.
  // Removing it entirely is deliberate, not just "prefer CSP": some older/non-Chromium engines don't
  // implement the "ignore X-Frame-Options when frame-ancestors is present" fallback rule, so leaving
  // a stale SAMEORIGIN in place would still block them even though this CSP is correct.
  reply.raw.removeHeader('X-Frame-Options');
}

function setRuntimeCookie(reply: FastifyReply, cookie: { name: string; value: string } | undefined) {
  if (!cookie) return;
  // No `domain` attribute — host-only, scoped to this *exact* subdomain (e.g.
  // ide-<workspaceId>.runtime.<base>), never sent to a sibling workspace's or preview's subdomain.
  //
  // Production intentionally places untrusted runtimes on a different registrable domain from the
  // control plane. The iframe is therefore cross-site and requires SameSite=None for its host-only
  // credential to survive ticket redemption and the clean-URL redirect. None requires Secure; real
  // deployments use HTTPS, while Chromium accepts Secure cookies on *.localhost for local E2E.
  reply.setCookie(cookie.name, cookie.value, {
    httpOnly: true,
    sameSite: 'none',
    secure: true,
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
      // A ticket was just redeemed for a cookie — never let it linger in the URL bar/history/onward
      // referrers, even though the ticket string itself remains a valid bearer credential elsewhere
      // until its TTL expires (it isn't single-use). One extra round trip on first load only; every
      // request after this carries the cookie instead.
      return reply.redirect(stripPrefix(request.raw.url), 302);
    }
    const { host, port } = request.runtimeTarget!;
    reply.hijack();
    // Preserve application cookies but strip any upstream Domain attribute. A preview/code-server
    // may scope its own cookies to this exact runtime host; it must not plant cookies into sibling
    // runtimes or a parent domain. Security-sensitive gateway cookies additionally use __Host-.
    proxy.web(request.raw, reply.raw, { target: `http://${host}:${port}`, cookieDomainRewrite: '' });
  };

  const wsHandler = async (socket: WebSocket, request: FastifyRequest) => {
    const { host, port } = request.runtimeTarget!;
    const suffix = stripPrefix(request.raw.url);
    await bridgeWebSocket(socket, { targetUrl: `ws://${host}:${port}${suffix}` });
  };

  app.route({ method: 'GET', url: '*', constraints: { host: runtimeHostPattern() }, preHandler: requireRuntimeAccess, handler: httpHandler, wsHandler });
  // Mutating methods go through the exact same requireRuntimeAccess — the strict Origin check there
  // (exact match against the panel or this host, never a sibling) already is CSRF protection for
  // these, equivalent to (and more broadly supported than) checking Sec-Fetch-Site: same-origin.
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
    const { user, session } = await requireOrgRole(request, workspace.project.organizationId, Role.DEVELOPER);
    if (body.purpose === 'preview') {
      const registered = await prisma.workspacePort.findUnique({ where: { workspaceId_port: { workspaceId: body.workspaceId, port: body.port! } } });
      if (!registered) throw Object.assign(new Error('PREVIEW_PORT_NOT_REGISTERED'), { statusCode: 404 });
    }
    const ticket = issueRuntimeTicket({ uid: user.id, sid: session.id, workspaceId: body.workspaceId, purpose: body.purpose, port: body.port }, RUNTIME_TICKET_TTL_MS);
    await audit({
      userId: user.id,
      organizationId: workspace.project.organizationId,
      action: 'RUNTIME_TICKET_ISSUED',
      resource: 'Workspace',
      resourceId: workspace.id,
      ipAddress: request.ip,
      metadata: { purpose: body.purpose, ...(body.port ? { port: body.port } : {}) }
    });
    const base = runtimeBaseDomain();
    const host = body.purpose === 'ide' ? `ide-${body.workspaceId}.${base}` : `preview-${body.workspaceId}-${body.port}.${base}`;
    const scheme = process.env.NODE_ENV === 'production' ? 'https' : 'http';
    return { ticket, expiresAt: new Date(Date.now() + RUNTIME_TICKET_TTL_MS).toISOString(), url: `${scheme}://${host}/?t=${ticket}` };
  });
}
