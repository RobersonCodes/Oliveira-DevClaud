import Docker from 'dockerode';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import WebSocket from 'ws';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { RuntimeBrokerClient } from '@oliveira/runtime-broker-client';
import { startTestBroker } from './testHelpers.js';
import { pruneOrphanedNetworks } from './network.js';

// Real broker (real Fastify app) against a real Docker daemon — this is the contract-level
// regression suite for the whole Runtime Broker: auth, the workspace-container allowlist, exec, and
// the interactive TTY WebSocket. Uses `alpine:3.20` in place of the real (heavyweight) workspace
// image for the same reason packages/workspace-engine's own tests do — this package's job is
// orchestration, not image contents.
const IMAGE = 'alpine:3.20';
const docker = new Docker({ socketPath: process.env.DOCKER_SOCKET ?? '/var/run/docker.sock' });

// The broker's own ceiling clamp (16 cores) is not host-aware, and Docker itself hard-rejects a
// NanoCpus quota above the real host CPU count — so how high the ceiling test can safely push
// depends on the machine running it (CI commonly has far fewer cores than a dev machine). Resolved
// at module scope so it's available synchronously for `it.skipIf` below — same pattern as
// packages/workspace-engine's own equivalent test.
const hostCpus = (await docker.info()).NCPU as number;

let workspaceRoot: string;
const containerIds: string[] = [];

beforeAll(async () => {
  await new Promise<void>((resolve, reject) => {
    docker.pull(IMAGE, (err: unknown, stream: NodeJS.ReadableStream) => {
      if (err) return reject(err);
      docker.modem.followProgress(stream, (e: unknown) => (e ? reject(e) : resolve()));
    });
  });
  workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'odc-runtime-broker-test-'));
}, 60_000);

afterEach(async () => {
  while (containerIds.length) {
    const id = containerIds.pop()!;
    const container = docker.getContainer(id);
    await container.stop({ t: 1 }).catch(() => undefined);
    await container.remove({ force: true }).catch(() => undefined);
  }
  // Several tests never call destroy() (they only exercise create/inspect/exec) — sweep whatever
  // dedicated network(s) that left behind so this suite never exhausts Docker's default bridge
  // subnet pool across a long run, same as packages/workspace-engine's own tests.
  await pruneOrphanedNetworks(docker).catch(() => undefined);
});

afterAll(async () => {
  if (workspaceRoot) await fs.rm(workspaceRoot, { recursive: true, force: true }).catch(() => undefined);
}, 30_000);

async function withBroker<T>(fn: (client: RuntimeBrokerClient, broker: Awaited<ReturnType<typeof startTestBroker>>) => Promise<T>): Promise<T> {
  const broker = await startTestBroker({ docker, config: { image: IMAGE, workspaceRoot } });
  try {
    const client = new RuntimeBrokerClient({ baseUrl: broker.url, token: broker.token });
    return await fn(client, broker);
  } finally {
    await broker.close();
  }
}

describe('Runtime Broker — auth', () => {
  it('health check requires no auth', async () => {
    const broker = await startTestBroker({ docker, config: { image: IMAGE, workspaceRoot } });
    try {
      const res = await fetch(`${broker.url}/health`);
      expect(res.status).toBe(200);
    } finally {
      await broker.close();
    }
  });

  it('rejects a real operation with no token', async () => {
    const broker = await startTestBroker({ docker, config: { image: IMAGE, workspaceRoot } });
    try {
      const res = await fetch(`${broker.url}/v1/containers/nonexistent`);
      expect(res.status).toBe(401);
    } finally {
      await broker.close();
    }
  });

  it('rejects a real operation with the wrong token', async () => {
    const broker = await startTestBroker({ docker, config: { image: IMAGE, workspaceRoot } });
    try {
      const client = new RuntimeBrokerClient({ baseUrl: broker.url, token: 'wrong-token' });
      await expect(client.inspect('nonexistent')).rejects.toMatchObject({ statusCode: 401 });
    } finally {
      await broker.close();
    }
  });
});

