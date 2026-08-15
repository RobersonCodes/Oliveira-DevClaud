import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { prisma, Role, WorkspaceStatus } from '@oliveira/database';
import { DockerWorkspaceEngine } from '@oliveira/workspace-engine';
import { requireOrgRole } from '../lib/auth.js';
import { audit } from '../lib/audit.js';
import { recordActivity } from '../lib/activity.js';

const engine = new DockerWorkspaceEngine();
const createSchema = z.object({
  projectId: z.string().cuid(),
  cpuLimit: z.number().min(0.25).max(16).default(1),
  memoryMb: z.number().int().min(256).max(32768).default(2048),
  pidsLimit: z.number().int().min(64).max(4096).default(512),
  diskMb: z.number().int().min(512).max(102400).default(10240),
  maxRuntimeMinutes: z.number().int().min(15).max(10080).default(480)
});

async function loadWorkspace(request: FastifyRequest, workspaceId: string, required: Role = Role.DEVELOPER) {
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, include: { project: true } });
  if (!workspace) throw Object.assign(new Error('WORKSPACE_NOT_FOUND'), { statusCode: 404 });
  const auth = await requireOrgRole(request, workspace.project.organizationId, required);
  return { workspace, ...auth };
}

export async function workspaceRoutes(app: FastifyInstance) {
  app.get('/', async request => {
    const query = z.object({ projectId: z.string().cuid() }).parse(request.query);
    const project = await prisma.project.findUnique({ where: { id: query.projectId } });
    if (!project) throw Object.assign(new Error('PROJECT_NOT_FOUND'), { statusCode: 404 });
    await requireOrgRole(request, project.organizationId, Role.DEVELOPER);
    return prisma.workspace.findMany({ where: { projectId: query.projectId }, orderBy: { createdAt: 'desc' } });
  });

  app.post('/', async (request, reply) => {
    const body = createSchema.parse(request.body);
    const project = await prisma.project.findUnique({ where: { id: body.projectId } });
    if (!project) throw Object.assign(new Error('PROJECT_NOT_FOUND'), { statusCode: 404 });
    const { user } = await requireOrgRole(request, project.organizationId, Role.ADMIN);
    const workspace = await prisma.workspace.create({ data: { projectId: project.id, cpuLimit: body.cpuLimit, memoryMb: body.memoryMb, pidsLimit: body.pidsLimit, diskMb: body.diskMb, maxRuntimeMinutes: body.maxRuntimeMinutes, status: WorkspaceStatus.CREATING } });
    try {
      const runtime = await engine.create({ workspaceId: workspace.id, projectId: project.id, repositoryUrl: project.repositoryUrl, defaultBranch: project.defaultBranch, limits: body });
      const now = new Date();
      const updated = await prisma.workspace.update({ where: { id: workspace.id }, data: { containerId: runtime.containerId, status: WorkspaceStatus.RUNNING, lastActiveAt: now, heartbeatAt: now, runtimeStartedAt: now, quotaViolation: null, quotaExceededAt: null } });
      await audit({ userId: user.id, organizationId: project.organizationId, action: 'WORKSPACE_CREATED', resource: 'Workspace', resourceId: workspace.id, ipAddress: request.ip, metadata: { cpuLimit: body.cpuLimit, memoryMb: body.memoryMb, pidsLimit: body.pidsLimit, diskMb: body.diskMb, maxRuntimeMinutes: body.maxRuntimeMinutes } });
      await recordActivity({ organizationId: project.organizationId, workspaceId: workspace.id, userId: user.id, type: 'workspace.created', message: `Workspace criado para o projeto ${project.name}` });
      return reply.code(201).send(updated);
    } catch (error) {
      await prisma.workspace.update({ where: { id: workspace.id }, data: { status: WorkspaceStatus.ERROR } });
      throw error;
    }
  });

  app.get('/:workspaceId', async request => {
    const { workspaceId } = request.params as { workspaceId: string };
    const { workspace } = await loadWorkspace(request, workspaceId);
    let runtime = null;
    if (workspace.containerId) runtime = await engine.inspect(workspace.containerId).catch(() => null);
    return { ...workspace, runtime };
  });

  for (const [action, required] of [['start', Role.DEVELOPER], ['stop', Role.DEVELOPER], ['restart', Role.ADMIN]] as const) {
    app.post(`/:workspaceId/${action}`, async request => {
      const { workspaceId } = request.params as { workspaceId: string };
      const { workspace, user } = await loadWorkspace(request, workspaceId, required);
      if (!workspace.containerId) throw Object.assign(new Error('WORKSPACE_HAS_NO_CONTAINER'), { statusCode: 409 });
      await engine[action](workspace.containerId);
      const status = action === 'stop' ? WorkspaceStatus.STOPPED : WorkspaceStatus.RUNNING;
      const now = new Date();
      const updated = await prisma.workspace.update({ where: { id: workspace.id }, data: { status, lastActiveAt: now, heartbeatAt: status === WorkspaceStatus.RUNNING ? now : workspace.heartbeatAt, runtimeStartedAt: status === WorkspaceStatus.RUNNING ? now : null, quotaViolation: status === WorkspaceStatus.RUNNING ? null : workspace.quotaViolation, quotaExceededAt: status === WorkspaceStatus.RUNNING ? null : workspace.quotaExceededAt } });
      await audit({ userId: user.id, organizationId: workspace.project.organizationId, action: `WORKSPACE_${action.toUpperCase()}`, resource: 'Workspace', resourceId: workspace.id, ipAddress: request.ip });
      const activityByAction = { start: { type: 'workspace.started', message: 'Workspace iniciado' }, stop: { type: 'workspace.stopped', message: 'Workspace parado' }, restart: { type: 'workspace.restarted', message: 'Workspace reiniciado' } } as const;
      await recordActivity({ organizationId: workspace.project.organizationId, workspaceId: workspace.id, userId: user.id, ...activityByAction[action] });
      return updated;
    });
  }

  app.delete('/:workspaceId', async (request, reply) => {
    const { workspaceId } = request.params as { workspaceId: string };
    const { workspace, user } = await loadWorkspace(request, workspaceId, Role.ADMIN);
    await prisma.workspace.update({ where: { id: workspace.id }, data: { status: WorkspaceStatus.DESTROYING } });
    if (workspace.containerId) await engine.destroy(workspace.containerId, workspace.id).catch(error => app.log.warn(error));
    await prisma.workspace.delete({ where: { id: workspace.id } });
    await audit({ userId: user.id, organizationId: workspace.project.organizationId, action: 'WORKSPACE_DESTROYED', resource: 'Workspace', resourceId: workspace.id, ipAddress: request.ip });
    await recordActivity({ organizationId: workspace.project.organizationId, userId: user.id, type: 'workspace.destroyed', message: 'Workspace removido' });
    return reply.code(204).send();
  });
}
