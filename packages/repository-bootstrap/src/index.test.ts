import Docker from 'dockerode';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestBroker } from '@oliveira/runtime-broker/src/testHelpers.js';

// Real broker, real Docker, and a real git clone (from a local bare repo on the host, bind-mounted
// into the container read-only — avoids a network dependency on GitHub for this test). Consolidates
// what used to be two byte-for-byte duplicate files (apps/api and apps/worker each had their own
// repositoryBootstrap.ts), so this is also the first direct test coverage this logic has ever had.
const IMAGE = 'alpine:3.20';
const docker = new Docker({ socketPath: process.env.DOCKER_SOCKET ?? '/var/run/docker.sock' });

let broker: Awaited<ReturnType<typeof startTestBroker>>;
let containerId: string;
let bareRepoHostPath: string;

beforeAll(async () => {
  await new Promise<void>((resolve, reject) => {
    docker.pull(IMAGE, (err: unknown, stream: NodeJS.ReadableStream) => {
      if (err) return reject(err);
      docker.modem.followProgress(stream, (e: unknown) => (e ? reject(e) : resolve()));
    });
  });

  // A bare repo on the host, seeded via a throwaway container (this host may not have git
  // installed), then bind-mounted read-only into the container under test as the clone source.
  bareRepoHostPath = await fs.mkdtemp(path.join(os.tmpdir(), 'odc-bootstrap-remote-'));
  const seed = await docker.createContainer({ Image: IMAGE, Cmd: ['sleep', 'infinity'], HostConfig: { Binds: [`${bareRepoHostPath}:/remote`] } });
  await seed.start();
  const seedExec = async (cmd: string[], workingDir = '/remote') => {
    const ex = await seed.exec({ Cmd: cmd, WorkingDir: workingDir, AttachStdout: true, AttachStderr: true });
    const s = await ex.start({ hijack: true });
    await new Promise<void>((resolve, reject) => { s.on('end', resolve); s.on('error', reject); s.resume(); });
    return (await ex.inspect()).ExitCode ?? 1;
  };
  await seedExec(['apk', 'add', '--no-cache', 'git']);
  await seedExec(['sh', '-c', 'mkdir -p /tmp/work && cd /tmp/work && git init -b main -q && git config user.email devcloud@local && git config user.name Test && echo hello > README.md && git add -A && git commit -q -m seed && git clone --bare /tmp/work /remote/repo.git']);
  await seed.remove({ force: true });

  containerId = crypto.randomUUID();
  const workspace = await docker.createContainer({ Image: IMAGE, name: `odc-bootstrap-test-${containerId}`, Cmd: ['sleep', 'infinity'], HostConfig: { Binds: [`${bareRepoHostPath}:/remote:ro`] } });
  containerId = workspace.id;
  await workspace.start();
  const install = await workspace.exec({ Cmd: ['apk', 'add', '--no-cache', 'git'], AttachStdout: true, AttachStderr: true });
  const installStream = await install.start({ hijack: true });
  await new Promise<void>((resolve, reject) => { installStream.on('end', resolve); installStream.on('error', reject); installStream.resume(); });
  await workspace.exec({ Cmd: ['mkdir', '-p', '/workspace/repository'], AttachStdout: true, AttachStderr: true }).then(async e => {
    const s = await e.start({ hijack: true });
    await new Promise<void>(resolve => { s.on('end', resolve); s.resume(); });
  });

  broker = await startTestBroker({ docker });
}, 60_000);

afterAll(async () => {
  await broker?.close();
  if (containerId) await docker.getContainer(containerId).remove({ force: true }).catch(() => undefined);
  if (bareRepoHostPath) await fs.rm(bareRepoHostPath, { recursive: true, force: true }).catch(() => undefined);
}, 30_000);

describe('bootstrapRepository — real broker, real git clone', () => {
  it('clones the default branch into /workspace/repository', async () => {
    process.env.RUNTIME_BROKER_URL = broker.url;
    process.env.RUNTIME_BROKER_TOKEN = broker.token;
    const { bootstrapRepository } = await import('./index.js');

    await bootstrapRepository({ containerId, repositoryUrl: 'file:///remote/repo.git', defaultBranch: 'main' });

    const check = await docker.getContainer(containerId).exec({ Cmd: ['cat', '/workspace/repository/README.md'], AttachStdout: true, AttachStderr: true });
    const stream = await check.start({ hijack: true });
    let output = '';
    stream.on('data', (c: Buffer) => { output += c.toString('utf8'); });
    await new Promise<void>(resolve => { stream.on('end', resolve); });
    expect(output).toContain('hello');
  }, 30_000);

  it('rejects an unsafe branch name before ever touching Docker', async () => {
    process.env.RUNTIME_BROKER_URL = broker.url;
    process.env.RUNTIME_BROKER_TOKEN = broker.token;
    const { bootstrapRepository } = await import('./index.js');

    await expect(bootstrapRepository({ containerId, repositoryUrl: 'file:///remote/repo.git', defaultBranch: '$(rm -rf /)' })).rejects.toThrow('INVALID_BRANCH');
  });
});
