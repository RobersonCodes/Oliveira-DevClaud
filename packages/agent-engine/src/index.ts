import { RuntimeBrokerClient, type RuntimeBrokerClientOptions } from '@oliveira/runtime-broker-client';

export type AgentKind = 'CODEX' | 'CLAUDE';
export type AgentRuntimeStatus = 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'UNKNOWN';

export type StartAgentInput = {
  containerId: string;
  taskId: string;
  agent: AgentKind;
  prompt: string;
  workingDirectory?: string;
  maxDurationSeconds?: number;
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
  private readonly broker: RuntimeBrokerClient;

  constructor(opts?: RuntimeBrokerClientOptions) {
    this.broker = new RuntimeBrokerClient(opts);
  }

  private async exec(containerId: string, cmd: string[], env?: string[]) {
    return this.broker.exec(containerId, { cmd, env });
  }

  async start(input: StartAgentInput): Promise<AgentRuntime> {
    const id = safeTaskId(input.taskId);
    const sessionName = `odc-agent-${id}`.slice(0, 64);
    const statusFile = `/tmp/odc-agent-${id}.status`;
    const logFile = `/tmp/odc-agent-${id}.log`;
    const binary = input.agent === 'CODEX' ? 'codex' : 'claude';
    const args = input.agent === 'CODEX'
      ? ['exec', '--sandbox', 'workspace-write', '--ask-for-approval', 'never', '--skip-git-repo-check', '"$ODC_AGENT_PROMPT"']
      : ['-p', '"$ODC_AGENT_PROMPT"', '--permission-mode', 'acceptEdits'];

    const available = await this.exec(input.containerId, ['sh', '-lc', `command -v ${binary} >/dev/null 2>&1`]);
    if (available.exitCode !== 0) throw new Error(`${input.agent}_CLI_NOT_INSTALLED`);

    // User input is passed only through an environment variable. The shell program itself is fixed.
    // This avoids concatenating prompts into a command string while still allowing exit-code persistence.
    const command = [binary, ...args].join(' ');
    const maxDurationSeconds = Math.max(1, Math.min(input.maxDurationSeconds ?? 3600, 14_400));
    const agentCommand = `${command} 2>&1 | tee "$ODC_LOG_FILE"; exit \${PIPESTATUS[0]}`;
    // GNU timeout returns 124 after its TERM deadline; BusyBox returns the child's 143 instead.
    // This wrapper owns that TERM, so normalize both implementations to the persisted quota code.
    const wrapper = `rm -f "$ODC_STATUS_FILE" "$ODC_LOG_FILE"; timeout -s TERM -k 10s ${maxDurationSeconds}s bash -lc "$ODC_AGENT_COMMAND"; code=$?; if [ "$code" -eq 143 ] || [ "$code" -eq 137 ]; then code=124; fi; printf '%s' "$code" > "$ODC_STATUS_FILE"; exit "$code"`;

    const result = await this.exec(input.containerId, [
      'tmux', 'new-session', '-d', '-s', sessionName, '-c', input.workingDirectory ?? '/workspace/repository',
      'env', `ODC_AGENT_PROMPT=${input.prompt}`, `ODC_STATUS_FILE=${statusFile}`, `ODC_LOG_FILE=${logFile}`, `ODC_AGENT_COMMAND=${agentCommand}`,
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
