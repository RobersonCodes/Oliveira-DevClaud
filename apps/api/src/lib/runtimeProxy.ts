import httpProxy from 'http-proxy';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type WebSocket from 'ws';
import { prisma, Role } from '@oliveira/database';
import { DockerIdeEngine, IDE_PORT } from '@oliveira/ide-engine';
import { requireOrgRole } from './auth.js';
import { isAllowedWsOrigin } from './wsOrigin.js';
import { bridgeWebSocket } from './wsBridge.js';

declare module 'fastify' {
  interface FastifyRequest {
    // Populated by this file's preHandlers; read by the corresponding handler/wsHandler so the
    // workspace/port lookup (a Prisma query plus a real Dockerode call) only happens once per
    // request instead of once for validation and again for proxying.
    proxyTarget?: { host: string; port: number };
  }
}

const proxy = httpProxy.createProxyServer({ ws: false, xfwd: true, changeOrigin: false });
const ide = new DockerIdeEngine();
proxy.on('error', (_err, _req, res) => {
  if ('writeHead' in res && !res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
  if ('end' in res) res.end(JSON.stringify({ error: 'RUNTIME_PROXY_ERROR' }));
});

async function resolveWorkspace(workspaceId: string) {
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, include: { project: true } });
  if (!workspace?.containerId) throw Object.assign(new Error('WORKSPACE_NOT_FOUND'), { statusCode: 404 });
  return workspace;
}

function stripPrefix(url: string | undefined, prefix: string) {
  const raw = url ?? '/';
  const out = raw.startsWith(prefix) ? raw.slice(prefix.length - 1) : raw;
  return out.startsWith('/') ? out : `/${out}`;
}

// Deprecated: superseded by the Runtime Gateway (runtimeGateway.ts), which serves IDE/preview from
// an origin-isolated *.runtime.<domain> host instead of same-origin with the control plane under
// /api/v1/proxy/*. Blocked outright in production — untrusted workspace/preview content must never
// run same-origin with the panel there. Left reachable in development only, for any tooling still
// pointed at the old path during the transition.
function rejectInProduction() {
  if (process.env.NODE_ENV === 'production') throw Object.assign(new Error('DEPRECATED_USE_RUNTIME_GATEWAY'), { statusCode: 410 });
}

// Shared by every proxy route below, and run as a `preHandler` — which, for a WebSocket route,
// executes strictly *before* @fastify/websocket completes the handshake (the 101 only gets sent
// once the route's own handler/wsHandler runs). Throwing here rejects the request with a normal
// HTTP error response and no WebSocket upgrade ever happens — Origin, session, role and workspace
// are all validated before any 101 is possible, for both the HTTP and the WS path through this
// same route.
async function requireIdeAccess(request: FastifyRequest) {
  rejectInProduction();
  if (!isAllowedWsOrigin(request.headers.origin)) throw Object.assign(new Error('ORIGIN_NOT_ALLOWED'), { statusCode: 403 });
  const { workspaceId } = request.params as { workspaceId: string };
  const workspace = await resolveWorkspace(workspaceId);
  await requireOrgRole(request, workspace.project.organizationId, Role.DEVELOPER);
  const host = await ide.internalHost(workspace.containerId!);
  request.proxyTarget = { host, port: IDE_PORT };
}

async function requirePreviewAccess(request: FastifyRequest) {
  rejectInProduction();
  if (!isAllowedWsOrigin(request.headers.origin)) throw Object.assign(new Error('ORIGIN_NOT_ALLOWED'), { statusCode: 403 });
  const { workspaceId, port: rawPort } = request.params as { workspaceId: string; port: string };
  const port = Number(rawPort);
  const registered = Number.isInteger(port) ? await prisma.workspacePort.findUnique({ where: { workspaceId_port: { workspaceId, port } } }) : null;
  if (!registered) throw Object.assign(new Error('PREVIEW_PORT_NOT_REGISTERED'), { statusCode: 404 });
  const workspace = await resolveWorkspace(workspaceId);
  await requireOrgRole(request, workspace.project.organizationId, Role.DEVELOPER);
  const host = await ide.internalHost(workspace.containerId!);
  request.proxyTarget = { host, port };
}

const OTHER_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const;

export function registerRuntimeProxy(app: FastifyInstance) {
  const idePrefix = (workspaceId: string) => `/api/v1/proxy/ide/${workspaceId}/`;
  const previewPrefix = (workspaceId: string, port: string) => `/api/v1/proxy/preview/${workspaceId}/${port}/`;

  const ideHttpHandler = async (request: FastifyRequest, reply: import('fastify').FastifyReply) => {
    const { workspaceId } = request.params as { workspaceId: string };
    const { host, port } = request.proxyTarget!;
    request.raw.url = stripPrefix(request.raw.url, idePrefix(workspaceId));
    reply.hijack();
    proxy.web(request.raw, reply.raw, { target: `http://${host}:${port}` });
  };
  const ideWsHandler = async (socket: WebSocket, request: FastifyRequest) => {
    const { workspaceId } = request.params as { workspaceId: string };
    const { host, port } = request.proxyTarget!;
    const suffix = stripPrefix(request.raw.url, idePrefix(workspaceId));
    await bridgeWebSocket(socket, { targetUrl: `ws://${host}:${port}${suffix}` });
  };

  app.route({ method: 'GET', url: '/api/v1/proxy/ide/:workspaceId/*', preHandler: requireIdeAccess, handler: ideHttpHandler, wsHandler: ideWsHandler });
  app.route({ method: [...OTHER_METHODS], url: '/api/v1/proxy/ide/:workspaceId/*', preHandler: requireIdeAccess, handler: ideHttpHandler });

  const previewHttpHandler = async (request: FastifyRequest, reply: import('fastify').FastifyReply) => {
    const { workspaceId, port: rawPort } = request.params as { workspaceId: string; port: string };
    const { host, port } = request.proxyTarget!;
    request.raw.url = stripPrefix(request.raw.url, previewPrefix(workspaceId, rawPort));
    reply.hijack();
    proxy.web(request.raw, reply.raw, { target: `http://${host}:${port}` });
  };
  const previewWsHandler = async (socket: WebSocket, request: FastifyRequest) => {
    const { workspaceId, port: rawPort } = request.params as { workspaceId: string; port: string };
    const { host, port } = request.proxyTarget!;
    const suffix = stripPrefix(request.raw.url, previewPrefix(workspaceId, rawPort));
    await bridgeWebSocket(socket, { targetUrl: `ws://${host}:${port}${suffix}` });
  };

  app.route({ method: 'GET', url: '/api/v1/proxy/preview/:workspaceId/:port/*', preHandler: requirePreviewAccess, handler: previewHttpHandler, wsHandler: previewWsHandler });
  app.route({ method: [...OTHER_METHODS], url: '/api/v1/proxy/preview/:workspaceId/:port/*', preHandler: requirePreviewAccess, handler: previewHttpHandler });
}
