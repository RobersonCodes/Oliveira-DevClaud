import httpProxy from 'http-proxy';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { prisma, Role } from '@oliveira/database';
import { DockerIdeEngine, IDE_PORT } from '@oliveira/ide-engine';
import { requireOrgRole, hashToken, SESSION_COOKIE } from './auth.js';

const proxy = httpProxy.createProxyServer({ ws: true, xfwd: true, changeOrigin: false });
const ide = new DockerIdeEngine();
proxy.on('error', (_err, _req, res) => {
  if ('writeHead' in res && !res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
  if ('end' in res) res.end(JSON.stringify({ error: 'RUNTIME_PROXY_ERROR' }));
});

async function targetFor(workspaceId: string, port: number) {
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, include: { project: true } });
  if (!workspace?.containerId) throw Object.assign(new Error('WORKSPACE_NOT_FOUND'), { statusCode: 404 });
  const host = await ide.internalHost(workspace.containerId);
  return { target: `http://${host}:${port}`, workspace };
}

function stripPrefix(url: string | undefined, prefix: string) {
  const raw = url ?? '/';
  const out = raw.startsWith(prefix) ? raw.slice(prefix.length - 1) : raw;
  return out.startsWith('/') ? out : `/${out}`;
}

export function registerRuntimeProxy(app: FastifyInstance) {
  app.all('/api/v1/proxy/ide/:workspaceId/*', async (request, reply) => {
    const { workspaceId } = request.params as { workspaceId: string };
    const { target, workspace } = await targetFor(workspaceId, IDE_PORT);
    await requireOrgRole(request, workspace.project.organizationId, Role.DEVELOPER);
    request.raw.url = stripPrefix(request.raw.url, `/api/v1/proxy/ide/${workspaceId}/`);
    reply.hijack();
    proxy.web(request.raw, reply.raw, { target });
  });

  app.all('/api/v1/proxy/preview/:workspaceId/:port/*', async (request, reply) => {
    const { workspaceId, port: rawPort } = request.params as { workspaceId: string; port: string };
    const port = Number(rawPort);
    const registered = Number.isInteger(port) ? await prisma.workspacePort.findUnique({ where: { workspaceId_port: { workspaceId, port } } }) : null;
    if (!registered) throw Object.assign(new Error('PREVIEW_PORT_NOT_REGISTERED'), { statusCode: 404 });
    const { target, workspace } = await targetFor(workspaceId, port);
    await requireOrgRole(request, workspace.project.organizationId, Role.DEVELOPER);
    request.raw.url = stripPrefix(request.raw.url, `/api/v1/proxy/preview/${workspaceId}/${port}/`);
    reply.hijack();
    proxy.web(request.raw, reply.raw, { target });
  });

  app.server.on('upgrade', async (req, socket, head) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const ideMatch = url.pathname.match(/^\/api\/v1\/proxy\/ide\/([^/]+)\/(.*)$/);
      const previewMatch = url.pathname.match(/^\/api\/v1\/proxy\/preview\/([^/]+)\/(\d+)\/(.*)$/);
      if (!ideMatch && !previewMatch) return;

      const workspaceId = decodeURIComponent((ideMatch?.[1] ?? previewMatch?.[1])!);
      const port = ideMatch ? IDE_PORT : Number(previewMatch![2]);
      if (previewMatch) {
        const registered = await prisma.workspacePort.findUnique({ where: { workspaceId_port: { workspaceId, port } } });
        if (!registered) throw new Error('PREVIEW_PORT_NOT_REGISTERED');
      }

      const cookieHeader = req.headers.cookie ?? '';
      const token = cookieHeader.split(';').map(x => x.trim()).find(x => x.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1);
      if (!token) throw new Error('UNAUTHORIZED');
      const session = await prisma.session.findUnique({ where: { tokenHash: hashToken(decodeURIComponent(token)) }, include: { user: { include: { memberships: true } } } });
      if (!session || session.expiresAt <= new Date()) throw new Error('UNAUTHORIZED');

      const { target, workspace } = await targetFor(workspaceId, port);
      const member = session.user.memberships.find(m => m.organizationId === workspace.project.organizationId);
      if (!member) throw new Error('FORBIDDEN');

      const prefix = ideMatch ? `/api/v1/proxy/ide/${workspaceId}/` : `/api/v1/proxy/preview/${workspaceId}/${port}/`;
      req.url = stripPrefix(req.url, prefix);
      proxy.ws(req, socket, head, { target });
    } catch {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
    }
  });
}
