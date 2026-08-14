import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma, Role } from '@oliveira/database';
import { createSession, hashPassword, hashToken, requireUser, SESSION_COOKIE, sessionCookieOptions, verifyPassword } from '../lib/auth.js';
import { slugify } from '../lib/slug.js';
import { audit } from '../lib/audit.js';

const credentials = z.object({ email: z.string().email().max(254), password: z.string().min(10).max(128) });
const registerSchema = credentials.extend({ name: z.string().min(2).max(100), organizationName: z.string().min(2).max(100).default('Oliveira Systems') });

// Progressive account lockout: 5 failed attempts locks the account for 15 minutes, doubling on
// every subsequent failure while still locked (up to a 24h cap). This is per-account, layered on
// top of the per-IP rate limit already on this route (config.rateLimit below) — together they
// cover both a single account being brute-forced from many IPs and one IP hammering many accounts.
const LOCKOUT_THRESHOLD = 5;
const BASE_LOCKOUT_MINUTES = 15;
const MAX_LOCKOUT_MINUTES = 24 * 60;
// Unknown accounts still pay the same bcrypt cost as known accounts. This hash belongs to a fixed,
// unusable sentinel password and is intentionally not a secret.
const UNKNOWN_ACCOUNT_PASSWORD_HASH = '$2b$12$Y9Qpf7CDcpmE9Hwt9avzdOof9oRMKQd4SpjIgw.SkcI9Refb.pVHC';
function nextLockout(attempts: number): Date {
  const tier = attempts - LOCKOUT_THRESHOLD;
  const minutes = Math.min(BASE_LOCKOUT_MINUTES * 2 ** tier, MAX_LOCKOUT_MINUTES);
  return new Date(Date.now() + minutes * 60_000);
}

export async function authRoutes(app: FastifyInstance) {
  app.post('/register', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (request, reply) => {
    const body = registerSchema.parse(request.body);
    const email = body.email.toLowerCase();
    if (await prisma.user.findUnique({ where: { email } })) return reply.code(409).send({ error: 'EMAIL_ALREADY_EXISTS' });
    const baseSlug = slugify(body.organizationName) || 'organization';
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
    reply.setCookie(SESSION_COOKIE, session.token, { ...sessionCookieOptions(), expires: session.expiresAt });
    await audit({ userId: user.id, action: 'USER_REGISTERED', resource: 'User', resourceId: user.id, ipAddress: request.ip });
    return reply.code(201).send({ id: user.id, email: user.email, name: user.name });
  });

  app.post('/login', { config: { rateLimit: { max: 8, timeWindow: '1 minute' } } }, async (request, reply) => {
    const body = credentials.parse(request.body);
    const user = await prisma.user.findUnique({ where: { email: body.email.toLowerCase() } });
    const locked = Boolean(user?.lockedUntil && user.lockedUntil > new Date());
    const passwordMatches = await verifyPassword(body.password, user?.passwordHash ?? UNKNOWN_ACCOUNT_PASSWORD_HASH);
    if (!user || locked || !passwordMatches) {
      if (user && !locked) {
        const attempts = user.failedLoginAttempts + 1;
        await prisma.user.update({
          where: { id: user.id },
          data: { failedLoginAttempts: attempts, lockedUntil: attempts >= LOCKOUT_THRESHOLD ? nextLockout(attempts) : null }
        });
      }
      // Lockout state is deliberately not exposed on this public channel. Existing, unknown and
      // locked accounts must have the same observable status and payload for failed authentication.
      return reply.code(401).send({ error: 'INVALID_CREDENTIALS' });
    }
    if (user.failedLoginAttempts > 0 || user.lockedUntil) {
      await prisma.user.update({ where: { id: user.id }, data: { failedLoginAttempts: 0, lockedUntil: null } });
    }
    const session = await createSession(user.id, request);
    reply.setCookie(SESSION_COOKIE, session.token, { ...sessionCookieOptions(), expires: session.expiresAt });
    await audit({ userId: user.id, action: 'USER_LOGIN', resource: 'Session', ipAddress: request.ip });
    return { id: user.id, email: user.email, name: user.name };
  });

  app.post('/logout', async (request, reply) => {
    const token = request.cookies?.[SESSION_COOKIE];
    if (token) {
      const session = await prisma.session.findUnique({ where: { tokenHash: hashToken(token) }, select: { id: true, userId: true } });
      if (session) {
        await prisma.session.delete({ where: { id: session.id } });
        await audit({ userId: session.userId, action: 'USER_LOGOUT', resource: 'Session', resourceId: session.id, ipAddress: request.ip });
      }
    }
    // __Host- cookies are only accepted (including deletion cookies) with Secure + Path=/ and no
    // Domain, so logout must use the exact same security attributes as login/register.
    reply.clearCookie(SESSION_COOKIE, sessionCookieOptions());
    return reply.code(204).send();
  });

  app.get('/me', async (request, reply) => {
    const auth = await requireUser(request);
    return {
      id: auth.user.id,
      email: auth.user.email,
      name: auth.user.name,
      memberships: auth.user.memberships.map(m => ({ organizationId: m.organizationId, role: m.role }))
    };
  });

  app.get('/sessions', async request => {
    const { user, session: currentSession } = await requireUser(request);
    await prisma.session.deleteMany({ where: { userId: user.id, expiresAt: { lte: new Date() } } });
    const sessions = await prisma.session.findMany({
      where: { userId: user.id },
      select: { id: true, userAgent: true, ipAddress: true, createdAt: true, lastUsedAt: true, expiresAt: true },
      orderBy: { lastUsedAt: 'desc' }
    });
    return sessions.map(session => ({ ...session, current: session.id === currentSession.id }));
  });

  app.delete('/sessions/others', async (request, reply) => {
    const { user, session } = await requireUser(request);
    const revoked = await prisma.session.deleteMany({ where: { userId: user.id, id: { not: session.id } } });
    await audit({
      userId: user.id,
      action: 'SESSIONS_OTHERS_REVOKED',
      resource: 'Session',
      resourceId: session.id,
      ipAddress: request.ip,
      metadata: { revoked: revoked.count }
    });
    return reply.send({ revoked: revoked.count });
  });

  app.delete('/sessions/:sessionId', async (request, reply) => {
    const { sessionId } = z.object({ sessionId: z.string().cuid() }).parse(request.params);
    const { user, session: currentSession } = await requireUser(request);
    const revoked = await prisma.session.deleteMany({ where: { id: sessionId, userId: user.id } });
    if (revoked.count === 0) throw Object.assign(new Error('SESSION_NOT_FOUND'), { statusCode: 404 });
    await audit({
      userId: user.id,
      action: 'SESSION_REVOKED',
      resource: 'Session',
      resourceId: sessionId,
      ipAddress: request.ip,
      metadata: { current: sessionId === currentSession.id }
    });
    if (sessionId === currentSession.id) reply.clearCookie(SESSION_COOKIE, sessionCookieOptions());
    return reply.code(204).send();
  });
}