describe('Runtime Broker — workspace container lifecycle', () => {
  it('creates, inspects, execs into, and destroys a workspace container end to end', async () => {
    await withBroker(async client => {
      const workspaceId = crypto.randomUUID();
      const created = await client.createWorkspaceContainer(workspaceId, { projectId: crypto.randomUUID(), limits: { cpuLimit: 1, memoryMb: 512 } });
      containerIds.push(created.containerId);
      expect(created.status).toBe('running');

      const info = await client.inspect(created.containerId);
      expect(info.running).toBe(true);
      expect(Object.keys(info.networks)).toHaveLength(1);
      expect(Object.keys(info.networks)[0]).toMatch(/^odc-ws-net-/);

      const exec = await client.exec(created.containerId, { cmd: ['echo', 'hello-from-broker'] });
      expect(exec.exitCode).toBe(0);
      expect(exec.output).toContain('hello-from-broker');

      await client.destroy(created.containerId, workspaceId);
      await expect(client.inspect(created.containerId)).rejects.toMatchObject({ statusCode: 404 });
      containerIds.splice(containerIds.indexOf(created.containerId), 1);
    });
  }, 45_000);

  it('create() is idempotent for the same workspaceId', async () => {
    await withBroker(async client => {
      const workspaceId = crypto.randomUUID();
      const input = { projectId: crypto.randomUUID(), limits: { cpuLimit: 1, memoryMb: 512 } };
      const first = await client.createWorkspaceContainer(workspaceId, input);
      containerIds.push(first.containerId);
      const second = await client.createWorkspaceContainer(workspaceId, input);
      expect(second.containerId).toBe(first.containerId);
    });
  }, 30_000);

  it('destroy() is idempotent', async () => {
    await withBroker(async client => {
      const workspaceId = crypto.randomUUID();
      const created = await client.createWorkspaceContainer(workspaceId, { projectId: crypto.randomUUID(), limits: { cpuLimit: 1, memoryMb: 512 } });
      await client.destroy(created.containerId, workspaceId);
      await expect(client.destroy(created.containerId, workspaceId)).resolves.toBeUndefined();
    });
  }, 30_000);

  it('two workspaces get distinct networks and cannot reach each other by IP (P0-3, through the broker)', async () => {
    await withBroker(async client => {
      const workspaceIdA = crypto.randomUUID();
      const workspaceIdB = crypto.randomUUID();
      const input = { projectId: crypto.randomUUID(), limits: { cpuLimit: 1, memoryMb: 512 } };
      const a = await client.createWorkspaceContainer(workspaceIdA, input);
      const b = await client.createWorkspaceContainer(workspaceIdB, input);
      containerIds.push(a.containerId, b.containerId);

      const infoA = await client.inspect(a.containerId);
      const infoB = await client.inspect(b.containerId);
      expect(Object.keys(infoA.networks)).not.toEqual(Object.keys(infoB.networks));

      await client.exec(b.containerId, { cmd: ['sh', '-c', 'nc -l -p 9000 &'] });
      await new Promise(r => setTimeout(r, 300));
      const bIp = Object.values(infoB.networks)[0]?.ipAddress;
      const probe = await client.exec(a.containerId, { cmd: ['nc', '-z', '-w', '2', bIp!, '9000'] });
      expect(probe.exitCode).not.toBe(0);
    });
  }, 45_000);

  it('clamps memory above the max down to 32768MB instead of applying it verbatim', async () => {
    await withBroker(async client => {
      const workspaceId = crypto.randomUUID();
      const created = await client.createWorkspaceContainer(workspaceId, { projectId: crypto.randomUUID(), limits: { cpuLimit: 1, memoryMb: 999_999 } });
      containerIds.push(created.containerId);
      const raw = await docker.getContainer(created.containerId).inspect();
      expect(raw.HostConfig.Memory).toBe(32768 * 1024 * 1024);
    });
  }, 30_000);

  // Requesting the app's 16-core ceiling only makes sense on a host that actually has 16+ cores —
  // Docker rejects the request outright otherwise (same constraint as workspace-engine's own
  // equivalent test, since the broker's clamp logic is identical).
  it.skipIf(hostCpus < 16)('clamps an above-maximum cpu request down to 16 cores instead of applying it verbatim', async () => {
    await withBroker(async client => {
      const workspaceId = crypto.randomUUID();
      const created = await client.createWorkspaceContainer(workspaceId, { projectId: crypto.randomUUID(), limits: { cpuLimit: 999, memoryMb: 512 } });
      containerIds.push(created.containerId);
      const raw = await docker.getContainer(created.containerId).inspect();
      expect(raw.HostConfig.NanoCpus).toBe(16 * 1_000_000_000);
    });
  }, 30_000);
});

