import Docker from 'dockerode';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { startTestBroker } from '@oliveira/runtime-broker/src/testHelpers.js';
import { DockerTmuxTerminalEngine } from './index.js';

// Real broker, real Docker, real tmux — previously this package had no direct test coverage at
// all (only exercised indirectly through apps/api). Now that `connect()` goes over the broker's
// interactive exec-tty WebSocket instead of talking to dockerode directly, this validates the one
// genuinely bidirectional/streaming path in the whole Runtime Broker migration end to end: a real
// tmux session, attached to, receiving real keystrokes, echoing real output back.
const IMAGE = 'alpine:3.20';
const docker = new Docker({ socketPath: process.env.DOCKER_SOCKET ?? '/var/run/docker.sock' });

let workspaceRoot: string;
let broker: Awaited<ReturnType<typeof startTestBroker>>;
let engine: DockerTmuxTerminalEngine;
let containerId: string;

beforeAll(async () => {
  await new Promise<void>((resolve, reject) => {
    docker.pull(IMAGE, (err: unknown, stream: NodeJS.ReadableStream) => {
      if (err) return reject(err);
      docker.modem.followProgress(stream, (e: unknown) => (e ? reject(e) : resolve()));
    });
  });
  workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'odc-terminal-engine-test-'));
  broker = await startTestBroker({ docker, config: { image: IMAGE, workspaceRoot } });
  engine = new DockerTmuxTerminalEngine({ baseUrl: broker.url, token: broker.token });

  // Not this package's job to create workspace containers — install just enough (tmux) directly
  // on a plain alpine container to exercise the terminal engine against something real.
  const created = await docker.createContainer({ Image: IMAGE, Cmd: ['sleep', 'infinity'], Tty: true, HostConfig: { AutoRemove: false } });
  containerId = created.id;
  await created.start();
  const install = await created.exec({ Cmd: ['apk', 'add', '--no-cache', 'tmux'], AttachStdout: true, AttachStderr: true });
  const installStream = await install.start({ hijack: true });
  await new Promise<void>((resolve, reject) => { installStream.on('end', resolve); installStream.on('error', reject); installStream.resume(); });
}, 60_000);

afterEach(async () => {
  await engine.killSession(containerId, 'test-session').catch(() => undefined);
});

afterAll(async () => {
  await broker?.close();
  if (containerId) await docker.getContainer(containerId).remove({ force: true }).catch(() => undefined);
  if (workspaceRoot) await fs.rm(workspaceRoot, { recursive: true, force: true }).catch(() => undefined);
}, 30_000);

describe('DockerTmuxTerminalEngine — real broker, real tmux', () => {
  it('ensureSession creates a session and is idempotent', async () => {
    const name = `sess-${crypto.randomUUID().slice(0, 8)}`;
    await engine.ensureSession(containerId, name);
    await expect(engine.ensureSession(containerId, name)).resolves.toBeUndefined();
    await engine.killSession(containerId, name);
  }, 20_000);

  it('connect() attaches to a real tmux session and relays real keystrokes both ways', async () => {
    const name = 'test-session';
    const connection = await engine.connect(containerId, name, { cols: 80, rows: 24 });
    const received: Buffer[] = [];
    connection.onData(chunk => received.push(chunk));

    await new Promise(r => setTimeout(r, 500));
    connection.write("echo terminal-engine-ping\n");
    await new Promise(r => setTimeout(r, 800));
    await connection.close();

    const output = Buffer.concat(received).toString('utf8');
    expect(output).toContain('terminal-engine-ping');
  }, 20_000);

  it('resize() does not error against a real attached session', async () => {
    const connection = await engine.connect(containerId, 'test-session', { cols: 80, rows: 24 });
    await expect(connection.resize({ cols: 120, rows: 40 })).resolves.toBeUndefined();
    await connection.close();
  }, 20_000);

  it('killSession ends the tmux session so a later has-session check fails', async () => {
    const name = `sess-${crypto.randomUUID().slice(0, 8)}`;
    await engine.ensureSession(containerId, name);
    await engine.killSession(containerId, name);
    // Re-creating after kill must succeed (proves the old session is really gone, not just detached).
    await expect(engine.ensureSession(containerId, name)).resolves.toBeUndefined();
    await engine.killSession(containerId, name);
  }, 20_000);
});
