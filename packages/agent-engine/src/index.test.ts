import Docker from 'dockerode';
import { PassThrough } from 'node:stream';
import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestBroker } from '@oliveira/runtime-broker/src/testHelpers.js';
import { DockerAgentEngine } from './index.js';

// Real broker, real Docker, real tmux — a fake `codex` binary stands in for the real CLI (not
// installed in this lightweight image; see HARDENING-ROADMAP P1-10) so start()/status()/logs()/
// cancel() can be exercised against something that actually runs, not just a CLI-missing error.
const IMAGE = 'alpine:3.20';
const docker = new Docker({ socketPath: process.env.DOCKER_SOCKET ?? '/var/run/docker.sock' });
let broker: Awaited<ReturnType<typeof startTestBroker>>;
let engine: DockerAgentEngine;
let containerId: string;

async function seedExec(cmd: string[]) {
  const container = docker.getContainer(containerId);
  const execution = await container.exec({ Cmd: cmd, AttachStdout: true, AttachStderr: true });
  const stream = await execution.start({ hijack: true });
  const combined = new PassThrough();
  docker.modem.demuxStream(stream, combined, combined);
  await new Promise<void>((resolve, reject) => { stream.on('end', resolve); stream.on('error', reject); stream.resume(); });
}

beforeAll(async () => {
  await new Promise<void>((resolve, reject) => {
    docker.pull(IMAGE, (err: unknown, stream: NodeJS.ReadableStream) => {
      if (err) return reject(err);
      docker.modem.followProgress(stream, (e: unknown) => (e ? reject(e) : resolve()));
    });
  });
  const c = await docker.createContainer({ Image: IMAGE, Cmd: ['sleep', 'infinity'] });
  containerId = c.id;
  await c.start();
  await seedExec(['apk', 'add', '--no-cache', 'tmux', 'bash']);
  // Fake `codex`/`claude`: echo the prompt they were given and exit 0 (claude just sleeps a bit
  // first so cancel() has something real to kill mid-flight) — real enough to exercise the whole
  // tmux + status-file + log-file flow that DockerAgentEngine actually implements.
  await seedExec(['sh', '-c', 'printf \'#!/bin/sh\\necho "codex saw: $ODC_AGENT_PROMPT"\\necho "codex args: $*"\\n\' > /usr/local/bin/codex && chmod +x /usr/local/bin/codex']);
  await seedExec(['sh', '-c', 'printf \'#!/bin/sh\\nsleep 30\\necho "claude saw: $ODC_AGENT_PROMPT"\\n\' > /usr/local/bin/claude && chmod +x /usr/local/bin/claude']);

  broker = await startTestBroker({ docker });
  engine = new DockerAgentEngine({ baseUrl: broker.url, token: broker.token });
}, 60_000);

afterAll(async () => {
  await broker?.close();
  if (containerId) await docker.getContainer(containerId).remove({ force: true }).catch(() => undefined);
}, 30_000);

describe('DockerAgentEngine — real broker, real tmux, fake CLI', () => {
  it('start() launches a real tmux session that runs the fake CLI to completion, and status()/logs() reflect it', async () => {
    const taskId = crypto.randomUUID();
    await engine.start({ containerId, taskId, agent: 'CODEX', prompt: 'hello-agent' });

    // The fake CLI exits almost instantly — poll status until it's no longer RUNNING.
    let status = await engine.status(containerId, taskId);
    const deadline = Date.now() + 10_000;
    while (status.status === 'RUNNING' && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 300));
      status = await engine.status(containerId, taskId);
    }
    expect(status.status).toBe('COMPLETED');
    expect(status.exitCode).toBe(0);

    const logs = await engine.logs(containerId, taskId);
    expect(logs).toContain('codex saw: hello-agent');
    expect(logs).toContain('codex args: exec --sandbox workspace-write --ask-for-approval never --skip-git-repo-check hello-agent');
  }, 30_000);

  it('cancel() kills a real running tmux session', async () => {
    const taskId = crypto.randomUUID();
    await engine.start({ containerId, taskId, agent: 'CLAUDE', prompt: 'long-lived' });
    await engine.cancel(containerId, taskId);
    const status = await engine.status(containerId, taskId);
    expect(status.status).not.toBe('RUNNING');
  }, 20_000);
});
