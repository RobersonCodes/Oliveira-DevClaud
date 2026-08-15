import path from 'node:path';
import fs from 'node:fs/promises';
import { RuntimeBrokerClient, type RuntimeBrokerClientOptions } from '@oliveira/runtime-broker-client';

export type WorkspaceLimits = {
  cpuLimit: number;
  memoryMb: number;
  pidsLimit?: number;
  diskMb?: number;
  maxRuntimeMinutes?: number;
};
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

/**
 * All Docker API access has moved behind the Runtime Broker (apps/runtime-broker) — this class no
 * longer touches `docker.sock` at all, only the host filesystem (preparing the bind-mounted
 * workspace directory, which api/worker still need visible in their own container to `fs.mkdir`/
 * `fs.chown` it — see the comment on `WORKSPACE_ROOT_HOST` in docker-compose.prod.yml) and the
 * broker's HTTP API for everything container-related.
 */
export class DockerWorkspaceEngine implements WorkspaceEngine {
  private broker: RuntimeBrokerClient;
  private root: string;

  constructor(opts?: RuntimeBrokerClientOptions & { workspaceRoot?: string }) {
    this.broker = new RuntimeBrokerClient(opts);
    this.root = path.resolve(opts?.workspaceRoot ?? process.env.WORKSPACE_ROOT ?? '/var/lib/oliveira-devcloud/workspaces');
  }

  async create(input: CreateWorkspaceInput): Promise<WorkspaceRuntime> {
    const workspacePath = path.join(this.root, safeId(input.workspaceId));
    await fs.mkdir(path.join(workspacePath, 'repository'), { recursive: true, mode: 0o770 });
    await fs.chown(workspacePath, 10001, 10001).catch(() => undefined);
    await fs.chown(path.join(workspacePath, 'repository'), 10001, 10001).catch(() => undefined);

    const result = await this.broker.createWorkspaceContainer(input.workspaceId, {
      projectId: input.projectId,
      defaultBranch: input.defaultBranch,
      limits: input.limits
    });
    return { ...result, workspacePath };
  }

  async start(id: string) { await this.broker.start(id); }
  async stop(id: string) { await this.broker.stop(id, 10); }
  async restart(id: string) { await this.broker.restart(id, 10); }
  async destroy(id: string, workspaceId?: string) {
    await this.broker.destroy(id, workspaceId);
    if (!workspaceId) return;
    const workspacePath = path.join(this.root, safeId(workspaceId));
    // The broker/container must be gone before its bind mount is reclaimed. Resolve only one
    // direct child of the configured workspace root; never follow a caller-controlled path.
    if (path.dirname(workspacePath) !== this.root || path.basename(workspacePath) !== safeId(workspaceId)) {
      throw new Error('INVALID_WORKSPACE_STORAGE_PATH');
    }
    await fs.rm(workspacePath, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }

  async inspect(id: string) {
    const info = await this.broker.inspect(id);
    return { status: info.status, running: info.running, startedAt: info.startedAt, finishedAt: info.finishedAt };
  }
}
