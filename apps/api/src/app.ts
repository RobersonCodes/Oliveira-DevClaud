import Fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
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
import { registerRuntimeProxy } from './lib/runtimeProxy.js';
import { registerRuntimeGateway, registerRuntimeTicketRoute } from './lib/runtimeGateway.js';
import { requireHostAdmin } from './lib/auth.js';

/**
 * Builds a fully-registered Fastify instance without binding it to a port, so integration tests
 * can exercise real routes/plugins/hooks against a real database via `app.inject()` instead of
 * spinning up an actual network listener (and index.ts stays a thin bootstrap around this).
 */
export async function buildApp(opts: { logger?: boolean; disableRateLimit?: boolean } = {}) {
  const app = Fastify({ logger: opts.logger ?? true, trustProxy: true });
  // This is a JSON-only API, never a source of HTML, so contentSecurityPolicy is off; the web app
  // legitimately fetches this API cross-origin with credentials, so CORP is relaxed to allow that
  // (COEP/COOP, which govern window/worker embedding rather than fetch, stay at Helmet's defaults).
  await app.register(helmet, { contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'cross-origin' } });
  await app.register(cors, { origin: process.env.WEB_ORIGIN ?? 'http://localhost:3000', credentials: true });
  await app.register(cookie);
  await app.register(websocket, { options: { maxPayload: 1024 * 1024 } });
  // Route-level `config: { rateLimit: {...} }` (e.g. auth.ts's stricter register/login limits) only
  // has any effect while this plugin is registered, so skipping registration is enough to disable
  // both the global default and every per-route override for integration tests.
  if (!opts.disableRateLimit) await app.register(rateLimit, { max: 120, timeWindow: '1 minute' });

  app.setErrorHandler((rawError, _request, reply) => {
    if (rawError instanceof ZodError) return reply.code(400).send({ error: 'VALIDATION_ERROR', issues: rawError.issues });
    const error = rawError as Error & { statusCode?: number };
    const statusCode = error.statusCode ?? 500;
    if (statusCode >= 500) app.log.error(error);
    return reply.code(statusCode).send({ error: statusCode >= 500 ? 'INTERNAL_SERVER_ERROR' : error.message });
  });

  app.get('/health', async () => ({ status: 'ok', service: 'oliveira-devcloud-api', version: '2.5.0' }));
  app.get('/ready', async (_request, reply) => {
    try { await prisma.$queryRaw`SELECT 1`; return { status: 'ready', database: 'ok' }; }
    catch { return reply.code(503).send({ status: 'not-ready', database: 'error' }); }
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
  await registerRuntimeTicketRoute(app);
  registerRuntimeGateway(app);
  // Deprecated: superseded by the Runtime Gateway above (origin-isolated, ticket-authenticated).
  // Kept temporarily so in-flight iframes/links don't break mid-deploy; blocked outright in
  // production (see registerRuntimeProxy) since it serves untrusted workspace content same-origin
  // with the control plane.
  registerRuntimeProxy(app);

  return app;
}
