import type { FastifyInstance } from 'fastify';
import { prisma, Role } from '@oliveira/database';
import { requireOrgRole, requireUser } from '../lib/auth.js';

export async function organizationRoutes(app: FastifyInstance) {
  app.get('/', async request => {
    const { user } = await requireUser(request);
    return prisma.organization.findMany({
      where: { members: { some: { userId: user.id } } },
      include: { members: { where: { userId: user.id }, select: { role: true } }, _count: { select: { projects: true, members: true } } },
      orderBy: { createdAt: 'asc' }
    });
  });

  app.get('/:organizationId', async request => {
    const { organizationId } = request.params as { organizationId: string };
    await requireOrgRole(request, organizationId, Role.DEVELOPER);
    return prisma.organization.findUniqueOrThrow({ where: { id: organizationId }, include: { _count: { select: { projects: true, members: true } } } });
  });
}
