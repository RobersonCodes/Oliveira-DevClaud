import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma, Role } from '@oliveira/database';
import { requireOrgRole } from '../lib/auth.js';
import { audit } from '../lib/audit.js';
import { getRepositoryIntelligenceCached } from '../lib/repositoryIntelligenceCache.js';

export async function repositoryIntelligenceRoutes(app: FastifyInstance) {
  app.get('/:workspaceId', async request => {
    const { workspaceId } = z.object({ workspaceId: z.string().cuid() }).parse(request.params);
    const query = z.object({ refresh: z.enum(['true','false']).optional().transform(v => v === 'true') }).parse(request.query ?? {});
    const ws = await prisma.workspace.findUnique({ where: { id: workspaceId }, include: { project: true } });
    if (!ws) throw Object.assign(new Error('WORKSPACE_NOT_FOUND'), { statusCode: 404 });
    const { user } = await requireOrgRole(request, ws.project.organizationId, Role.DEVELOPER);
    if (!ws.containerId) throw Object.assign(new Error('WORKSPACE_HAS_NO_CONTAINER'), { statusCode: 409 });

    const result = await getRepositoryIntelligenceCached({ workspaceId: ws.id, containerId: ws.containerId, force: query.refresh });
    await audit({
      userId: user.id,
      organizationId: ws.project.organizationId,
      action: result.cache.hit ? 'REPOSITORY_INTELLIGENCE_CACHE_HIT' : 'REPOSITORY_INTELLIGENCE_GENERATED',
      resource: 'Workspace',
      resourceId: ws.id,
      ipAddress: request.ip,
      metadata: {
        sourceFiles: result.intelligence.sourceFiles,
        testFiles: result.intelligence.testFiles,
        routeFiles: result.intelligence.routeFiles,
        branch: result.intelligence.git.branch,
        commitSha: result.cache.commitSha,
        cacheReason: result.cache.reason
      }
    });
    return result;
  });

  app.delete('/:workspaceId/cache', async request => {
    const { workspaceId } = z.object({ workspaceId: z.string().cuid() }).parse(request.params);
    const ws = await prisma.workspace.findUnique({ where: { id: workspaceId }, include: { project: true } });
    if (!ws) throw Object.assign(new Error('WORKSPACE_NOT_FOUND'), { statusCode: 404 });
    const { user } = await requireOrgRole(request, ws.project.organizationId, Role.ADMIN);
    const deleted = await prisma.repositorySnapshot.deleteMany({ where: { workspaceId } });
    await audit({ userId: user.id, organizationId: ws.project.organizationId, action: 'REPOSITORY_INTELLIGENCE_CACHE_CLEARED', resource: 'Workspace', resourceId: ws.id, ipAddress: request.ip, metadata: { deleted: deleted.count } });
    return { ok: true, deleted: deleted.count };
  });
}
