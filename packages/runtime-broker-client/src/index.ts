import WebSocket from 'ws';
import type {
  CreateWorkspaceContainerInput,
  ContainerInspectResult,
  ExecRequestInput,
  ExecResult,
  WorkspaceContainerResult
} from './contract.js';

export * from './contract.js';

export class RuntimeBrokerError extends Error {
  statusCode: number;
  constructor(message: string, statusCode: number) {
    super(message);
    this.name = 'RuntimeBrokerError';
    this.statusCode = statusCode;
  }
}

export type RuntimeBrokerClientOptions = { baseUrl?: string; token?: string; fetchImpl?: typeof fetch };

export type TerminalSize = { cols: number; rows: number };

/**
 * Live bidirectional TTY session over the broker's `/v1/containers/:id/exec-tty` WebSocket —
 * binary frames are raw stdin/stdout bytes; JSON frames are control messages (currently only
 * `resize`). This is the one operation in the whole client that cannot be a simple request/response
 * call, because a real terminal is inherently a long-lived duplex stream.
 */
export class TtyExecSession {
  private ws: WebSocket;
  private dataHandlers: Array<(chunk: Buffer) => void> = [];
  private closeHandlers: Array<() => void> = [];
  private ready: Promise<void>;

  constructor(wsBaseUrl: string, token: string, containerId: string, opts: { cmd: string[]; workingDir?: string; cols: number; rows: number }) {
    const url = `${wsBaseUrl.replace(/\/$/, '')}/v1/containers/${encodeURIComponent(containerId)}/exec-tty`;
    this.ws = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } });
    this.ws.binaryType = 'nodebuffer';
    this.ready = new Promise((resolve, reject) => {
      this.ws.once('open', () => {
        this.ws.send(JSON.stringify({ type: 'start', cmd: opts.cmd, workingDir: opts.workingDir, cols: opts.cols, rows: opts.rows }));
        resolve();
      });
      this.ws.once('error', reject);
    });
    this.ws.on('message', (data: Buffer, isBinary: boolean) => {
      if (isBinary) for (const handler of this.dataHandlers) handler(data);
    });
    this.ws.on('close', () => { for (const handler of this.closeHandlers) handler(); });
  }

  write(data: string): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(Buffer.from(data, 'utf8'));
  }

  async resize(size: TerminalSize): Promise<void> {
    await this.ready;
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'resize', cols: size.cols, rows: size.rows }));
  }

  async close(): Promise<void> {
    await this.ready.catch(() => undefined);
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) this.ws.close();
  }

  onData(handler: (chunk: Buffer) => void): void { this.dataHandlers.push(handler); }
  onClose(handler: () => void): void { this.closeHandlers.push(handler); }
}

export class RuntimeBrokerClient {
  private baseUrl: string;
  private token: string;
  private fetchImpl: typeof fetch;

  constructor(opts: RuntimeBrokerClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? process.env.RUNTIME_BROKER_URL ?? 'http://runtime-broker:5001').replace(/\/$/, '');
    this.token = opts.token ?? process.env.RUNTIME_BROKER_TOKEN ?? '';
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.token}` };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let message = text || `RUNTIME_BROKER_HTTP_${res.status}`;
      try { const parsed = JSON.parse(text); message = parsed.error ?? message; } catch { /* not JSON */ }
      throw new RuntimeBrokerError(message, res.status);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  async createWorkspaceContainer(workspaceId: string, input: CreateWorkspaceContainerInput): Promise<WorkspaceContainerResult> {
    return this.request('POST', `/v1/workspaces/${encodeURIComponent(workspaceId)}/container`, input);
  }

  async inspect(containerId: string): Promise<ContainerInspectResult> {
    return this.request('GET', `/v1/containers/${encodeURIComponent(containerId)}`);
  }

  async start(containerId: string): Promise<void> {
    await this.request('POST', `/v1/containers/${encodeURIComponent(containerId)}/start`);
  }

  async stop(containerId: string, timeoutSeconds = 10): Promise<void> {
    await this.request('POST', `/v1/containers/${encodeURIComponent(containerId)}/stop`, { timeoutSeconds });
  }

  async restart(containerId: string, timeoutSeconds = 10): Promise<void> {
    await this.request('POST', `/v1/containers/${encodeURIComponent(containerId)}/restart`, { timeoutSeconds });
  }

  async destroy(containerId: string, workspaceId?: string): Promise<void> {
    const qs = workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : '';
    await this.request('DELETE', `/v1/containers/${encodeURIComponent(containerId)}${qs}`);
  }

  async exec(containerId: string, input: ExecRequestInput): Promise<ExecResult> {
    return this.request('POST', `/v1/containers/${encodeURIComponent(containerId)}/exec`, input);
  }

  async pruneNetworks(): Promise<{ removed: string[] }> {
    return this.request('POST', '/v1/maintenance/prune-networks');
  }

  execTty(containerId: string, opts: { cmd: string[]; workingDir?: string; cols: number; rows: number }): TtyExecSession {
    const wsBaseUrl = this.baseUrl.replace(/^http/, 'ws');
    return new TtyExecSession(wsBaseUrl, this.token, containerId, opts);
  }
}
