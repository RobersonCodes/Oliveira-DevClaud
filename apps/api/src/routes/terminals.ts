import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { prisma, Role, WorkspaceStatus, type Prisma } from '@oliveira/database';
import { DockerTmuxTerminalEngine } from '@oliveira/terminal-engine';
import { requireOrgRole } from '../lib/auth.js';
import { audit } from '../lib/audit.js';
import { parseTerminalClientMessage } from '../lib/terminalMessages.js';
import { isAllowedWsOrigin } from '../lib/wsOrigin.js';

type LoadedTerminal = Prisma.TerminalSessionGetPayload<{ include: { workspace: { include: { project: true } } } }>;

declare module 'fastify' {
  interface FastifyRequest {
    // Populated by requireTerminalAccess (a preHandler, run before @fastify/websocket completes the
    // WS handshake) so the connect wsHandler below doesn't need to re-authorize.
    terminalContext?: LoadedTerminal;
  }
}

const terminalEngine = new DockerTmuxTerminalEngine();
const createSchema = z.object({
  workspaceId: z.string().cuid(),
  title: z.string().trim().min(1).max(80).default('Terminal'),
  cols: z.number().int().min(20).max(300).default(120),
  rows: z.number().int().min(5).max(120).default(34)
});

async function loadTerminal(request: FastifyRequest, id: string, required: Role = Role.DEVELOPER) {
  const terminal = await prisma.terminalSession.findUnique({
    where: { id },
    include: { workspace: { include: { project: true } } }
  });
  if (!terminal) throw Object.assign(new Error('TERMINAL_NOT_FOUND'), { statusCode: 404 });
  const auth = await requireOrgRole(request, terminal.workspace.project.organizationId, required);
  return { terminal, ...auth };
}

export async function terminalRoutes(app: FastifyInstance) {
  app.get('/', async request => {
    const query = z.object({ workspaceId: z.string().cuid() }).parse(request.query);
    const workspace = await prisma.workspace.findUnique({ where: { id: query.workspaceId }, include: { project: true } });
    if (!workspace) throw Object.assign(new Error('WORKSPACE_NOT_FOUND'), { statusCode: 404 });
    await requireOrgRole(request, workspace.project.organizationId, Role.DEVELOPER);
    return prisma.terminalSession.findMany({ where: { workspaceId: workspace.id, active: true }, orderBy: { createdAt: 'asc' } });
  });

  app.post('/', async (request, reply) => {
    const body = createSchema.parse(request.body);
    const workspace = await prisma.workspace.findUnique({ where: { id: body.workspaceId }, include: { project: true } });
    if (!workspace) throw Object.assign(new Error('WORKSPACE_NOT_FOUND'), { statusCode: 404 });
    const { user } = await requireOrgRole(request, workspace.project.organizationId, Role.DEVELOPER);
    if (workspace.status !== WorkspaceStatus.RUNNING || !workspace.containerId) {
      throw Object.assign(new Error('WORKSPACE_NOT_RUNNING'), { statusCode: 409 });
    }
    const current = await prisma.terminalSession.count({ where: { workspaceId: workspace.id, active: true } });
    if (current >= 2) throw Object.assign(new Error('TERMINAL_LIMIT_REACHED'), { statusCode: 409 });

    const tmuxName = `terminal-${Date.now().toString(36)}`;
    await terminalEngine.ensureSession(workspace.containerId, tmuxName);
    const terminal = await prisma.terminalSession.create({
      data: { workspaceId: workspace.id, tmuxName, title: body.title, cols: body.cols, rows: body.rows }
    });
    await audit({ userId: user.id, organizationId: workspace.project.organizationId, action: 'TERMINAL_CREATED', resource: 'TerminalSession', resourceId: terminal.id, ipAddress: request.ip, metadata: { workspaceId: workspace.id, tmuxName } });
    return reply.code(201).send(terminal);
  });

  app.delete('/:terminalId', async (request, reply) => {
    const { terminalId } = request.params as { terminalId: string };
    const { terminal, user } = await loadTerminal(request, terminalId);
    if (terminal.workspace.containerId) await terminalEngine.killSession(terminal.workspace.containerId, terminal.tmuxName).catch(() => undefined);
    await prisma.terminalSession.update({ where: { id: terminal.id }, data: { active: false, lastActiveAt: new Date() } });
    await audit({ userId: user.id, organizationId: terminal.workspace.project.organizationId, action: 'TERMINAL_CLOSED', resource: 'TerminalSession', resourceId: terminal.id, ipAddress: request.ip });
    return reply.code(204).send();
  });

  // Origin, session/role and terminal availability are all validated here, in a preHandler — which
  // for a `{websocket:true}` route runs strictly *before* @fastify/websocket completes the upgrade
  // (the 101 is only sent once the wsHandler below actually starts). A request that fails any of
  // these gets a normal HTTP error response and no WebSocket handshake ever happens.
  async function requireTerminalAccess(request: FastifyRequest) {
    if (!isAllowedWsOrigin(request.headers.origin)) throw Object.assign(new Error('ORIGIN_NOT_ALLOWED'), { statusCode: 403 });
    const { terminalId } = request.params as { terminalId: string };
    const { terminal } = await loadTerminal(request, terminalId);
    if (!terminal.active || !terminal.workspace.containerId || terminal.workspace.status !== WorkspaceStatus.RUNNING) {
      throw Object.assign(new Error('TERMINAL_UNAVAILABLE'), { statusCode: 409 });
    }
    request.terminalContext = terminal;
  }

  app.get('/:terminalId/connect', { websocket: true, preHandler: requireTerminalAccess }, async (socket, request) => {
    const terminal = request.terminalContext!;
    let connection: Awaited<ReturnType<typeof terminalEngine.connect>> | undefined;
    try {
      connection = await terminalEngine.connect(terminal.workspace.containerId!, terminal.tmuxName, { cols: terminal.cols, rows: terminal.rows });
      connection.onData(chunk => {
        if (socket.readyState === 1) socket.send(chunk);
      });
      connection.onClose(() => {
        if (socket.readyState === 1) socket.close(1000, 'DETACHED');
      });

      socket.on('message', async (raw, isBinary) => {
        try {
          const event = parseTerminalClientMessage(raw, isBinary);
          if (event.type === 'input') connection?.write(event.data);
          else {
            await connection?.resize({ cols: event.cols, rows: event.rows });
            await prisma.terminalSession.update({ where: { id: terminal.id }, data: { cols: event.cols, rows: event.rows, lastActiveAt: new Date() } });
          }
        } catch { socket.send(JSON.stringify({ type: 'error', code: 'INVALID_TERMINAL_EVENT' })); }
      });

      socket.on('close', async () => {
        await connection?.close().catch(() => undefined);
        await prisma.terminalSession.update({ where: { id: terminal.id }, data: { lastActiveAt: new Date() } }).catch(() => undefined);
      });
    } catch {
      // Auth/availability failures are already handled by requireTerminalAccess above and never
      // reach here — anything caught at this point is a real connection/infra failure (e.g. the
      // container's tmux session couldn't be attached to).
      if (socket.readyState === 1) socket.close(1011, 'TERMINAL_CONNECT_FAILED');
      await connection?.close().catch(() => undefined);
    }
  });
}
