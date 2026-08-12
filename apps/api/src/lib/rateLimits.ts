import type { FastifyInstance, FastifyRequest } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { Redis } from 'ioredis';

export const IP_RATE_LIMIT_MAX = 120;
export const USER_RATE_LIMIT_MAX = 120;
export const ORGANIZATION_RATE_LIMIT_MAX = 600;
export const RATE_LIMIT_WINDOW = '1 minute';

type IdentityScope = 'user' | 'organization';

declare module 'fastify' {
  interface FastifyRequest {
    enforceIdentityRateLimit(scope: IdentityScope, id: string): Promise<void>;
    identityRateLimitKey: string | null;
  }
}

interface RateLimitRegistrationOptions {
  redis?: Redis;
  ipMax?: number;
  userMax?: number;
  organizationMax?: number;
  timeWindow?: string | number;
}

function exceeded(scope: IdentityScope, ttlInSeconds: number) {
  return Object.assign(new Error('RATE_LIMIT_EXCEEDED'), {
    statusCode: 429,
    retryAfter: ttlInSeconds,
    rateLimitScope: scope
  });
}

/**
 * Registers independent abuse budgets for the network peer, authenticated user and organization.
 * The IP layer executes before parsing/authentication; identity layers execute only after a valid
 * session/role has been established by auth.ts. Each identity is charged at most once per request.
 */
export async function registerRateLimits(app: FastifyInstance, opts: RateLimitRegistrationOptions = {}) {
  const timeWindow = opts.timeWindow ?? RATE_LIMIT_WINDOW;
  await app.register(rateLimit, {
    max: opts.ipMax ?? IP_RATE_LIMIT_MAX,
    timeWindow,
    redis: opts.redis,
    nameSpace: 'odc-rate-limit:',
    skipOnError: false
  });

  const userMax = opts.userMax ?? USER_RATE_LIMIT_MAX;
  const organizationMax = opts.organizationMax ?? ORGANIZATION_RATE_LIMIT_MAX;
  const identityLimiter = app.createRateLimit({
    timeWindow,
    max: (_request, key) => key.startsWith('organization:') ? organizationMax : userMax,
    keyGenerator: request => request.identityRateLimitKey ?? 'invalid:missing-identity'
  });
  const charged = new WeakMap<FastifyRequest, Set<string>>();

  app.decorateRequest('identityRateLimitKey', null);
  app.decorateRequest('enforceIdentityRateLimit', async function (
    this: FastifyRequest,
    scope: IdentityScope,
    id: string
  ) {
    const key = `${scope}:${id}`;
    let requestCharges = charged.get(this);
    if (!requestCharges) {
      requestCharges = new Set();
      charged.set(this, requestCharges);
    }
    if (requestCharges.has(key)) return;

    this.identityRateLimitKey = key;
    let result;
    try {
      result = await identityLimiter(this);
    } finally {
      this.identityRateLimitKey = null;
    }
    if (!result.isAllowed && result.isExceeded) throw exceeded(scope, result.ttlInSeconds);
    requestCharges.add(key);
  });
}

export function createProductionRateLimitRedis(): Redis | undefined {
  if (process.env.NODE_ENV !== 'production') return undefined;
  return new Redis(process.env.REDIS_URL!, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    connectTimeout: 2_000
  });
}
