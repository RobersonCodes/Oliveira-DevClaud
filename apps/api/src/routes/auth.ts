import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma, Role } from '@oliveira/database';
import { createSession, getSessionUser, hashPassword, hashToken, SESSION_COOKIE, verifyPassword } from '../lib/auth.js';
import { slugify } from '../lib/slug.js';
import { audit } from '../lib/audit.js';

const credentials = z.object({ email: z.string().email().max(254), password: z.string().min(10).max(128) });
const registerSchema = credentials.extend({ name: z.string().min(2).max(100), organizationName: z.string().min(2).max(100).default('Oliveira Systems') });

export async function authRoutes(app: FastifyInstance) {
  app.post('/register', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (request, reply) => {
    const body = registerSchema.parse(request.body);
    const email = body.email.toLowerCase();
    if (await prisma.user.findUnique({ where: { email } })) return reply.code(409).send({ error: 'EMAIL_ALREADY_EXISTS' });
    let baseSlug = slugify(body.organizationName) || 'organization';
    let slug = baseSlug;
    for (let i = 1; await prisma.organization.findUnique({ where: { slug } }); i++) slug = `${baseSlug}-${i}`;
    const passwordHash = await hashPassword(body.password);
    const user = await prisma.$transaction(async tx => {
      const created = await tx.user.create({ data: { email, name: body.name, passwordHash } });
      const org = await tx.organization.create({ data: { name: body.organizationName, slug } });
      await tx.organizationMember.create({ data: { userId: created.id, organizationId: org.id, role: Role.OWNER } });
      return created;
    });
    const session = await createSession(user.id, request);
    reply.setCookie(SESSION_COOKIE, session.token, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/', expires: session.expiresAt });
    await audit({ userId: user.id, action: 'USER_REGISTERED', resource: 'User', resourceId: user.id, ipAddress: request.ip });
    return reply.code(201).send({ id: user.id, email: user.email, name: user.name });
  });

  app.post('/login', { config: { rateLimit: { max: 8, timeWindow: '1 minute' } } }, async (request, reply) => {
    const body = credentials.parse(request.body);
    const user = await prisma.user.findUnique({ where: { email: body.email.toLowerCase() } });
    if (!user || !(await verifyPassword(body.password, user.passwordHash))) return reply.code(401).send({ error: 'INVALID_CREDENTIALS' });
    const session = await createSession(user.id, request);
    reply.setCookie(SESSION_COOKIE, session.token, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/', expires: session.expiresAt });
    await audit({ userId: user.id, action: 'USER_LOGIN', resource: 'Session', ipAddress: request.ip });
    return { id: user.id, email: user.email, name: user.name };
  });

  app.post('/logout', async (request, reply) => {
    const token = request.cookies?.[SESSION_COOKIE];
    if (token) await prisma.session.deleteMany({ where: { tokenHash: hashToken(token) } });
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return reply.code(204).send();
  });

  app.get('/me', async (request, reply) => {
    const auth = await getSessionUser(request);
    if (!auth) return reply.code(401).send({ error: 'UNAUTHORIZED' });
    return {
      id: auth.user.id,
      email: auth.user.email,
      name: auth.user.name,
      memberships: auth.user.memberships.map(m => ({ organizationId: m.organizationId, role: m.role }))
    };
  });
}
