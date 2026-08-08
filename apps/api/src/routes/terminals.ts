import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { prisma, Role, WorkspaceStatus } from '@oliveira/database';
import { DockerTmuxTerminalEngine } from '@oliveira/terminal-engine';
import { requireOrgRole } from '../lib/auth.js';
import { audit } from '../lib/audit.js';

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

  app.get('/:terminalId/connect', { websocket: true }, async (socket, request) => {
    let connection: Awaited<ReturnType<typeof terminalEngine.connect>> | undefined;
    try {
      const { terminalId } = request.params as { terminalId: string };
      const { terminal } = await loadTerminal(request, terminalId);
      if (!terminal.active || !terminal.workspace.containerId || terminal.workspace.status !== WorkspaceStatus.RUNNING) {
        socket.close(1008, 'TERMINAL_UNAVAILABLE');
        return;
      }

      connection = await terminalEngine.connect(terminal.workspace.containerId, terminal.tmuxName, { cols: terminal.cols, rows: terminal.rows });
      connection.onData(chunk => {
        if (socket.readyState === 1) socket.send(chunk);
      });
      connection.onClose(() => {
        if (socket.readyState === 1) socket.close(1000, 'DETACHED');
      });

      socket.on('message', async (raw: Buffer | ArrayBuffer | Buffer[]) => {
        try {
          if (Buffer.isBuffer(raw)) { connection?.write(raw.toString('utf8')); return; }
          const text = raw.toString();
          if (text.startsWith('{')) {
            const event = z.discriminatedUnion('type', [
              z.object({ type: z.literal('input'), data: z.string().max(65536) }),
              z.object({ type: z.literal('resize'), cols: z.number().int().min(20).max(300), rows: z.number().int().min(5).max(120) })
            ]).parse(JSON.parse(text));
            if (event.type === 'input') connection?.write(event.data);
            else {
              await connection?.resize({ cols: event.cols, rows: event.rows });
              await prisma.terminalSession.update({ where: { id: terminal.id }, data: { cols: event.cols, rows: event.rows, lastActiveAt: new Date() } });
            }
          } else connection?.write(text);
        } catch { socket.send(JSON.stringify({ type: 'error', code: 'INVALID_TERMINAL_EVENT' })); }
      });

      socket.on('close', async () => {
        await connection?.close().catch(() => undefined);
        await prisma.terminalSession.update({ where: { id: terminal.id }, data: { lastActiveAt: new Date() } }).catch(() => undefined);
      });
    } catch {
      socket.close(1008, 'UNAUTHORIZED_OR_NOT_FOUND');
      await connection?.close().catch(() => undefined);
    }
  });
}
