import { RuntimeBrokerClient, type RuntimeBrokerClientOptions } from '@oliveira/runtime-broker-client';

export type TerminalSize = { cols: number; rows: number };
export type TerminalConnection = {
  write(data: string): void;
  resize(size: TerminalSize): Promise<void>;
  close(): Promise<void>;
  onData(handler: (chunk: Buffer) => void): void;
  onClose(handler: () => void): void;
};

export interface TerminalEngine {
  ensureSession(containerId: string, tmuxName: string): Promise<void>;
  connect(containerId: string, tmuxName: string, size: TerminalSize): Promise<TerminalConnection>;
  killSession(containerId: string, tmuxName: string): Promise<void>;
}

const safeTmuxName = (value: string) => {
  if (!/^[a-zA-Z0-9_.-]{1,64}$/.test(value)) throw new Error('INVALID_TMUX_NAME');
  return value;
};

const clampSize = (size: TerminalSize) => ({
  cols: Math.max(20, Math.min(size.cols, 300)),
  rows: Math.max(5, Math.min(size.rows, 120))
});

export class DockerTmuxTerminalEngine implements TerminalEngine {
  private readonly broker: RuntimeBrokerClient;

  constructor(opts?: RuntimeBrokerClientOptions) {
    this.broker = new RuntimeBrokerClient(opts);
  }

  private async exec(containerId: string, cmd: string[]): Promise<number> {
    const result = await this.broker.exec(containerId, { cmd });
    return result.exitCode;
  }

  async ensureSession(containerId: string, rawName: string) {
    const name = safeTmuxName(rawName);
    const code = await this.exec(containerId, ['tmux', 'has-session', '-t', name]);
    if (code === 0) return;
    const create = await this.exec(containerId, ['tmux', 'new-session', '-d', '-s', name, '-c', '/workspace/repository']);
    if (create !== 0) throw new Error('TMUX_SESSION_CREATE_FAILED');
  }

  async connect(containerId: string, rawName: string, size: TerminalSize): Promise<TerminalConnection> {
    const name = safeTmuxName(rawName);
    await this.ensureSession(containerId, name);
    const { cols, rows } = clampSize(size);
    const session = this.broker.execTty(containerId, { cmd: ['tmux', 'attach-session', '-t', name], cols, rows });

    return {
      write(data) { session.write(data); },
      async resize(next) { await session.resize(clampSize(next)); },
      async close() { await session.close(); },
      onData(handler) { session.onData(handler); },
      onClose(handler) { session.onClose(handler); }
    };
  }

  async killSession(containerId: string, rawName: string) {
    const name = safeTmuxName(rawName);
    await this.exec(containerId, ['tmux', 'kill-session', '-t', name]);
  }
}
