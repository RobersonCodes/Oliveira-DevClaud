import crypto from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { Prisma, Role, SecretKind, SecretScope, prisma } from './index.js';

// These tests exercise real Prisma queries against a real Postgres instance (DATABASE_URL) — no
// mocking of the query engine. Every created row is tracked and removed in afterEach so the suite
// is safe to re-run against a persistent database, not just a throwaway CI container.
const createdOrgIds: string[] = [];
const createdUserIds: string[] = [];

function unique(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

async function createOrg() {
  const org = await prisma.organization.create({ data: { name: unique('org'), slug: unique('org-slug') } });
  createdOrgIds.push(org.id);
  return org;
}

async function createUser() {
  const user = await prisma.user.create({ data: { email: `${unique('user')}@example.test`, passwordHash: 'not-a-real-hash' } });
  createdUserIds.push(user.id);
  return user;
}

afterEach(async () => {
  // Organizations cascade-delete members/projects/workspaces/secrets; users are independent and
  // must be removed separately (Session cascades from User).
  while (createdOrgIds.length) await prisma.organization.delete({ where: { id: createdOrgIds.pop()! } }).catch(() => undefined);
  while (createdUserIds.length) await prisma.user.delete({ where: { id: createdUserIds.pop()! } }).catch(() => undefined);
});

describe('database schema — constraints and cascades', () => {
  it('enforces unique User.email', async () => {
    const email = `${unique('dup')}@example.test`;
    const user = await prisma.user.create({ data: { email, passwordHash: 'x' } });
    createdUserIds.push(user.id);
    await expect(prisma.user.create({ data: { email, passwordHash: 'y' } })).rejects.toMatchObject({ code: 'P2002' });
  });

  it('defaults OrganizationMember.role to DEVELOPER and enforces the compound unique membership', async () => {
    const org = await createOrg();
    const user = await createUser();
    const membership = await prisma.organizationMember.create({ data: { organizationId: org.id, userId: user.id } });
    expect(membership.role).toBe(Role.DEVELOPER);
    await expect(prisma.organizationMember.create({ data: { organizationId: org.id, userId: user.id } })).rejects.toMatchObject({ code: 'P2002' });
  });

  it('cascades OrganizationMember deletion when the Organization is deleted', async () => {
    const org = await createOrg();
    const user = await createUser();
    await prisma.organizationMember.create({ data: { organizationId: org.id, userId: user.id, role: Role.ADMIN } });

    await prisma.organization.delete({ where: { id: org.id } });
    createdOrgIds.splice(createdOrgIds.indexOf(org.id), 1);

    const survivors = await prisma.organizationMember.findMany({ where: { organizationId: org.id } });
    expect(survivors).toHaveLength(0);
    // The user itself is not owned by the organization and must still exist.
    await expect(prisma.user.findUniqueOrThrow({ where: { id: user.id } })).resolves.toBeTruthy();
  });

  it('cascades Session deletion when the owning User is deleted', async () => {
    const user = await createUser();
    const session = await prisma.session.create({ data: { userId: user.id, tokenHash: unique('token'), expiresAt: new Date(Date.now() + 60_000) } });

    await prisma.user.delete({ where: { id: user.id } });
    createdUserIds.splice(createdUserIds.indexOf(user.id), 1);

    await expect(prisma.session.findUnique({ where: { id: session.id } })).resolves.toBeNull();
  });

  it('treats a Session with a past expiresAt as findable but expired (auth.ts is responsible for the comparison)', async () => {
    const user = await createUser();
    const expired = await prisma.session.create({ data: { userId: user.id, tokenHash: unique('token'), expiresAt: new Date(Date.now() - 1000) } });
    const found = await prisma.session.findUnique({ where: { tokenHash: expired.tokenHash } });
    expect(found).not.toBeNull();
    expect(found!.expiresAt.getTime()).toBeLessThan(Date.now());
  });

  it('enforces the compound unique Secret index only when every key column (including projectId/workspaceId) is non-null', async () => {
    const org = await createOrg();
    const project = await prisma.project.create({ data: { organizationId: org.id, name: 'proj', slug: unique('proj') } });
    const workspace = await prisma.workspace.create({ data: { projectId: project.id } });
    const data = { organizationId: org.id, projectId: project.id, workspaceId: workspace.id, scope: SecretScope.WORKSPACE, kind: SecretKind.GENERIC, name: 'API_KEY', encryptedValue: {}, maskedValue: '••••' };
    await prisma.secret.create({ data });
    await expect(prisma.secret.create({ data })).rejects.toMatchObject({ code: 'P2002' });
  });

  it('does NOT enforce uniqueness when projectId/workspaceId are null — Postgres treats NULL as distinct in a unique index, even with only one NULL column', async () => {
    // This is exactly why apps/api/src/routes/secrets.ts resolves the existing row via findFirst
    // instead of relying on `upsert`'s compound-unique `where`: two organization-scoped secrets
    // with the same name would silently become two rows, not one updated row, because the
    // @@unique([organizationId, scope, name, projectId, workspaceId]) index never fires unless
    // projectId AND workspaceId are both non-null.
    const org = await createOrg();
    const data = { organizationId: org.id, projectId: null, workspaceId: null, scope: SecretScope.ORGANIZATION, kind: SecretKind.GENERIC, name: 'API_KEY', encryptedValue: {}, maskedValue: '••••' };
    await prisma.secret.create({ data });
    await expect(prisma.secret.create({ data })).resolves.toMatchObject({ name: 'API_KEY' });
    const rows = await prisma.secret.findMany({ where: { organizationId: org.id, name: 'API_KEY' } });
    expect(rows).toHaveLength(2);
  });

  it('findFirst resolves the correct organization-scoped secret even with null project/workspace (mirrors the secrets route lookup)', async () => {
    const org = await createOrg();
    const created = await prisma.secret.create({ data: { organizationId: org.id, projectId: null, workspaceId: null, scope: SecretScope.ORGANIZATION, kind: SecretKind.GENERIC, name: 'DB_PASSWORD', encryptedValue: {}, maskedValue: '••••' } });
    const found = await prisma.secret.findFirst({ where: { organizationId: org.id, scope: SecretScope.ORGANIZATION, name: 'DB_PASSWORD', projectId: null, workspaceId: null } });
    expect(found?.id).toBe(created.id);
  });

  it('rejects an invalid Role value at the query-builder level (Prisma enums are closed sets)', () => {
    // TypeScript already prevents this at compile time; this asserts the generated enum object
    // itself only exposes the three valid roles, guarding against silent schema drift.
    expect(Object.values(Role).sort()).toEqual(['ADMIN', 'DEVELOPER', 'OWNER']);
  });
});

describe('database — Prisma namespace export', () => {
  it('re-exports the generated Prisma namespace alongside the client', () => {
    expect(Prisma).toBeDefined();
    expect(typeof Prisma.PrismaClientKnownRequestError).toBe('function');
  });
});
