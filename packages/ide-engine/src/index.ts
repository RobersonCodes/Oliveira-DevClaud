import Docker from 'dockerode';
import { WORKSPACE_NETWORK_NAME_PREFIX } from '@oliveira/workspace-engine';

export const IDE_PORT = 13337;

export type IdeRuntime = {
  running: boolean;
  host: string;
  port: number;
};

export class DockerIdeEngine {
  private docker: Docker;
  constructor(socketPath = process.env.DOCKER_SOCKET ?? '/var/run/docker.sock') {
    this.docker = new Docker({ socketPath });
  }

  private container(containerId: string) { return this.docker.getContainer(containerId); }

  async internalHost(containerId: string): Promise<string> {
    const info = await this.container(containerId).inspect();
    const networks = info.NetworkSettings.Networks ?? {};
    // Each workspace container is attached to exactly one dedicated network (see
    // workspace-engine/src/network.ts) — that name is preferred defensively in case more than one
    // network is ever present, but any attached network's address is a correct fallback since a
    // workspace container never joins another workspace's network.
    const dedicated = Object.entries(networks).find(([name]) => name.startsWith(WORKSPACE_NETWORK_NAME_PREFIX))?.[1]?.IPAddress;
    const ip = dedicated || Object.values(networks).map(n => n.IPAddress).find(Boolean) || info.NetworkSettings.IPAddress;
    if (!ip) throw Object.assign(new Error('WORKSPACE_NETWORK_ADDRESS_UNAVAILABLE'), { statusCode: 503 });
    return ip;
  }

  async isRunning(containerId: string): Promise<boolean> {
    const container = this.container(containerId);
    const info = await container.inspect();
    if (!info.State.Running) return false;
    const exec = await container.exec({
      Cmd: ['sh', '-lc', `pgrep -f "code-server.*--bind-addr 0.0.0.0:${IDE_PORT}" >/dev/null`],
      AttachStdout: true,
      AttachStderr: true
    });
    const stream = await exec.start({ hijack: true, stdin: false });
    await new Promise<void>((resolve, reject) => {
      stream.on('end', resolve); stream.on('error', reject); stream.resume();
    });
    const result = await exec.inspect();
    return result.ExitCode === 0;
  }

  async start(containerId: string): Promise<IdeRuntime> {
    const container = this.container(containerId);
    const info = await container.inspect();
    if (!info.State.Running) throw Object.assign(new Error('WORKSPACE_NOT_RUNNING'), { statusCode: 409 });

    if (!(await this.isRunning(containerId))) {
      const exec = await container.exec({
        Cmd: [
          'sh', '-lc',
          `nohup code-server --bind-addr 0.0.0.0:${IDE_PORT} --auth none --disable-telemetry /workspace/repository >/workspace/code-server.log 2>&1 &`
        ],
        WorkingDir: '/workspace/repository',
        User: 'devcloud',
        AttachStdout: true,
        AttachStderr: true
      });
      const stream = await exec.start({ hijack: true, stdin: false });
      await new Promise<void>((resolve, reject) => { stream.on('end', resolve); stream.on('error', reject); stream.resume(); });

      const deadline = Date.now() + 12_000;
      while (Date.now() < deadline) {
        if (await this.isRunning(containerId)) break;
        await new Promise(r => setTimeout(r, 350));
      }
      if (!(await this.isRunning(containerId))) throw Object.assign(new Error('IDE_START_FAILED'), { statusCode: 502 });
    }

    return { running: true, host: await this.internalHost(containerId), port: IDE_PORT };
  }

  async stop(containerId: string): Promise<void> {
    const container = this.container(containerId);
    const exec = await container.exec({
      Cmd: ['sh', '-lc', `pkill -f "code-server.*--bind-addr 0.0.0.0:${IDE_PORT}" || true`],
      User: 'devcloud', AttachStdout: true, AttachStderr: true
    });
    const stream = await exec.start({ hijack: true, stdin: false });
    await new Promise<void>((resolve, reject) => { stream.on('end', resolve); stream.on('error', reject); stream.resume(); });
  }

  async status(containerId: string): Promise<IdeRuntime> {
    return { running: await this.isRunning(containerId), host: await this.internalHost(containerId), port: IDE_PORT };
  }
}
