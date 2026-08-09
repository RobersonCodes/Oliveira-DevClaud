import Docker from 'dockerode';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DockerWorkspaceEngine } from './index.js';

// Real Docker container lifecycle — no mocking of dockerode. Uses a lightweight `alpine:3.20`
// override instead of the real (heavyweight, apt/code-server-installing) workspace image: this
// package's own responsibility is container orchestration (limits, binds, lifecycle), not image
// contents, and alpine exercises the exact same dockerode calls against a real daemon.
const IMAGE = 'alpine:3.20';
const docker = new Docker({ socketPath: process.env.DOCKER_SOCKET ?? '/var/run/docker.sock' });

let workspaceRoot: string;
let engine: DockerWorkspaceEngine;
const containerIds: string[] = [];

beforeAll(async () => {
  await new Promise<void>((resolve, reject) => {
    docker.pull(IMAGE, (err: unknown, stream: NodeJS.ReadableStream) => {
      if (err) return reject(err);
      docker.modem.followProgress(stream, (e: unknown) => (e ? reject(e) : resolve()));
    });
  });
  workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'odc-workspace-engine-'));
  engine = new DockerWorkspaceEngine({ socketPath: process.env.DOCKER_SOCKET, image: IMAGE, workspaceRoot });
}, 60_000);

afterEach(async () => {
  while (containerIds.length) {
    const id = containerIds.pop()!;
    const container = docker.getContainer(id);
    await container.stop({ t: 1 }).catch(() => undefined);
    await container.remove({ force: true }).catch(() => undefined);
  }
});

afterAll(async () => {
  if (workspaceRoot) await fs.rm(workspaceRoot, { recursive: true, force: true }).catch(() => undefined);
}, 30_000);

function workspaceInput(overrides: Partial<Parameters<DockerWorkspaceEngine['create']>[0]> = {}) {
  return {
    workspaceId: crypto.randomUUID(),
    projectId: crypto.randomUUID(),
    limits: { cpuLimit: 1, memoryMb: 512 },
    ...overrides
  };
}

describe('DockerWorkspaceEngine — real Docker container lifecycle', () => {
  it('creates a running container with the workspace bind mount and resource limits enforced', async () => {
    const input = workspaceInput();
    const runtime = await engine.create(input);
    containerIds.push(runtime.containerId);

    expect(runtime.status).toBe('running');
    const info = await docker.getContainer(runtime.containerId).inspect();
    expect(info.State.Running).toBe(true);
    expect(info.HostConfig.NanoCpus).toBe(1_000_000_000);
    expect(info.HostConfig.Memory).toBe(512 * 1024 * 1024);
    expect(info.HostConfig.PidsLimit).toBe(512);
    expect(info.HostConfig.CapDrop).toEqual(['ALL']);
    expect(info.HostConfig.SecurityOpt).toContain('no-new-privileges:true');
    expect(info.HostConfig.Binds?.some(b => b.endsWith(':/workspace'))).toBe(true);

    // create() also has to have prepared the bind-mounted directory on the host before starting.
    const stat = await fs.stat(path.join(runtime.workspacePath, 'repository'));
    expect(stat.isDirectory()).toBe(true);
  });

  it('clamps cpu/memory limits to the safe min/max range instead of trusting the caller', async () => {
    const runtime = await engine.create(workspaceInput({ limits: { cpuLimit: 999, memoryMb: 999_999 } }));
    containerIds.push(runtime.containerId);
    const info = await docker.getContainer(runtime.containerId).inspect();
    expect(info.HostConfig.NanoCpus).toBe(16 * 1_000_000_000);
    expect(info.HostConfig.Memory).toBe(32768 * 1024 * 1024);
  });

  it('create() is idempotent for the same workspaceId — reuses the existing container instead of duplicating it', async () => {
    const input = workspaceInput();
    const first = await engine.create(input);
    containerIds.push(first.containerId);
    const second = await engine.create(input);
    expect(second.containerId).toBe(first.containerId);
  });

  it('stop() and start() toggle the real container state', async () => {
    const runtime = await engine.create(workspaceInput());
    containerIds.push(runtime.containerId);

    await engine.stop(runtime.containerId);
    expect((await engine.inspect(runtime.containerId)).running).toBe(false);

    await engine.start(runtime.containerId);
    expect((await engine.inspect(runtime.containerId)).running).toBe(true);
    // stop() uses a real 10s graceful-shutdown grace period (`sleep infinity` ignores SIGTERM),
    // which is the right production default but needs headroom over vitest's 5s default here.
  }, 20_000);

  it('restart() cycles the container and it ends up running again', async () => {
    const runtime = await engine.create(workspaceInput());
    containerIds.push(runtime.containerId);
    await engine.restart(runtime.containerId);
    expect((await engine.inspect(runtime.containerId)).running).toBe(true);
  }, 20_000);

  it('destroy() removes the container entirely, even while running', async () => {
    const runtime = await engine.create(workspaceInput());
    await engine.destroy(runtime.containerId);
    await expect(docker.getContainer(runtime.containerId).inspect()).rejects.toMatchObject({ statusCode: 404 });
  }, 20_000);
});
