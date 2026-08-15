import Fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import websocket from '@fastify/websocket';
import { Redis } from 'ioredis';
import { ZodError } from 'zod';
import { prisma } from '@oliveira/database';
import { authRoutes } from './routes/auth.js';
import { organizationRoutes } from './routes/organizations.js';
import { projectRoutes } from './routes/projects.js';
import { workspaceRoutes } from './routes/workspaces.js';
import { terminalRoutes } from './routes/terminals.js';
import { ideRoutes } from './routes/ide.js';
import { agentRoutes } from './routes/agents.js';
import { orchestrationRoutes } from './routes/orchestrations.js';
import { secretRoutes } from './routes/secrets.js';
import { githubRoutes } from './routes/github.js';
import { repositoryRoutes } from './routes/repositories.js';
import { systemRoutes } from './routes/system.js';
import { activityRoutes } from './routes/activity.js';
import { setupRoutes } from './routes/setup.js';
import { commandCenterRoutes } from './routes/command-center.js';
import { repositoryIntelligenceRoutes } from './routes/repository-intelligence.js';
import { codeIntelligenceRoutes } from './routes/code-intelligence.js';
import { contextIntelligenceRoutes } from './routes/context-intelligence.js';
import { contractIntelligenceRoutes } from './routes/contract-intelligence.js';
import { deadLetterRoutes } from './routes/dead-letters.js';
import { registerRuntimeProxy } from './lib/runtimeProxy.js';
import { registerRuntimeGateway, registerRuntimeTicketRoute } from './lib/runtimeGateway.js';
import { requireHostAdmin } from './lib/auth.js';
import { parseTrustedProxyCidrs } from './lib/trustedProxy.js';
import { validateProductionConfig } from './lib/productionConfig.js';
import { createProductionRateLimitRedis, registerRateLimits } from './lib/rateLimits.js';

export const API_BODY_LIMIT_BYTES = 1024 * 1024;
export const API_REQUEST_TIMEOUT_MS = 30_000;
export const API_KEEP_ALIVE_TIMEOUT_MS = 72_000;

/**
 * Builds a fully-registered Fastify instance without binding it to a port, so integration tests
 * can exercise real routes/plugins/hooks against a real database via `app.inject()` instead of
 * spinning up an actual network listener (and index.ts stays a thin bootstrap around this).
 */
