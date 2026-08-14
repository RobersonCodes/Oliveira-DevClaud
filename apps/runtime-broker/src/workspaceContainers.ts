import Docker from 'dockerode';
import crypto from 'node:crypto';
import path from 'node:path';
import type { ValidatedCreateWorkspaceContainerInput, ContainerInspectResult, WorkspaceContainerResult } from '@oliveira/runtime-broker-client';
import { connectRelayToWorkspaceNetwork, disconnectRelayFromWorkspaceNetwork, ensureWorkspaceNetwork, removeWorkspaceNetwork, workspaceNetworkName } from './network.js';

const safeId = (value: string) => value.replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 64);
const isDockerNotFound = (err: unknown) => typeof err === 'object' && err !== null && 'statusCode' in err && (err as { statusCode: unknown }).statusCode === 404;

export type BrokerConfig = {
  image: string;
  workspaceRoot: string;
  relayContainerId?: string;
};

/**
 * Everything a workspace container is allowed to be: the image, resource ceilings, bind path and
 * every hardening flag (`CapDrop`, `no-new-privileges`, no `Privileged`) are fixed here, in the one
 * place with `docker.sock` — none of it is accepted from the caller. The caller (workspace-engine,
 * running in api/worker) only ever supplies a workspaceId, a projectId for labeling, and a resource
 * request that gets clamped, never applied verbatim.
 */
export async function createWorkspaceContainer(docker: Docker, config: BrokerConfig, workspaceId: string, input: ValidatedCreateWorkspaceContainerInput): Promise<WorkspaceContainerResult> {
  const name = `odc-${safeId(workspaceId)}`;
  const workspacePath = path.join(config.workspaceRoot, safeId(workspaceId));

  const networkName = await ensureWorkspaceNetwork(docker, workspaceId);
  await connectRelayToWorkspaceNetwork(docker, networkName, config.relayContainerId);

  const existing = docker.getContainer(name);
  try {
    const info = await existing.inspect();
    return { containerId: info.Id, name, status: info.State.Status };
  } catch { /* does not exist yet */ }

  const nanoCpus = Math.max(0.25, Math.min(input.limits.cpuLimit, 16)) * 1_000_000_000;
  const memory = Math.max(256, Math.min(input.limits.memoryMb, 32768)) * 1024 * 1024;

  const container = await docker.createContainer({
    Image: config.image,
    name,
    WorkingDir: '/workspace/repository',
    Cmd: ['sleep', 'infinity'],
    Tty: true,
    OpenStdin: true,
    Labels: {
      'dev.oliveira.devcloud': 'workspace',
      'dev.oliveira.workspace-id': workspaceId,
      'dev.oliveira.project-id': input.projectId,
      'dev.oliveira.disk-mb': String(input.limits.diskMb),
      'dev.oliveira.max-runtime-minutes': String(input.limits.maxRuntimeMinutes),
      'dev.oliveira.nonce': crypto.randomBytes(8).toString('hex')
    },
    Env: [
      `ODC_WORKSPACE_ID=${workspaceId}`,
      `ODC_PROJECT_ID=${input.projectId}`,
      `ODC_DEFAULT_BRANCH=${input.defaultBranch ?? 'main'}`
    ],
    HostConfig: {
      NanoCpus: nanoCpus,
      Memory: memory,
      MemorySwap: memory,
      PidsLimit: input.limits.pidsLimit,
      AutoRemove: false,
      NetworkMode: networkName,
      Binds: [`${workspacePath}:/workspace`],
      SecurityOpt: ['no-new-privileges:true'],
      CapDrop: ['ALL']
    }
  });
  await container.start();
  return { containerId: container.id, name, status: 'running' };
}

export async function inspectContainer(docker: Docker, containerId: string): Promise<ContainerInspectResult> {
  const info = await docker.getContainer(containerId).inspect();
  const networks: ContainerInspectResult['networks'] = {};
  for (const [netName, net] of Object.entries(info.NetworkSettings.Networks ?? {})) {
    networks[netName] = { ipAddress: net.IPAddress || null };
  }
  return {
    id: info.Id,
    name: info.Name.replace(/^\//, ''),
    status: info.State.Status,
    running: info.State.Running,
    startedAt: info.State.StartedAt,
    finishedAt: info.State.FinishedAt,
    networks,
    labels: info.Config.Labels ?? {}
  };
}

export async function startContainer(docker: Docker, containerId: string): Promise<void> {
  const c = docker.getContainer(containerId);
  const i = await c.inspect();
  if (!i.State.Running) await c.start();
}

export async function stopContainer(docker: Docker, containerId: string, timeoutSeconds: number): Promise<void> {
  const c = docker.getContainer(containerId);
  const i = await c.inspect();
  if (i.State.Running) await c.stop({ t: timeoutSeconds });
}

export async function restartContainer(docker: Docker, containerId: string, timeoutSeconds: number): Promise<void> {
  await docker.getContainer(containerId).restart({ t: timeoutSeconds });
}

export async function destroyContainer(docker: Docker, config: BrokerConfig, containerId: string, workspaceId: string | undefined): Promise<void> {
  const c = docker.getContainer(containerId);
  let resolvedWorkspaceId = workspaceId;
  if (!resolvedWorkspaceId) {
    try { resolvedWorkspaceId = (await c.inspect()).Config.Labels?.['dev.oliveira.workspace-id']; } catch { /* already gone */ }
  }
  try { const i = await c.inspect(); if (i.State.Running) await c.stop({ t: 10 }); } catch { /* already gone */ }
  try { await c.remove({ force: true }); } catch (err) { if (!isDockerNotFound(err)) throw err; }
  if (resolvedWorkspaceId) {
    const networkName = workspaceNetworkName(resolvedWorkspaceId);
    await disconnectRelayFromWorkspaceNetwork(docker, networkName, config.relayContainerId);
    await removeWorkspaceNetwork(docker, resolvedWorkspaceId);
  }
}
