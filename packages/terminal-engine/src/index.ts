import Docker from 'dockerode';
import { PassThrough } from 'node:stream';

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

export class DockerTmuxTerminalEngine implements TerminalEngine {
  private readonly docker: Docker;

  constructor(socketPath = process.env.DOCKER_SOCKET ?? '/var/run/docker.sock') {
    this.docker = new Docker({ socketPath });
  }

  private async exec(containerId: string, cmd: string[]) {
    const container = this.docker.getContainer(containerId);
    const exec = await container.exec({ Cmd: cmd, AttachStdout: true, AttachStderr: true });
    const stream = await exec.start({ hijack: true });
    await new Promise<void>((resolve, reject) => {
      stream.on('end', resolve);
      stream.on('error', reject);
      stream.resume();
    });
    const result = await exec.inspect();
    return result.ExitCode ?? 1;
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
    const container = this.docker.getContainer(containerId);
    const exec = await container.exec({
      Cmd: ['tmux', 'attach-session', '-t', name],
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: true
    });
    const stream = await exec.start({ hijack: true, stdin: true, Tty: true });
    await exec.resize({ w: Math.max(20, Math.min(size.cols, 300)), h: Math.max(5, Math.min(size.rows, 120)) });

    const output = new PassThrough();
    stream.pipe(output);

    return {
      write(data) { stream.write(data); },
      async resize(next) { await exec.resize({ w: Math.max(20, Math.min(next.cols, 300)), h: Math.max(5, Math.min(next.rows, 120)) }); },
      async close() { stream.end(); },
      onData(handler) { output.on('data', handler); },
      onClose(handler) { stream.on('close', handler); stream.on('end', handler); }
    };
  }

  async killSession(containerId: string, rawName: string) {
    const name = safeTmuxName(rawName);
    await this.exec(containerId, ['tmux', 'kill-session', '-t', name]);
  }
}
