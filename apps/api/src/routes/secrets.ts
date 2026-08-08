import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma, Role, SecretKind, SecretScope } from '@oliveira/database';
import { encryptSecret, maskSecret } from '@oliveira/secret-manager';
import { requireOrgRole } from '../lib/auth.js';
import { audit } from '../lib/audit.js';

const bodySchema = z.object({
  organizationId: z.string().cuid(),
  projectId: z.string().cuid().nullable().optional(),
  workspaceId: z.string().cuid().nullable().optional(),
  scope: z.nativeEnum(SecretScope).default(SecretScope.ORGANIZATION),
  kind: z.nativeEnum(SecretKind).default(SecretKind.GENERIC),
  name: z.string().regex(/^[A-Z][A-Z0-9_]{1,79}$/),
  value: z.string().min(1).max(16384)
});

function validateScope(input: z.infer<typeof bodySchema>) {
  if (input.scope === SecretScope.PROJECT && !input.projectId) throw Object.assign(new Error('PROJECT_SCOPE_REQUIRES_PROJECT'), { statusCode: 400 });
  if (input.scope === SecretScope.WORKSPACE && !input.workspaceId) throw Object.assign(new Error('WORKSPACE_SCOPE_REQUIRES_WORKSPACE'), { statusCode: 400 });
}

export async function secretRoutes(app: FastifyInstance) {
  app.get('/', async request => {
    const q = z.object({ organizationId: z.string().cuid() }).parse(request.query);
    await requireOrgRole(request, q.organizationId, Role.ADMIN);
    return prisma.secret.findMany({ where: { organizationId: q.organizationId }, select: { id:true, projectId:true, workspaceId:true, scope:true, kind:true, name:true, maskedValue:true, createdAt:true, updatedAt:true }, orderBy: { updatedAt: 'desc' } });
  });

  app.post('/', async (request, reply) => {
    const body = bodySchema.parse(request.body); validateScope(body);
    const { user } = await requireOrgRole(request, body.organizationId, Role.ADMIN);
    const aad = `${body.organizationId}:${body.scope}:${body.name}:${body.projectId ?? ''}:${body.workspaceId ?? ''}`;
    // Prisma's compound-unique lookup rejects null components, and Postgres treats NULL as distinct
    // in unique constraints anyway, so scope/project/workspace identity is resolved via findFirst instead.
    const existing = await prisma.secret.findFirst({ where: { organizationId: body.organizationId, scope: body.scope, name: body.name, projectId: body.projectId ?? null, workspaceId: body.workspaceId ?? null } });
    const secret = existing
      ? await prisma.secret.update({ where: { id: existing.id }, data: { kind: body.kind, encryptedValue: encryptSecret(body.value, aad), maskedValue: maskSecret(body.value) } })
      : await prisma.secret.create({ data: { organizationId: body.organizationId, projectId: body.projectId ?? null, workspaceId: body.workspaceId ?? null, scope: body.scope, kind: body.kind, name: body.name, encryptedValue: encryptSecret(body.value, aad), maskedValue: maskSecret(body.value) } });
    await audit({ userId:user.id, organizationId:body.organizationId, action:'SECRET_UPSERTED', resource:'Secret', resourceId:secret.id, ipAddress:request.ip, metadata:{ name:body.name, scope:body.scope, kind:body.kind } });
    return reply.code(201).send({ id:secret.id, name:secret.name, scope:secret.scope, kind:secret.kind, maskedValue:secret.maskedValue });
  });

  app.delete('/:id', async (request, reply) => {
    const { id } = request.params as { id:string };
    const secret = await prisma.secret.findUniqueOrThrow({ where:{ id } });
    const { user } = await requireOrgRole(request, secret.organizationId, Role.ADMIN);
    await prisma.secret.delete({ where:{ id } });
    await audit({ userId:user.id, organizationId:secret.organizationId, action:'SECRET_DELETED', resource:'Secret', resourceId:id, ipAddress:request.ip, metadata:{ name:secret.name } });
    return reply.code(204).send();
  });
}
