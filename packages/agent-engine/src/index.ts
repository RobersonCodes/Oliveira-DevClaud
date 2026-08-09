import Docker from 'dockerode';
import { PassThrough } from 'node:stream';

export type AgentKind = 'CODEX' | 'CLAUDE';
export type AgentRuntimeStatus = 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'UNKNOWN';

export type StartAgentInput = {
  containerId: string;
  taskId: string;
  agent: AgentKind;
  prompt: string;
  workingDirectory?: string;
};

export type AgentRuntime = {
  sessionName: string;
  statusFile: string;
};

const safeTaskId = (value: string) => {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw new Error('INVALID_AGENT_TASK_ID');
  return value;
};

export class DockerAgentEngine {
  private readonly docker: Docker;

  constructor(socketPath = process.env.DOCKER_SOCKET ?? '/var/run/docker.sock') {
    this.docker = new Docker({ socketPath });
  }

  private async exec(containerId: string, cmd: string[], env?: string[]) {
    const container = this.docker.getContainer(containerId);
    const execution = await container.exec({ Cmd: cmd, Env: env, AttachStdout: true, AttachStderr: true });
    const stream = await execution.start({ hijack: true });
    // Without a TTY, Docker multiplexes stdout/stderr into one stream, prefixing every frame with
    // an 8-byte header (stream type + length) — raw `data` events include those header bytes
    // verbatim, corrupting status codes/log output parsed from it. demuxStream splits the frames.
    const chunks: Buffer[] = [];
    const combined = new PassThrough();
    combined.on('data', (chunk: Buffer) => chunks.push(chunk));
    this.docker.modem.demuxStream(stream, combined, combined);
    await new Promise<void>((resolve, reject) => {
      stream.on('end', resolve);
      stream.on('close', resolve);
      stream.on('error', reject);
    });
    const result = await execution.inspect();
    return { exitCode: result.ExitCode ?? 1, output: Buffer.concat(chunks).toString('utf8') };
  }

  async start(input: StartAgentInput): Promise<AgentRuntime> {
    const id = safeTaskId(input.taskId);
    const sessionName = `odc-agent-${id}`.slice(0, 64);
    const statusFile = `/tmp/odc-agent-${id}.status`;
    const logFile = `/tmp/odc-agent-${id}.log`;
    const binary = input.agent === 'CODEX' ? 'codex' : 'claude';
    const args = input.agent === 'CODEX'
      ? ['exec', '--full-auto', '--skip-git-repo-check', '"$ODC_AGENT_PROMPT"']
      : ['-p', '"$ODC_AGENT_PROMPT"', '--permission-mode', 'acceptEdits'];

    const available = await this.exec(input.containerId, ['sh', '-lc', `command -v ${binary} >/dev/null 2>&1`]);
    if (available.exitCode !== 0) throw new Error(`${input.agent}_CLI_NOT_INSTALLED`);

    // User input is passed only through an environment variable. The shell program itself is fixed.
    // This avoids concatenating prompts into a command string while still allowing exit-code persistence.
    const command = [binary, ...args].join(' ');
    const wrapper = `rm -f "$ODC_STATUS_FILE" "$ODC_LOG_FILE"; ${command} 2>&1 | tee "$ODC_LOG_FILE"; code=\${PIPESTATUS[0]}; printf '%s' "$code" > "$ODC_STATUS_FILE"; exit "$code"`;

    const result = await this.exec(input.containerId, [
      'tmux', 'new-session', '-d', '-s', sessionName, '-c', input.workingDirectory ?? '/workspace/repository',
      'env', `ODC_AGENT_PROMPT=${input.prompt}`, `ODC_STATUS_FILE=${statusFile}`, `ODC_LOG_FILE=${logFile}`,
      'bash', '-lc', wrapper
    ]);
    if (result.exitCode !== 0) throw new Error('AGENT_START_FAILED');
    return { sessionName, statusFile };
  }

  async status(containerId: string, taskId: string): Promise<{ status: AgentRuntimeStatus; exitCode?: number }> {
    const id = safeTaskId(taskId);
    const sessionName = `odc-agent-${id}`.slice(0, 64);
    const statusFile = `/tmp/odc-agent-${id}.status`;
    const live = await this.exec(containerId, ['tmux', 'has-session', '-t', sessionName]);
    if (live.exitCode === 0) return { status: 'RUNNING' };
    const result = await this.exec(containerId, ['sh', '-lc', 'test -f "$ODC_STATUS_FILE" && cat "$ODC_STATUS_FILE"'], [`ODC_STATUS_FILE=${statusFile}`]);
    if (result.exitCode !== 0 || !result.output.trim()) return { status: 'UNKNOWN' };
    const exitCode = Number.parseInt(result.output.replace(/[^0-9-]/g, '').trim(), 10);
    if (!Number.isFinite(exitCode)) return { status: 'UNKNOWN' };
    return { status: exitCode === 0 ? 'COMPLETED' : 'FAILED', exitCode };
  }

  async logs(containerId: string, taskId: string, lines = 300) {
    const id = safeTaskId(taskId);
    const sessionName = `odc-agent-${id}`.slice(0, 64);
    const logFile = `/tmp/odc-agent-${id}.log`;
    const safeLines = Math.max(20, Math.min(lines, 2000));
    const live = await this.exec(containerId, ['tmux', 'capture-pane', '-p', '-S', `-${safeLines}`, '-t', sessionName]);
    if (live.exitCode === 0 && live.output.trim()) return live.output;
    const saved = await this.exec(containerId, ['tail', '-n', String(safeLines), logFile]);
    return saved.exitCode === 0 ? saved.output : '';
  }

  async cancel(containerId: string, taskId: string) {
    const id = safeTaskId(taskId);
    const sessionName = `odc-agent-${id}`.slice(0, 64);
    await this.exec(containerId, ['tmux', 'kill-session', '-t', sessionName]);
  }
}
