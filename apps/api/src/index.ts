import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
// `npm run dev -w @oliveira/api` runs with cwd set to apps/api, not the repo root, so the
// default dotenv cwd-lookup would never find the root .env. Resolve it relative to this file instead.
loadEnv({ path: fileURLToPath(new URL('../../../.env', import.meta.url)) });
import Fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
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

const app = Fastify({ logger: true, trustProxy: true });
await app.register(cors, { origin: process.env.WEB_ORIGIN ?? 'http://localhost:3000', credentials: true });
await app.register(cookie);
await app.register(websocket, { options: { maxPayload: 1024 * 1024 } });
await app.register(rateLimit, { max: 120, timeWindow: '1 minute' });

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
app.get('/api/v1/system', async () => ({ workspaces: await prisma.workspace.count(), activeAgents: await prisma.agentTask.count({ where: { status: 'RUNNING' } }) }));

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
registerRuntimeProxy(app);

const port = Number(process.env.API_PORT ?? 4000);
await app.listen({ port, host: '0.0.0.0' });
