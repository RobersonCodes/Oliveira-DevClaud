import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { prisma, Role } from '@oliveira/database';
import type { FastifyRequest } from 'fastify';

const SESSION_COOKIE = 'odc_session';
const SESSION_DAYS = Number(process.env.SESSION_TTL_DAYS ?? 14);

export { SESSION_COOKIE };

export const hashPassword = (password: string) => bcrypt.hash(password, 12);
export const verifyPassword = (password: string, hash: string) => bcrypt.compare(password, hash);
export const hashToken = (token: string) => crypto.createHash('sha256').update(token).digest('hex');

export async function createSession(userId: string, request: FastifyRequest) {
  const token = crypto.randomBytes(48).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  await prisma.session.create({ data: {
    userId,
    tokenHash: hashToken(token),
    expiresAt,
    userAgent: request.headers['user-agent']?.slice(0, 500),
    ipAddress: request.ip
  }});
  return { token, expiresAt };
}

export async function getSessionUser(request: FastifyRequest) {
  const token = request.cookies?.[SESSION_COOKIE];
  if (!token) return null;
  const session = await prisma.session.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: { include: { memberships: true } } }
  });
  if (!session || session.expiresAt <= new Date()) {
    if (session) await prisma.session.delete({ where: { id: session.id } }).catch(() => undefined);
    return null;
  }
  await prisma.session.update({ where: { id: session.id }, data: { lastUsedAt: new Date() } });
  return { session, user: session.user };
}

const rank: Record<Role, number> = { DEVELOPER: 1, ADMIN: 2, OWNER: 3 };
export function hasRole(actual: Role, required: Role) { return rank[actual] >= rank[required]; }

export async function requireUser(request: FastifyRequest) {
  const auth = await getSessionUser(request);
  if (!auth) throw Object.assign(new Error('UNAUTHORIZED'), { statusCode: 401 });
  return auth;
}

export async function requireOrgRole(request: FastifyRequest, organizationId: string, required: Role = Role.DEVELOPER) {
  const { user } = await requireUser(request);
  const membership = user.memberships.find(m => m.organizationId === organizationId);
  if (!membership || !hasRole(membership.role, required)) throw Object.assign(new Error('FORBIDDEN'), { statusCode: 403 });
  return { user, membership };
}
