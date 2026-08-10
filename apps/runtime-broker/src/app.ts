import Fastify from 'fastify';
import websocketPlugin from '@fastify/websocket';
import Docker from 'dockerode';
import { ZodError } from 'zod';
import {
  CreateWorkspaceContainerSchema,
  ExecRequestSchema,
  StopOrRestartSchema
} from '@oliveira/runtime-broker-client';
import { requireBrokerAuth } from './auth.js';
import { withAudit } from './audit.js';
import { execInContainer } from './exec.js';
import { handleExecTtySocket } from './execTty.js';
import { pruneOrphanedNetworks } from './network.js';
import {
  createWorkspaceContainer,
  destroyContainer,
  inspectContainer,
  restartContainer,
  startContainer,
  stopContainer,
  type BrokerConfig
} from './workspaceContainers.js';

export type BuildBrokerAppOptions = {
  logger?: boolean;
  docker?: Docker;
  config?: Partial<BrokerConfig>;
};

/**
 * Builds a fully-registered Fastify instance without binding it to a port — mirrors apps/api's
 * `buildApp()` so tests can start a real broker (backed by a real Docker daemon) on an ephemeral
 * port instead of mocking anything. This is the ONLY process in the whole system meant to hold
 * `docker.sock`; every route here is a narrow, purpose-built operation, never a generic Docker
 * passthrough — see workspaceContainers.ts and exec.ts for what's actually allowed.
 */
export async function buildBrokerApp(opts: BuildBrokerAppOptions = {}) {
  const app = Fastify({ logger: opts.logger ?? true });
  const docker = opts.docker ?? new Docker({ socketPath: process.env.DOCKER_SOCKET ?? '/var/run/docker.sock' });
  const config: BrokerConfig = {
    image: opts.config?.image ?? process.env.WORKSPACE_IMAGE ?? 'oliveira-devcloud/workspace-node:1.1.0',
    workspaceRoot: opts.config?.workspaceRoot ?? process.env.WORKSPACE_ROOT ?? '/var/lib/oliveira-devcloud/workspaces',
    relayContainerId: opts.config?.relayContainerId ?? process.env.RELAY_CONTAINER_NAME ?? undefined
  };

  await app.register(websocketPlugin, { options: { maxPayload: 4 * 1024 * 1024 } });

  app.setErrorHandler((rawError, _request, reply) => {
    if (rawError instanceof ZodError) return reply.code(400).send({ error: 'VALIDATION_ERROR', issues: rawError.issues });
    const error = rawError as Error & { statusCode?: number };
    const statusCode = error.statusCode ?? 500;
    if (statusCode >= 500) app.log.error(error);
    return reply.code(statusCode).send({ error: statusCode >= 500 ? 'INTERNAL_SERVER_ERROR' : error.message });
  });

  app.get('/health', async () => ({ status: 'ok', service: 'oliveira-devcloud-runtime-broker' }));
  app.get('/ready', async (_request, reply) => {
    try {
      await docker.ping();
      return { status: 'ready', docker: 'ok' };
    } catch {
      return reply.code(503).send({ status: 'not-ready', docker: 'error' });
    }
  });

  // Every route below is internal-only (never published on a host port) but still requires the
  // shared bearer token — defense in depth if the compose network topology is ever misconfigured.
  app.addHook('onRequest', async request => {
    if (request.url === '/health' || request.url === '/ready') return;
    requireBrokerAuth(request);
  });

  app.post('/v1/workspaces/:workspaceId/container', async request => {
    const { workspaceId } = request.params as { workspaceId: string };
    const input = CreateWorkspaceContainerSchema.parse(request.body);
    return withAudit('create-workspace-container', { workspaceId }, () => createWorkspaceContainer(docker, config, workspaceId, input));
  });

  app.get('/v1/containers/:id', async request => {
    const { id } = request.params as { id: string };
    return withAudit('inspect', { containerId: id }, () => inspectContainer(docker, id));
  });

  app.post('/v1/containers/:id/start', async (request, reply) => {
    const { id } = request.params as { id: string };
    await withAudit('start', { containerId: id }, () => startContainer(docker, id));
    reply.code(204);
  });

  app.post('/v1/containers/:id/stop', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = StopOrRestartSchema.parse(request.body ?? {});
    await withAudit('stop', { containerId: id }, () => stopContainer(docker, id, body.timeoutSeconds));
    reply.code(204);
  });

  app.post('/v1/containers/:id/restart', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = StopOrRestartSchema.parse(request.body ?? {});
    await withAudit('restart', { containerId: id }, () => restartContainer(docker, id, body.timeoutSeconds));
    reply.code(204);
  });

  app.delete('/v1/containers/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { workspaceId } = request.query as { workspaceId?: string };
    await withAudit('destroy', { containerId: id, workspaceId }, () => destroyContainer(docker, config, id, workspaceId));
    reply.code(204);
  });

  app.post('/v1/containers/:id/exec', async request => {
    const { id } = request.params as { id: string };
    const input = ExecRequestSchema.parse(request.body);
    return withAudit('exec', { containerId: id, cmd0: input.cmd[0] }, () => execInContainer(docker, id, input));
  });

  app.post('/v1/maintenance/prune-networks', async () => {
    const removed = await withAudit('prune-networks', {}, () => pruneOrphanedNetworks(docker));
    return { removed };
  });

  app.get('/v1/containers/:id/exec-tty', { websocket: true }, (socket, request) => {
    const { id } = request.params as { id: string };
    void handleExecTtySocket(socket, docker, id);
  });

  return app;
}
