import Docker from 'dockerode';
import { PassThrough } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestBroker } from '@oliveira/runtime-broker/src/testHelpers.js';
import { DockerReviewEngine } from './index.js';

// Real broker, real Docker, real git — previously untested directly.
const IMAGE = 'alpine:3.20';
const docker = new Docker({ socketPath: process.env.DOCKER_SOCKET ?? '/var/run/docker.sock' });
let broker: Awaited<ReturnType<typeof startTestBroker>>;
let review: DockerReviewEngine;
let containerId: string;

async function exec(cmd: string[], workingDir = '/workspace/repository') {
  const container = docker.getContainer(containerId);
  const execution = await container.exec({ Cmd: cmd, WorkingDir: workingDir, AttachStdout: true, AttachStderr: true });
  const stream = await execution.start({ hijack: true });
  const chunks: Buffer[] = [];
  const combined = new PassThrough();
  combined.on('data', (c: Buffer) => chunks.push(c));
  docker.modem.demuxStream(stream, combined, combined);
  await new Promise<void>((resolve, reject) => { stream.on('end', resolve); stream.on('error', reject); });
  const result = await execution.inspect();
  return { exitCode: result.ExitCode ?? 1, output: Buffer.concat(chunks).toString('utf8') };
}

beforeAll(async () => {
  await new Promise<void>((resolve, reject) => {
    docker.pull(IMAGE, (err: unknown, stream: NodeJS.ReadableStream) => {
      if (err) return reject(err);
      docker.modem.followProgress(stream, (e: unknown) => (e ? reject(e) : resolve()));
    });
  });
  const container = await docker.createContainer({ Image: IMAGE, Cmd: ['sleep', 'infinity'], Tty: false });
  containerId = container.id;
  await container.start();
  await exec(['mkdir', '-p', '/workspace/repository', '/workspace/reviews'], '/');
  await exec(['apk', 'add', '--no-cache', 'git'], '/');
  await exec(['git', 'init', '-b', 'main']);
  await exec(['git', 'config', 'user.email', 'devcloud@local']);
  await exec(['git', 'config', 'user.name', 'Oliveira DevCloud']);
  await exec(['sh', '-c', 'echo base > README.md']);
  await exec(['git', 'add', '-A']);
  await exec(['git', 'commit', '-m', 'initial commit']);
  await exec(['git', 'checkout', '-b', 'agent/codex/task-1']);
  await exec(['sh', '-c', 'echo agent-work > feature.txt']);
  await exec(['git', 'add', '-A']);
  await exec(['git', 'commit', '-m', 'agent work']);
  await exec(['git', 'checkout', 'main']);

  broker = await startTestBroker({ docker });
  review = new DockerReviewEngine({ baseUrl: broker.url, token: broker.token });
}, 60_000);

afterAll(async () => {
  await broker?.close();
  if (containerId) await docker.getContainer(containerId).stop({ t: 1 }).catch(() => undefined).then(() => docker.getContainer(containerId).remove({ force: true }).catch(() => undefined));
}, 30_000);

describe('DockerReviewEngine — real broker, real git', () => {
  it('prepare() merges an agent branch into a fresh review worktree and reports it ready', async () => {
    const prep = await review.prepare(containerId, 'orch-1', [{ taskId: 'task-1', branchName: 'agent/codex/task-1' }], []);
    expect(prep.ready).toBe(true);
    expect(prep.mergedBranches).toEqual(['agent/codex/task-1']);
    expect(prep.conflicts).toEqual([]);

    const file = await exec(['cat', 'feature.txt'], prep.reviewPath);
    expect(file.output.trim()).toBe('agent-work');
  }, 30_000);

  it('approve() merges the review branch into main and cleans up', async () => {
    const head = await exec(['git', 'rev-parse', 'HEAD']);
    const baseCommit = head.output.trim();
    await review.prepare(containerId, 'orch-2', [{ taskId: 'task-1', branchName: 'agent/codex/task-1' }], []);

    const approved = await review.approve(containerId, 'orch-2', baseCommit);
    expect(approved.mergeCommit).toMatch(/^[0-9a-f]{40}$/);

    const mainFile = await exec(['cat', 'feature.txt']);
    expect(mainFile.output.trim()).toBe('agent-work');
  }, 30_000);
});
