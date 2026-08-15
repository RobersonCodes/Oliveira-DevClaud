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

type SecretScopeInput = Pick<z.infer<typeof bodySchema>, 'scope' | 'projectId' | 'workspaceId'>;

export function validateSecretScopeShape(input: SecretScopeInput) {
  if (input.scope === SecretScope.ORGANIZATION) {
    if (input.projectId || input.workspaceId) throw Object.assign(new Error('ORGANIZATION_SCOPE_FORBIDS_RESOURCE'), { statusCode: 400 });
    return;
  }
  if (input.scope === SecretScope.PROJECT) {
    if (!input.projectId || input.workspaceId) throw Object.assign(new Error('PROJECT_SCOPE_REQUIRES_ONLY_PROJECT'), { statusCode: 400 });
    return;
  }
  if (!input.workspaceId || input.projectId) throw Object.assign(new Error('WORKSPACE_SCOPE_REQUIRES_ONLY_WORKSPACE'), { statusCode: 400 });
}

async function validateScope(input: z.infer<typeof bodySchema>) {
  validateSecretScopeShape(input);
  if (input.scope === SecretScope.ORGANIZATION) return;
  if (input.scope === SecretScope.PROJECT) {
    const projectId = input.projectId;
    if (!projectId) throw Object.assign(new Error('PROJECT_SCOPE_REQUIRES_ONLY_PROJECT'), { statusCode: 400 });
    const project = await prisma.project.findUnique({ where: { id: projectId }, select: { organizationId: true } });
    if (!project || project.organizationId !== input.organizationId) {
      throw Object.assign(new Error('SCOPE_RESOURCE_NOT_FOUND'), { statusCode: 404 });
    }
    return;
  }
  const workspaceId = input.workspaceId;
  if (!workspaceId) throw Object.assign(new Error('WORKSPACE_SCOPE_REQUIRES_ONLY_WORKSPACE'), { statusCode: 400 });
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { projectId: true }
  });
  const project = workspace
    ? await prisma.project.findUnique({ where: { id: workspace.projectId }, select: { organizationId: true } })
    : null;
  if (!project || project.organizationId !== input.organizationId) {
    throw Object.assign(new Error('SCOPE_RESOURCE_NOT_FOUND'), { statusCode: 404 });
  }
}

export async function secretRoutes(app: FastifyInstance) {
  app.get('/', async request => {
    const q = z.object({ organizationId: z.string().cuid() }).parse(request.query);
    await requireOrgRole(request, q.organizationId, Role.ADMIN);
    return prisma.secret.findMany({ where: { organizationId: q.organizationId }, select: { id:true, projectId:true, workspaceId:true, scope:true, kind:true, name:true, maskedValue:true, createdAt:true, updatedAt:true }, orderBy: { updatedAt: 'desc' } });
  });

  app.post('/', async (request, reply) => {
    const body = bodySchema.parse(request.body);
    const { user } = await requireOrgRole(request, body.organizationId, Role.ADMIN);
    await validateScope(body);
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
