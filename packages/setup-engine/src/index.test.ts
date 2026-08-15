import Docker from 'dockerode';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestBroker } from '@oliveira/runtime-broker/src/testHelpers.js';

// Real broker + real Docker — previously untested directly. Validates that detectProject/
// installDependencies (both pure exec wrappers, no dockerode of their own since the Fase 4
// migration) actually reach a real container through the broker, not just that they compile.
const IMAGE = 'alpine:3.20';
const docker = new Docker({ socketPath: process.env.DOCKER_SOCKET ?? '/var/run/docker.sock' });

let broker: Awaited<ReturnType<typeof startTestBroker>>;
let containerId: string;

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
  const mk = await c.exec({ Cmd: ['sh', '-c', 'adduser -D devcloud 2>/dev/null; mkdir -p /workspace/repository && chown -R devcloud /workspace'], AttachStdout: true, AttachStderr: true });
  const s = await mk.start({ hijack: true });
  await new Promise<void>(resolve => { s.on('end', resolve); s.resume(); });

  process.env.RUNTIME_BROKER_URL = (broker = await startTestBroker({ docker })).url;
  process.env.RUNTIME_BROKER_TOKEN = broker.token;
}, 60_000);

afterAll(async () => {
  await broker?.close();
  if (containerId) await docker.getContainer(containerId).remove({ force: true }).catch(() => undefined);
}, 30_000);

describe('setup-engine — real broker, real container', () => {
  it('detectProject reports UNKNOWN for an empty repository', async () => {
    const { detectProject } = await import('./index.js');
    const result = await detectProject(containerId);
    expect(result.stack).toBe('UNKNOWN');
  }, 20_000);

  it('detectProject identifies a Node project from a real package.json and installDependencies actually runs npm', async () => {
    const { detectProject, installDependencies } = await import('./index.js');
    const container = docker.getContainer(containerId);
    const write = await container.exec({ Cmd: ['sh', '-c', 'echo \'{"name":"t","scripts":{"dev":"x"}}\' > /workspace/repository/package.json'], User: 'devcloud', AttachStdout: true, AttachStderr: true });
    const s = await write.start({ hijack: true });
    await new Promise<void>(resolve => { s.on('end', resolve); s.resume(); });

    const result = await detectProject(containerId);
    expect(result.stack).toBe('NODE');
    expect(result.installCommand).toEqual(['npm', 'install']);

    // This alpine image doesn't have npm installed — installDependencies() throws on a nonzero
    // exit code, so a real "npm: not found" failure (not a silent no-op) is exactly what proves
    // the broker actually reached a real container and ran the real command.
    await expect(installDependencies(containerId, result)).rejects.toMatchObject({ statusCode: 422 });
  }, 20_000);
});