describe('Runtime Broker — exec allowlist', () => {
  it('rejects an exec `user` outside the allowlist before ever touching Docker', async () => {
    await withBroker(async (client, broker) => {
      const workspaceId = crypto.randomUUID();
      const created = await client.createWorkspaceContainer(workspaceId, { projectId: crypto.randomUUID(), limits: { cpuLimit: 1, memoryMb: 512 } });
      containerIds.push(created.containerId);
      const res = await fetch(`${broker.url}/v1/containers/${created.containerId}/exec`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${broker.token}` },
        body: JSON.stringify({ cmd: ['id'], user: 'root' })
      });
      expect(res.status).toBe(400);
    });
  }, 30_000);

  it('has no request field for Privileged, CapAdd, arbitrary Binds, or an arbitrary network name — structurally, not just by convention', async () => {
    await withBroker(async (_client, broker) => {
      const workspaceId = crypto.randomUUID();
      const res = await fetch(`${broker.url}/v1/workspaces/${workspaceId}/container`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${broker.token}` },
        body: JSON.stringify({
          projectId: 'p1',
          limits: { cpuLimit: 1, memoryMb: 512 },
          // Extra fields a compromised caller might try to smuggle in — Zod's default (non-.strict())
          // parsing drops unknown keys rather than erroring, so this proves they're silently ignored
          // rather than accidentally honored.
          hostConfig: { Privileged: true, CapAdd: ['ALL'], Binds: ['/:/host'], NetworkMode: 'host' }
        })
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      containerIds.push(body.containerId);
      const raw = await docker.getContainer(body.containerId).inspect();
      expect(raw.HostConfig.Privileged).toBe(false);
      expect(raw.HostConfig.CapAdd).toBeFalsy();
      expect(raw.HostConfig.NetworkMode).not.toBe('host');
    });
  }, 30_000);
});

describe('Runtime Broker — interactive exec-tty (terminal-engine)', () => {
  it('relays a real interactive command end to end over the WebSocket', async () => {
    await withBroker(async client => {
      const workspaceId = crypto.randomUUID();
      const created = await client.createWorkspaceContainer(workspaceId, { projectId: crypto.randomUUID(), limits: { cpuLimit: 1, memoryMb: 512 } });
      containerIds.push(created.containerId);

      const session = client.execTty(created.containerId, { cmd: ['cat'], cols: 80, rows: 24 });
      const received: Buffer[] = [];
      session.onData(chunk => received.push(chunk));
      await new Promise(r => setTimeout(r, 400));
      session.write('ping-through-broker\n');
      await new Promise(r => setTimeout(r, 400));
      await session.close();

      const output = Buffer.concat(received).toString('utf8');
      expect(output).toContain('ping-through-broker');
    });
  }, 30_000);

  it('rejects the exec-tty WebSocket handshake without a valid token', async () => {
    await withBroker(async (client, broker) => {
      const workspaceId = crypto.randomUUID();
      const created = await client.createWorkspaceContainer(workspaceId, { projectId: crypto.randomUUID(), limits: { cpuLimit: 1, memoryMb: 512 } });
      containerIds.push(created.containerId);

      const wsUrl = `${broker.url.replace('http', 'ws')}/v1/containers/${created.containerId}/exec-tty`;
      const result = await new Promise<'open' | number>((resolve) => {
        const ws = new WebSocket(wsUrl); // no Authorization header
        ws.once('open', () => resolve('open'));
        ws.once('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
        ws.once('error', () => resolve(-1));
      });
      expect(result).not.toBe('open');
    });
  }, 30_000);
});

describe('Runtime Broker — maintenance', () => {
  it('prune-networks removes only orphaned workspace networks', async () => {
    await withBroker(async client => {
      const workspaceId = crypto.randomUUID();
      const created = await client.createWorkspaceContainer(workspaceId, { projectId: crypto.randomUUID(), limits: { cpuLimit: 1, memoryMb: 512 } });
      containerIds.push(created.containerId);
      // Simulate a crash between container removal and network cleanup.
      await docker.getContainer(created.containerId).remove({ force: true });
      containerIds.splice(containerIds.indexOf(created.containerId), 1);

      const { removed } = await client.pruneNetworks();
      expect(removed.length).toBeGreaterThan(0);
    });
  }, 30_000);
});
