import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma, Role } from '@oliveira/database';
import { requireOrgRole } from '../lib/auth.js';
import { slugify } from '../lib/slug.js';
import { audit } from '../lib/audit.js';

const createSchema = z.object({
  organizationId: z.string().cuid(),
  name: z.string().min(2).max(100),
  repositoryUrl: z.string().url().max(2048).optional(),
  defaultBranch: z.string().regex(/^[A-Za-z0-9._\/-]+$/).max(200).default('main')
});

export async function projectRoutes(app: FastifyInstance) {
  app.get('/', async request => {
    const query = z.object({ organizationId: z.string().cuid() }).parse(request.query);
    await requireOrgRole(request, query.organizationId, Role.DEVELOPER);
    return prisma.project.findMany({ where: { organizationId: query.organizationId }, include: { _count: { select: { workspaces: true } } }, orderBy: { createdAt: 'desc' } });
  });

  app.post('/', async (request, reply) => {
    const body = createSchema.parse(request.body);
    const { user } = await requireOrgRole(request, body.organizationId, Role.ADMIN);
    const base = slugify(body.name) || 'project';
    let slug = base;
    for (let i = 1; await prisma.project.findUnique({ where: { organizationId_slug: { organizationId: body.organizationId, slug } } }); i++) slug = `${base}-${i}`;
    const project = await prisma.project.create({ data: { ...body, slug } });
    await audit({ userId: user.id, organizationId: body.organizationId, action: 'PROJECT_CREATED', resource: 'Project', resourceId: project.id, ipAddress: request.ip });
    return reply.code(201).send(project);
  });

  app.get('/:projectId', async request => {
    const { projectId } = request.params as { projectId: string };
    const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
    await requireOrgRole(request, project.organizationId, Role.DEVELOPER);
    return project;
  });

  app.delete('/:projectId', async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
    const { user } = await requireOrgRole(request, project.organizationId, Role.OWNER);
    await prisma.project.delete({ where: { id: projectId } });
    await audit({ userId: user.id, organizationId: project.organizationId, action: 'PROJECT_DELETED', resource: 'Project', resourceId: projectId, ipAddress: request.ip });
    return reply.code(204).send();
  });
}
