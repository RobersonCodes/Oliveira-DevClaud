import Docker from 'dockerode';
import { PassThrough } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestBroker } from '@oliveira/runtime-broker/src/testHelpers.js';

const IMAGE = 'alpine:3.20';
const docker = new Docker({ socketPath: process.env.DOCKER_SOCKET ?? '/var/run/docker.sock' });
let broker: Awaited<ReturnType<typeof startTestBroker>>;
let containerId: string;

async function seedExec(cmd: string[], workingDir = '/workspace/repository', user?: string) {
  const container = docker.getContainer(containerId);
  const execution = await container.exec({ Cmd: cmd, WorkingDir: workingDir, User: user, AttachStdout: true, AttachStderr: true });
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
  await seedExec(['sh', '-c', 'adduser -D devcloud && mkdir -p /workspace/repository && chown -R devcloud /workspace'], '/');
  await seedExec(['apk', 'add', '--no-cache', 'git']);
  // Real workspace containers run as `devcloud` by default (USER devcloud in the real image's
  // Dockerfile) — seeding as devcloud too avoids git's "dubious ownership" refusal when a later
  // read runs as a different UID than whoever created the repository.
  await seedExec(['sh', '-c', 'git init -b main -q && git config user.email a@b.c && git config user.name t && echo \'{"name":"t","dependencies":{"fastify":"1.0.0"}}\' > package.json && mkdir -p src && echo "export const x=1" > src/index.ts && git add -A && git commit -q -m init'], '/workspace/repository', 'devcloud');

  process.env.RUNTIME_BROKER_URL = (broker = await startTestBroker({ docker })).url;
  process.env.RUNTIME_BROKER_TOKEN = broker.token;
}, 60_000);

afterAll(async () => {
  await broker?.close();
  if (containerId) await docker.getContainer(containerId).remove({ force: true }).catch(() => undefined);
}, 30_000);

describe('repository-intelligence — real broker, real container', () => {
  it('inspectRepository reads real files through the broker and reports real git state', async () => {
    const { inspectRepository } = await import('./index.js');
    const result = await inspectRepository(containerId);
    expect(result.files).toContain('package.json');
    expect(result.files).toContain('src/index.ts');
    expect(result.dependencies).toContain('fastify');
    expect(result.git.clean).toBe(true);
    expect(result.git.branch).toBe('main');
  }, 20_000);
});