export async function buildApp(opts: { logger?: boolean; disableRateLimit?: boolean; trustedProxies?: false | string[] } = {}) {
  validateProductionConfig();
  const app = Fastify({
    logger: opts.logger ?? true,
    trustProxy: opts.trustedProxies ?? parseTrustedProxyCidrs(),
    // The public API is JSON-only and its largest accepted fields are measured in KiB, not MiB.
    // Keep this aligned with `client_max_body_size 1m` in both production nginx paths. Runtime
    // content keeps its separate 25 MiB nginx limit because IDE/preview traffic is a proxy boundary,
    // not a control-plane API payload.
    bodyLimit: API_BODY_LIMIT_BYTES,
    // Bounds the time allowed to receive the complete request (slow-upload/slowloris protection).
    // It does not cap handler execution or long-lived responses such as SSE/WebSocket. Deliberately
    // leave connectionTimeout at zero: a socket inactivity timeout would tear down valid idle
    // terminal/IDE WebSockets.
    requestTimeout: API_REQUEST_TIMEOUT_MS,
    keepAliveTimeout: API_KEEP_ALIVE_TIMEOUT_MS
  });
  // This is a JSON-only API, never a source of HTML, so contentSecurityPolicy is off; the web app
  // legitimately fetches this API cross-origin with credentials, so CORP is relaxed to allow that
  // (COEP/COOP, which govern window/worker embedding rather than fetch, stay at Helmet's defaults).
  await app.register(helmet, { contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'cross-origin' } });
  await app.register(cors, { origin: process.env.WEB_ORIGIN ?? 'http://localhost:3000', credentials: true });
  await app.register(cookie);
  await app.register(websocket, { options: { maxPayload: 1024 * 1024 } });
  // Anonymous traffic is limited by trusted client IP; authenticated traffic is additionally
  // limited by user and organization in requireUser/requireOrgRole. Production uses Redis so the
  // budgets survive restarts and remain coherent if the API is replicated.
  if (!opts.disableRateLimit) {
    const rateLimitRedis = createProductionRateLimitRedis();
    if (rateLimitRedis) {
      rateLimitRedis.on('error', error => app.log.error({ err: error }, 'Rate-limit Redis error'));
      try {
        await rateLimitRedis.connect();
      } catch (error) {
        rateLimitRedis.disconnect();
        throw error;
      }
    }
    await registerRateLimits(app, { redis: rateLimitRedis });
    if (rateLimitRedis) {
      app.addHook('onClose', async () => { rateLimitRedis.disconnect(); });
    }
  }

  app.setErrorHandler((rawError, _request, reply) => {
    if (rawError instanceof ZodError) return reply.code(400).send({ error: 'VALIDATION_ERROR', issues: rawError.issues });
    const error = rawError as Error & { statusCode?: number; retryAfter?: number; rateLimitScope?: string };
    const statusCode = error.statusCode ?? 500;
    if (statusCode >= 500) app.log.error(error);
    if (statusCode === 429 && error.retryAfter !== undefined) {
      reply.header('retry-after', String(Math.max(1, error.retryAfter)));
    }
    return reply.code(statusCode).send({
      error: statusCode >= 500 ? 'INTERNAL_SERVER_ERROR' : error.message,
      ...(error.rateLimitScope ? { scope: error.rateLimitScope } : {})
    });
  });

  app.get('/health', { config: { rateLimit: false } }, async () => ({ status: 'ok', service: 'oliveira-devcloud-api', version: '2.5.0' }));
  app.get('/ready', { config: { rateLimit: false } }, async (_request, reply) => {
    const dependencies = { database: 'error', redis: 'error', runtimeBroker: 'error' };

    try {
      await prisma.$queryRaw`SELECT 1`;
      dependencies.database = 'ok';
    } catch { /* reported below */ }

    const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
      lazyConnect: true,
      connectTimeout: 2_000,
      maxRetriesPerRequest: 0,
      enableOfflineQueue: false
    });
    try {
      await redis.connect();
      await redis.ping();
      dependencies.redis = 'ok';
    } catch { /* reported below */ }
    finally { redis.disconnect(); }

    try {
      const brokerBaseUrl = (process.env.RUNTIME_BROKER_URL ?? 'http://runtime-broker:5001').replace(/\/$/, '');
      const brokerResponse = await fetch(`${brokerBaseUrl}/ready`, { signal: AbortSignal.timeout(2_000) });
      if (brokerResponse.ok) dependencies.runtimeBroker = 'ok';
    } catch { /* reported below */ }

    if (Object.values(dependencies).every(status => status === 'ok')) {
      return { status: 'ready', ...dependencies };
    }
    return reply.code(503).send({ status: 'not-ready', ...dependencies });
  });
  app.get('/api/v1/system', async (request) => {
    await requireHostAdmin(request);
    return { workspaces: await prisma.workspace.count(), activeAgents: await prisma.agentTask.count({ where: { status: 'RUNNING' } }) };
  });

  await app.register(authRoutes, { prefix: '/api/v1/auth' });
  await app.register(organizationRoutes, { prefix: '/api/v1/organizations' });
  await app.register(projectRoutes, { prefix: '/api/v1/projects' });
  await app.register(workspaceRoutes, { prefix: '/api/v1/workspaces' });
  await app.register(terminalRoutes, { prefix: '/api/v1/terminals' });
  await app.register(ideRoutes, { prefix: '/api/v1/workspaces' });
  await app.register(agentRoutes, { prefix: '/api/v1/agents' });
  await app.register(orchestrationRoutes, { prefix: '/api/v1/orchestrations' });
  await app.register(secretRoutes, { prefix: '/api/v1/secrets' });
  await app.register(githubRoutes, { prefix: '/api/v1/github' });
  await app.register(repositoryRoutes, { prefix: '/api/v1/repositories' });
  await app.register(systemRoutes, { prefix: '/api/v1/system' });
  await app.register(activityRoutes, { prefix: '/api/v1/activity' });
  await app.register(setupRoutes, { prefix: '/api/v1/setup' });
  await app.register(commandCenterRoutes, { prefix: '/api/v1/command-center' });
  await app.register(repositoryIntelligenceRoutes, { prefix: '/api/v1/repository-intelligence' });
  await app.register(codeIntelligenceRoutes, { prefix: '/api/v1/code-intelligence' });
  await app.register(contextIntelligenceRoutes, { prefix: '/api/v1/context-intelligence' });
  await app.register(contractIntelligenceRoutes, { prefix: '/api/v1/contract-intelligence' });
  await app.register(deadLetterRoutes, { prefix: '/api/v1/dead-letters' });
  await registerRuntimeTicketRoute(app);
  registerRuntimeGateway(app);
  // Deprecated: superseded by the Runtime Gateway above (origin-isolated, ticket-authenticated).
  // Kept temporarily so in-flight iframes/links don't break mid-deploy; blocked outright in
  // production (see registerRuntimeProxy) since it serves untrusted workspace content same-origin
  // with the control plane.
  registerRuntimeProxy(app);

  return app;
}
