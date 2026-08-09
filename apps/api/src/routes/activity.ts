import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '@oliveira/database';
import { requireOrgRole } from '../lib/auth.js';

export async function activityRoutes(app: FastifyInstance) {
  app.get('/', async (request) => {
    const query = z.object({ organizationId: z.string().min(1), limit: z.coerce.number().int().min(1).max(50).default(20) }).parse(request.query);
    await requireOrgRole(request, query.organizationId);
    return prisma.activityLog.findMany({
      where: { organizationId: query.organizationId },
      orderBy: { createdAt: 'desc' },
      take: query.limit,
      select: { id: true, type: true, message: true, workspaceId: true, createdAt: true, metadata: true }
    });
  });
}
