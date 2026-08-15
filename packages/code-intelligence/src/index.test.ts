import Docker from 'dockerode';
import { PassThrough } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestBroker } from '@oliveira/runtime-broker/src/testHelpers.js';

const IMAGE = 'alpine:3.20';
const docker = new Docker({ socketPath: process.env.DOCKER_SOCKET ?? '/var/run/docker.sock' });
let broker: Awaited<ReturnType<typeof startTestBroker>>;
let containerId: string;

async function seedExec(cmd: string[], workingDir = '/workspace/repository') {
  const container = docker.getContainer(containerId);
  const execution = await container.exec({ Cmd: cmd, WorkingDir: workingDir, AttachStdout: true, AttachStderr: true });
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
  await seedExec(['sh', '-c', "printf 'export function add(a,b) {\\n  return a+b;\\n}\\n' > math.ts"]);

  process.env.RUNTIME_BROKER_URL = (broker = await startTestBroker({ docker })).url;
  process.env.RUNTIME_BROKER_TOKEN = broker.token;
}, 60_000);

afterAll(async () => {
  await broker?.close();
  if (containerId) await docker.getContainer(containerId).remove({ force: true }).catch(() => undefined);
}, 30_000);

describe('code-intelligence — real broker, real container', () => {
  it('inspectCode reads a real file through the broker and extracts a real symbol', async () => {
    const { inspectCode } = await import('./index.js');
    const result = await inspectCode(containerId, ['math.ts']);
    expect(result.filesAnalyzed).toBe(1);
    expect(result.symbols.some(s => s.name === 'add' && s.kind === 'function')).toBe(true);
  }, 20_000);
});
