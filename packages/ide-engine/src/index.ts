import { RuntimeBrokerClient, WORKSPACE_NETWORK_NAME_PREFIX, type RuntimeBrokerClientOptions } from '@oliveira/runtime-broker-client';

export const IDE_PORT = 13337;

export type IdeRuntime = {
  running: boolean;
  host: string;
  port: number;
};

export class DockerIdeEngine {
  private broker: RuntimeBrokerClient;

  constructor(opts?: RuntimeBrokerClientOptions) {
    this.broker = new RuntimeBrokerClient(opts);
  }

  async internalHost(containerId: string): Promise<string> {
    const info = await this.broker.inspect(containerId);
    // Each workspace container is attached to exactly one dedicated network (see
    // apps/runtime-broker/src/network.ts) — that name is preferred defensively in case more than
    // one network is ever present, but any attached network's address is a correct fallback since a
    // workspace container never joins another workspace's network.
    const dedicated = Object.entries(info.networks).find(([name]) => name.startsWith(WORKSPACE_NETWORK_NAME_PREFIX))?.[1]?.ipAddress;
    const ip = dedicated || Object.values(info.networks).map(n => n.ipAddress).find(Boolean);
    if (!ip) throw Object.assign(new Error('WORKSPACE_NETWORK_ADDRESS_UNAVAILABLE'), { statusCode: 503 });
    return ip;
  }

  async isRunning(containerId: string, timeoutMs?: number): Promise<boolean> {
    const info = await this.broker.inspect(containerId);
    if (!info.running) return false;
    const result = await this.broker.exec(containerId, { cmd: ['sh', '-lc', `pgrep -f "code-server.*--bind-addr 0.0.0.0:${IDE_PORT}" >/dev/null`], timeoutMs });
    return result.exitCode === 0;
  }

  async start(containerId: string, opts?: { timeoutMs?: number }): Promise<IdeRuntime> {
    const deadline = Date.now() + Math.min(opts?.timeoutMs ?? 12_000, 12_000);
    const remaining = () => {
      const timeoutMs = deadline - Date.now();
      if (timeoutMs <= 0) throw Object.assign(new Error('SETUP_DURATION_EXCEEDED'), { statusCode: 504 });
      return timeoutMs;
    };
    const info = await this.broker.inspect(containerId);
    if (!info.running) throw Object.assign(new Error('WORKSPACE_NOT_RUNNING'), { statusCode: 409 });

    if (!(await this.isRunning(containerId, remaining()))) {
      await this.broker.exec(containerId, {
        cmd: ['sh', '-lc', `nohup code-server --bind-addr 0.0.0.0:${IDE_PORT} --auth none --disable-telemetry /workspace/repository >/workspace/code-server.log 2>&1 &`],
        workingDir: '/workspace/repository',
        user: 'devcloud',
        timeoutMs: remaining()
      });

      while (Date.now() < deadline) {
        if (await this.isRunning(containerId, remaining())) break;
        await new Promise(r => setTimeout(r, 350));
      }
      if (!(await this.isRunning(containerId, remaining()))) throw Object.assign(new Error('IDE_START_FAILED'), { statusCode: 502 });
    }

    return { running: true, host: await this.internalHost(containerId), port: IDE_PORT };
  }

  async stop(containerId: string): Promise<void> {
    await this.broker.exec(containerId, { cmd: ['sh', '-lc', `pkill -f "code-server.*--bind-addr 0.0.0.0:${IDE_PORT}" || true`], user: 'devcloud' });
  }

  async status(containerId: string): Promise<IdeRuntime> {
    return { running: await this.isRunning(containerId), host: await this.internalHost(containerId), port: IDE_PORT };
  }
}
