import Docker from 'dockerode';
import { PassThrough } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestBroker } from '@oliveira/runtime-broker/src/testHelpers.js';
import { DockerGitIsolationEngine } from './index.js';

// Real Docker + a real git repository + a real broker — no mocking of dockerode or of git itself.
// Requires a reachable Docker daemon; DOCKER_SOCKET must point at the platform-appropriate endpoint
// (Unix socket in CI/Linux, e.g. `//./pipe/docker_engine` when developing directly on Windows). The
// test's own `exec()` helper below (seeding git state, asserting on repo contents) talks to Docker
// directly — that's just scaffolding, not the thing under test — while `git` itself is backed by a
// real broker instance, exactly how apps/api/apps/worker use it in production.
const IMAGE = 'alpine:3.20';
const docker = new Docker({ socketPath: process.env.DOCKER_SOCKET ?? '/var/run/docker.sock' });
let broker: Awaited<ReturnType<typeof startTestBroker>>;
let git: DockerGitIsolationEngine;

let containerId: string;

async function exec(cmd: string[], workingDir = '/workspace/repository') {
  const container = docker.getContainer(containerId);
  const execution = await container.exec({ Cmd: cmd, WorkingDir: workingDir, AttachStdout: true, AttachStderr: true });
  const stream = await execution.start({ hijack: true });
  // Same demuxing requirement as DockerGitIsolationEngine's own exec() — see its comment.
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
  broker = await startTestBroker({ docker });
  git = new DockerGitIsolationEngine({ baseUrl: broker.url, token: broker.token });
  await exec(['mkdir', '-p', '/workspace/repository', '/workspace/worktrees'], '/');
  await exec(['apk', 'add', '--no-cache', 'git'], '/');
  await exec(['git', 'init']);
  await exec(['git', 'config', 'user.email', 'devcloud@local']);
  await exec(['git', 'config', 'user.name', 'Oliveira DevCloud']);
  await exec(['sh', '-c', 'echo hello > README.md']);
  await exec(['git', 'add', '-A']);
  await exec(['git', 'commit', '-m', 'initial commit']);
}, 60_000);

afterAll(async () => {
  await broker?.close();
  if (!containerId) return;
  const container = docker.getContainer(containerId);
  // Short grace period — this is a disposable `sleep infinity` container, no need to wait out the
  // default ~10s SIGTERM window (which was blowing past vitest's default 10s hook timeout in CI).
  await container.stop({ t: 1 }).catch(() => undefined);
  await container.remove({ force: true }).catch(() => undefined);
}, 30_000);

describe('DockerGitIsolationEngine — real container, real git', () => {
  it('ensureRepository resolves for an initialized repo', async () => {
    await expect(git.ensureRepository(containerId)).resolves.toBeUndefined();
  });

  it('rejects unsafe task ids and unknown agents before touching git', async () => {
    await expect(git.createWorktree(containerId, '../etc/passwd', 'codex')).rejects.toThrow('INVALID_TASK_ID');
    await expect(git.createWorktree(containerId, 'task-1', 'gpt5')).rejects.toThrow('INVALID_AGENT');
  });

  it('creates an isolated worktree on its own branch, reviews the diff, snapshots, merges, and cleans up', async () => {
    const worktree = await git.createWorktree(containerId, 'task-full-cycle', 'codex');
    expect(worktree.branchName).toBe('agent/codex/task-full-cycle');
    expect(worktree.path).toBe('/workspace/worktrees/task-full-cycle');
    expect(worktree.baseCommit).toMatch(/^[0-9a-f]{40}$/);

    // Simulate the agent writing a file without committing — snapshot() must pick it up.
    await exec(['sh', '-c', 'echo "agent work" > feature.txt'], worktree.path);
    const snap = await git.snapshot(containerId, worktree, 'task-full-cycle');
    expect(snap.committed).toBe(true);

    // A second snapshot with nothing new to commit must be a no-op, not an error.
    const noop = await git.snapshot(containerId, worktree, 'task-full-cycle');
    expect(noop.committed).toBe(false);

    const diff = await git.review(containerId, worktree);
    expect(diff.files).toContain('feature.txt');

    const changes = await git.diffNameStatus(containerId, worktree.path, worktree.baseCommit);
    expect(changes).toContainEqual({ status: 'ADDED', path: 'feature.txt' });

    const merged = await git.merge(containerId, worktree, 'task-full-cycle');
    expect(merged.mergeCommit).toMatch(/^[0-9a-f]{40}$/);
    const mainFile = await exec(['cat', 'feature.txt']);
    expect(mainFile.output.trim()).toBe('agent work');

    await git.cleanup(containerId, worktree, true);
    const worktreeList = await exec(['git', 'worktree', 'list']);
    expect(worktreeList.output).not.toContain('task-full-cycle');
    const branchList = await exec(['git', 'branch', '--list', worktree.branchName]);
    expect(branchList.output.trim()).toBe('');
  });

  it('refuses to create a second worktree for the same agent+task branch', async () => {
    const first = await git.createWorktree(containerId, 'task-dup', 'claude');
    await expect(git.createWorktree(containerId, 'task-dup', 'claude')).rejects.toThrow('AGENT_BRANCH_ALREADY_EXISTS');
    await git.cleanup(containerId, first, true);
  });

  it('merge refuses when the main worktree has uncommitted changes', async () => {
    const worktree = await git.createWorktree(containerId, 'task-dirty-main', 'codex');
    await exec(['sh', '-c', 'echo dirty > untracked.txt'], '/workspace/repository');
    await expect(git.merge(containerId, worktree, 'task-dirty-main')).rejects.toThrow('MAIN_WORKTREE_DIRTY');
    await exec(['rm', 'untracked.txt'], '/workspace/repository');
    await git.cleanup(containerId, worktree, true);
  });
});
