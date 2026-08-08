import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { prisma, Role } from '@oliveira/database';
import { DockerIdeEngine } from '@oliveira/ide-engine';
import { requireOrgRole } from '../lib/auth.js';
import { audit } from '../lib/audit.js';

const ide = new DockerIdeEngine();

async function loadWorkspace(request: FastifyRequest, workspaceId: string, required: Role = Role.DEVELOPER) {
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, include: { project: true } });
  if (!workspace) throw Object.assign(new Error('WORKSPACE_NOT_FOUND'), { statusCode: 404 });
  const auth = await requireOrgRole(request, workspace.project.organizationId, required);
  if (!workspace.containerId) throw Object.assign(new Error('WORKSPACE_HAS_NO_CONTAINER'), { statusCode: 409 });
  return { workspace, ...auth };
}

export async function ideRoutes(app: FastifyInstance) {
  app.post('/:workspaceId/ide/start', async request => {
    const { workspaceId } = request.params as { workspaceId: string };
    const { workspace, user } = await loadWorkspace(request, workspaceId);
    const runtime = await ide.start(workspace.containerId!);
    await prisma.ideSession.upsert({
      where: { workspaceId },
      create: { workspaceId, active: true, port: runtime.port, startedAt: new Date(), lastActiveAt: new Date() },
      update: { active: true, port: runtime.port, startedAt: new Date(), lastActiveAt: new Date() }
    });
    await audit({ userId: user.id, organizationId: workspace.project.organizationId, action: 'IDE_STARTED', resource: 'Workspace', resourceId: workspaceId, ipAddress: request.ip });
    return { status: 'running', proxyUrl: `/api/v1/proxy/ide/${workspaceId}/` };
  });

  app.get('/:workspaceId/ide/status', async request => {
    const { workspaceId } = request.params as { workspaceId: string };
    const { workspace } = await loadWorkspace(request, workspaceId);
    const runtime = await ide.status(workspace.containerId!).catch(() => ({ running: false, host: '', port: 13337 }));
    await prisma.ideSession.upsert({
      where: { workspaceId },
      create: { workspaceId, active: runtime.running, port: runtime.port, startedAt: runtime.running ? new Date() : null },
      update: { active: runtime.running, port: runtime.port, lastActiveAt: new Date() }
    });
    return { status: runtime.running ? 'running' : 'stopped', proxyUrl: runtime.running ? `/api/v1/proxy/ide/${workspaceId}/` : null };
  });

  app.post('/:workspaceId/ide/stop', async request => {
    const { workspaceId } = request.params as { workspaceId: string };
    const { workspace, user } = await loadWorkspace(request, workspaceId);
    await ide.stop(workspace.containerId!);
    await prisma.ideSession.upsert({ where: { workspaceId }, create: { workspaceId, active: false }, update: { active: false, lastActiveAt: new Date() } });
    await audit({ userId: user.id, organizationId: workspace.project.organizationId, action: 'IDE_STOPPED', resource: 'Workspace', resourceId: workspaceId, ipAddress: request.ip });
    return { status: 'stopped' };
  });

  app.get('/:workspaceId/ports', async request => {
    const { workspaceId } = request.params as { workspaceId: string };
    await loadWorkspace(request, workspaceId);
    return prisma.workspacePort.findMany({ where: { workspaceId }, orderBy: { port: 'asc' } });
  });

  app.post('/:workspaceId/ports', async (request, reply) => {
    const { workspaceId } = request.params as { workspaceId: string };
    const { workspace, user } = await loadWorkspace(request, workspaceId);
    const body = z.object({ port: z.number().int().min(1024).max(65535), label: z.string().max(80).optional(), protocol: z.literal('http').default('http') }).parse(request.body);
    if (body.port === 13337) throw Object.assign(new Error('PORT_RESERVED_FOR_IDE'), { statusCode: 409 });
    const row = await prisma.workspacePort.upsert({
      where: { workspaceId_port: { workspaceId, port: body.port } },
      create: { workspaceId, ...body }, update: { label: body.label, protocol: body.protocol }
    });
    await audit({ userId: user.id, organizationId: workspace.project.organizationId, action: 'WORKSPACE_PORT_REGISTERED', resource: 'WorkspacePort', resourceId: row.id, ipAddress: request.ip, metadata: { port: body.port } });
    return reply.code(201).send({ ...row, previewUrl: `/api/v1/proxy/preview/${workspaceId}/${body.port}/` });
  });

  app.delete('/:workspaceId/ports/:port', async (request, reply) => {
    const { workspaceId, port: rawPort } = request.params as { workspaceId: string; port: string };
    const { workspace, user } = await loadWorkspace(request, workspaceId);
    const port = z.coerce.number().int().min(1024).max(65535).parse(rawPort);
    const existing = await prisma.workspacePort.findUnique({ where: { workspaceId_port: { workspaceId, port } } });
    if (existing) await prisma.workspacePort.delete({ where: { id: existing.id } });
    await audit({ userId: user.id, organizationId: workspace.project.organizationId, action: 'WORKSPACE_PORT_REMOVED', resource: 'WorkspacePort', resourceId: existing?.id, ipAddress: request.ip, metadata: { port } });
    return reply.code(204).send();
  });
}
