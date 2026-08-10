import Docker from 'dockerode';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DockerWorkspaceEngine } from './index.js';
import { ensureWorkspaceNetwork, pruneOrphanedNetworks, workspaceNetworkName } from './network.js';

// Real Docker: creates real containers and real networks against the daemon at DOCKER_SOCKET. This
// is the Fase 3 (P0-3) regression — proves two workspaces cannot reach each other by IP anymore,
// each workspace gets exactly one dedicated network, and destroy()/pruneOrphanedNetworks() clean up
// without ever touching a network they don't own.
const IMAGE = 'alpine:3.20';
const docker = new Docker({ socketPath: process.env.DOCKER_SOCKET ?? '/var/run/docker.sock' });

let workspaceRoot: string;
const containerIds: string[] = [];
const networkNames: string[] = [];

beforeAll(async () => {
  await new Promise<void>((resolve, reject) => {
    docker.pull(IMAGE, (err: unknown, stream: NodeJS.ReadableStream) => {
      if (err) return reject(err);
      docker.modem.followProgress(stream, (e: unknown) => (e ? reject(e) : resolve()));
    });
  });
  workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'odc-network-test-'));
}, 60_000);

afterEach(async () => {
  while (containerIds.length) {
    const id = containerIds.pop()!;
    const container = docker.getContainer(id);
    await container.stop({ t: 1 }).catch(() => undefined);
    await container.remove({ force: true }).catch(() => undefined);
  }
  while (networkNames.length) {
    const name = networkNames.pop()!;
    await docker.getNetwork(name).remove().catch(() => undefined);
  }
  // Several tests exercise create() directly without ever calling destroy() — sweep whatever
  // dedicated network(s) that left behind now that their container is gone, so this suite never
  // leaks networks between runs (this is exactly pruneOrphanedNetworks's intended use, just
  // invoked eagerly here instead of on the periodic Fase 7 schedule).
  await pruneOrphanedNetworks(docker).catch(() => undefined);
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

async function ip(containerId: string): Promise<string> {
  const info = await docker.getContainer(containerId).inspect();
  const networks = Object.values(info.NetworkSettings.Networks ?? {});
  const address = networks.map(n => n.IPAddress).find(Boolean);
  if (!address) throw new Error('container has no IP address');
  return address;
}

// `nc -z` against a routed-but-refusing port still exits fast; against an *unroutable* address
// (the isolation we're proving) busybox nc waits out the connect timeout, so `-w 2` bounds it.
async function canConnect(fromContainerId: string, targetIp: string, port: number): Promise<boolean> {
  const container = docker.getContainer(fromContainerId);
  const exec = await container.exec({ Cmd: ['nc', '-z', '-w', '2', targetIp, String(port)], AttachStdout: true, AttachStderr: true });
  const stream = await exec.start({ hijack: true, stdin: false });
  await new Promise<void>((resolve, reject) => { stream.on('end', resolve); stream.on('error', reject); stream.resume(); });
  const result = await exec.inspect();
  return result.ExitCode === 0;
}

describe('per-workspace Docker network isolation (P0-3)', () => {
  it('gives two workspaces distinct, dedicated networks and blocks cross-workspace IP access', async () => {
    const engine = new DockerWorkspaceEngine({ socketPath: process.env.DOCKER_SOCKET, image: IMAGE, workspaceRoot });
    const inputA = workspaceInput();
    const inputB = workspaceInput();

    const a = await engine.create(inputA);
    containerIds.push(a.containerId);
    const b = await engine.create(inputB);
    containerIds.push(b.containerId);

    const infoA = await docker.getContainer(a.containerId).inspect();
    const infoB = await docker.getContainer(b.containerId).inspect();
    const networksA = Object.keys(infoA.NetworkSettings.Networks ?? {});
    const networksB = Object.keys(infoB.NetworkSettings.Networks ?? {});
    expect(networksA).toEqual([workspaceNetworkName(inputA.workspaceId)]);
    expect(networksB).toEqual([workspaceNetworkName(inputB.workspaceId)]);
    expect(networksA[0]).not.toBe(networksB[0]);

    // B listens on a real port; A must not even be able to open a TCP connection to it — proves
    // the isolation is at the network layer, not just "nothing happens to be listening".
    const listenerExec = await docker.getContainer(b.containerId).exec({ Cmd: ['sh', '-c', 'nc -l -p 9000 &'], AttachStdout: true, AttachStderr: true });
    const listenerStream = await listenerExec.start({ hijack: true, stdin: false });
    await new Promise<void>((resolve, reject) => { listenerStream.on('end', resolve); listenerStream.on('error', reject); listenerStream.resume(); });
    await new Promise(r => setTimeout(r, 300));

    const bIp = await ip(b.containerId);
    expect(await canConnect(a.containerId, bIp, 9000)).toBe(false);
  }, 45_000);

  it('create() reuses the same dedicated network on a repeat call instead of creating a duplicate', async () => {
    const engine = new DockerWorkspaceEngine({ socketPath: process.env.DOCKER_SOCKET, image: IMAGE, workspaceRoot });
    const input = workspaceInput();
    const first = await engine.create(input);
    containerIds.push(first.containerId);
    await engine.create(input); // idempotent container reuse — must not error or create a 2nd network

    const matches = await docker.listNetworks({ filters: JSON.stringify({ name: [workspaceNetworkName(input.workspaceId)] }) });
    expect(matches.length).toBe(1);
  }, 30_000);

  it('destroy() removes the container and its dedicated network, and never touches other workspaces\' networks', async () => {
    const engine = new DockerWorkspaceEngine({ socketPath: process.env.DOCKER_SOCKET, image: IMAGE, workspaceRoot });
    const inputA = workspaceInput();
    const inputB = workspaceInput();
    const a = await engine.create(inputA);
    const b = await engine.create(inputB);
    containerIds.push(b.containerId);

    await engine.destroy(a.containerId, inputA.workspaceId);

    await expect(docker.getContainer(a.containerId).inspect()).rejects.toMatchObject({ statusCode: 404 });
    await expect(docker.getNetwork(workspaceNetworkName(inputA.workspaceId)).inspect()).rejects.toMatchObject({ statusCode: 404 });
    // B's network survives A's destroy() untouched.
    await expect(docker.getNetwork(workspaceNetworkName(inputB.workspaceId)).inspect()).resolves.toBeTruthy();
  }, 30_000);

  it('destroy() is idempotent and safe to call twice for the same workspace', async () => {
    const engine = new DockerWorkspaceEngine({ socketPath: process.env.DOCKER_SOCKET, image: IMAGE, workspaceRoot });
    const input = workspaceInput();
    const runtime = await engine.create(input);
    await engine.destroy(runtime.containerId, input.workspaceId);
    await expect(engine.destroy(runtime.containerId, input.workspaceId)).resolves.toBeUndefined();
  }, 30_000);

  it('connects and disconnects a configured relay container to exactly the workspace networks it needs', async () => {
    const relay = await docker.createContainer({ Image: IMAGE, Cmd: ['sleep', 'infinity'], HostConfig: { AutoRemove: false } });
    await relay.start();
    containerIds.push(relay.id);

    const engine = new DockerWorkspaceEngine({ socketPath: process.env.DOCKER_SOCKET, image: IMAGE, workspaceRoot, relayContainerId: relay.id });
    const input = workspaceInput();
    const runtime = await engine.create(input);
    containerIds.push(runtime.containerId);

    const networkName = workspaceNetworkName(input.workspaceId);
    const netInfo = await docker.getNetwork(networkName).inspect();
    expect(Object.keys(netInfo.Containers ?? {})).toContain(relay.id);

    await engine.destroy(runtime.containerId, input.workspaceId);
    await expect(docker.getNetwork(networkName).inspect()).rejects.toMatchObject({ statusCode: 404 });
    // Relay container itself is untouched, just disconnected from the now-gone network.
    const relayInfo = await docker.getContainer(relay.id).inspect();
    expect(relayInfo.State.Running).toBe(true);
  }, 30_000);

  it('pruneOrphanedNetworks removes only labeled networks with zero attached containers', async () => {
    const orphanId = crypto.randomUUID();
    const inUseId = crypto.randomUUID();
    const orphanName = await ensureWorkspaceNetwork(docker, orphanId);
    const inUseName = await ensureWorkspaceNetwork(docker, inUseId);
    networkNames.push(orphanName, inUseName);

    const container = await docker.createContainer({ Image: IMAGE, Cmd: ['sleep', 'infinity'], HostConfig: { NetworkMode: inUseName, AutoRemove: false } });
    await container.start();
    containerIds.push(container.id);

    const removed = await pruneOrphanedNetworks(docker);
    expect(removed).toContain(orphanName);
    expect(removed).not.toContain(inUseName);
    await expect(docker.getNetwork(orphanName).inspect()).rejects.toMatchObject({ statusCode: 404 });
    await expect(docker.getNetwork(inUseName).inspect()).resolves.toBeTruthy();
  }, 30_000);
});
