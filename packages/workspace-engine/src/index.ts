import Docker from 'dockerode';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs/promises';
import { connectRelayToWorkspaceNetwork, disconnectRelayFromWorkspaceNetwork, ensureWorkspaceNetwork, removeWorkspaceNetwork, workspaceNetworkName } from './network.js';

export { pruneOrphanedNetworks, workspaceNetworkName, WORKSPACE_NETWORK_NAME_PREFIX } from './network.js';

export type WorkspaceLimits = { cpuLimit: number; memoryMb: number };
export type CreateWorkspaceInput = {
  workspaceId: string;
  projectId: string;
  repositoryUrl?: string | null;
  defaultBranch?: string;
  limits: WorkspaceLimits;
};

export type WorkspaceRuntime = {
  containerId: string;
  name: string;
  status: string;
  workspacePath: string;
};

export interface WorkspaceEngine {
  create(input: CreateWorkspaceInput): Promise<WorkspaceRuntime>;
  start(containerId: string): Promise<void>;
  stop(containerId: string): Promise<void>;
  restart(containerId: string): Promise<void>;
  destroy(containerId: string, workspaceId?: string): Promise<void>;
  inspect(containerId: string): Promise<{ status: string; running: boolean; startedAt?: string; finishedAt?: string }>;
}

const safeId = (value: string) => value.replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 64);
const isDockerNotFound = (err: unknown) => typeof err === 'object' && err !== null && 'statusCode' in err && (err as { statusCode: unknown }).statusCode === 404;

export class DockerWorkspaceEngine implements WorkspaceEngine {
  private docker: Docker;
  private image: string;
  private root: string;
  // Set (in production, to the api container's own name/ID via RELAY_CONTAINER_NAME) only when
  // this process itself runs inside a container. A host process (dev, CI) can already route to any
  // Docker bridge network's containers without joining it explicitly.
  private relayContainerId?: string;

  constructor(opts?: { socketPath?: string; image?: string; workspaceRoot?: string; relayContainerId?: string }) {
    this.docker = new Docker({ socketPath: opts?.socketPath ?? process.env.DOCKER_SOCKET ?? '/var/run/docker.sock' });
    this.image = opts?.image ?? process.env.WORKSPACE_IMAGE ?? 'oliveira-devcloud/workspace-node:1.0';
    this.root = path.resolve(opts?.workspaceRoot ?? process.env.WORKSPACE_ROOT ?? '/var/lib/oliveira-devcloud/workspaces');
    this.relayContainerId = opts?.relayContainerId ?? process.env.RELAY_CONTAINER_NAME ?? undefined;
  }

  async create(input: CreateWorkspaceInput): Promise<WorkspaceRuntime> {
    const name = `odc-${safeId(input.workspaceId)}`;
    const workspacePath = path.join(this.root, safeId(input.workspaceId));
    await fs.mkdir(path.join(workspacePath, 'repository'), { recursive: true, mode: 0o770 });
    await fs.chown(workspacePath, 10001, 10001).catch(() => undefined);
    await fs.chown(path.join(workspacePath, 'repository'), 10001, 10001).catch(() => undefined);

    const nanoCpus = Math.max(0.25, Math.min(input.limits.cpuLimit, 16)) * 1_000_000_000;
    const memory = Math.max(256, Math.min(input.limits.memoryMb, 32768)) * 1024 * 1024;

    // Own network per workspace, created/reused before the container so the container can be
    // attached to it at creation time — and the relay (re)connected on every call, since a redeploy
    // gives the relay container a new ID even for a workspace that already existed.
    const networkName = await ensureWorkspaceNetwork(this.docker, input.workspaceId);
    await connectRelayToWorkspaceNetwork(this.docker, networkName, this.relayContainerId);

    const existing = this.docker.getContainer(name);
    try {
      const info = await existing.inspect();
      return { containerId: info.Id, name, status: info.State.Status, workspacePath };
    } catch { /* does not exist */ }

    const container = await this.docker.createContainer({
      Image: this.image,
      name,
      WorkingDir: '/workspace/repository',
      Cmd: ['sleep', 'infinity'],
      Tty: true,
      OpenStdin: true,
      Labels: {
        'dev.oliveira.devcloud': 'workspace',
        'dev.oliveira.workspace-id': input.workspaceId,
        'dev.oliveira.project-id': input.projectId,
        'dev.oliveira.nonce': crypto.randomBytes(8).toString('hex')
      },
      Env: [
        `ODC_WORKSPACE_ID=${input.workspaceId}`,
        `ODC_PROJECT_ID=${input.projectId}`,
        `ODC_DEFAULT_BRANCH=${input.defaultBranch ?? 'main'}`
      ],
      HostConfig: {
        NanoCpus: nanoCpus,
        Memory: memory,
        MemorySwap: memory,
        PidsLimit: 512,
        AutoRemove: false,
        // Each workspace gets its own bridge network (see network.ts) instead of a network shared
        // by every workspace — Docker does not route between distinct bridge networks by default,
        // so this is what actually stops workspace A reaching workspace B by IP (P0-3).
        NetworkMode: networkName,
        Binds: [`${workspacePath}:/workspace`],
        SecurityOpt: ['no-new-privileges:true'],
        CapDrop: ['ALL']
      }
    });
    await container.start();
    return { containerId: container.id, name, status: 'running', workspacePath };
  }

  async start(id: string) { const c = this.docker.getContainer(id); const i = await c.inspect(); if (!i.State.Running) await c.start(); }
  async stop(id: string) { const c = this.docker.getContainer(id); const i = await c.inspect(); if (i.State.Running) await c.stop({ t: 10 }); }
  async restart(id: string) { await this.docker.getContainer(id).restart({ t: 10 }); }

  async destroy(id: string, workspaceId?: string) {
    const c = this.docker.getContainer(id);
    let resolvedWorkspaceId = workspaceId;
    if (!resolvedWorkspaceId) {
      try { resolvedWorkspaceId = (await c.inspect()).Config.Labels?.['dev.oliveira.workspace-id']; } catch { /* already gone */ }
    }
    try { const i = await c.inspect(); if (i.State.Running) await c.stop({ t: 10 }); } catch {}
    try { await c.remove({ force: true }); } catch (err) { if (!isDockerNotFound(err)) throw err; }
    if (resolvedWorkspaceId) {
      const networkName = workspaceNetworkName(resolvedWorkspaceId);
      await disconnectRelayFromWorkspaceNetwork(this.docker, networkName, this.relayContainerId);
      // Best-effort: if this fails because another endpoint is still attached, the orphan sweep in
      // network.ts (invoked by the Fase 7 reaper) removes it once nothing references it anymore.
      await removeWorkspaceNetwork(this.docker, resolvedWorkspaceId);
    }
  }
  async inspect(id: string) {
    const i = await this.docker.getContainer(id).inspect();
    return { status: i.State.Status, running: i.State.Running, startedAt: i.State.StartedAt, finishedAt: i.State.FinishedAt };
  }
}
