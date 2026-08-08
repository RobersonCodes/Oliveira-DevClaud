import Docker from 'dockerode';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs/promises';

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
  destroy(containerId: string): Promise<void>;
  inspect(containerId: string): Promise<{ status: string; running: boolean; startedAt?: string; finishedAt?: string }>;
}

const safeId = (value: string) => value.replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 64);

export class DockerWorkspaceEngine implements WorkspaceEngine {
  private docker: Docker;
  private image: string;
  private root: string;

  constructor(opts?: { socketPath?: string; image?: string; workspaceRoot?: string }) {
    this.docker = new Docker({ socketPath: opts?.socketPath ?? process.env.DOCKER_SOCKET ?? '/var/run/docker.sock' });
    this.image = opts?.image ?? process.env.WORKSPACE_IMAGE ?? 'oliveira-devcloud/workspace-node:1.0';
    this.root = path.resolve(opts?.workspaceRoot ?? process.env.WORKSPACE_ROOT ?? '/var/lib/oliveira-devcloud/workspaces');
  }

  async create(input: CreateWorkspaceInput): Promise<WorkspaceRuntime> {
    const name = `odc-${safeId(input.workspaceId)}`;
    const workspacePath = path.join(this.root, safeId(input.workspaceId));
    await fs.mkdir(path.join(workspacePath, 'repository'), { recursive: true, mode: 0o770 });
    await fs.chown(workspacePath, 10001, 10001).catch(() => undefined);
    await fs.chown(path.join(workspacePath, 'repository'), 10001, 10001).catch(() => undefined);

    const nanoCpus = Math.max(0.25, Math.min(input.limits.cpuLimit, 16)) * 1_000_000_000;
    const memory = Math.max(256, Math.min(input.limits.memoryMb, 32768)) * 1024 * 1024;

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
        NetworkMode: process.env.WORKSPACE_NETWORK ?? 'bridge',
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
  async destroy(id: string) { const c = this.docker.getContainer(id); try { const i = await c.inspect(); if (i.State.Running) await c.stop({ t: 10 }); } catch {} await c.remove({ force: true }); }
  async inspect(id: string) {
    const i = await this.docker.getContainer(id).inspect();
    return { status: i.State.Status, running: i.State.Running, startedAt: i.State.StartedAt, finishedAt: i.State.FinishedAt };
  }
}
