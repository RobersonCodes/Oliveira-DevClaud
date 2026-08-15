import type Docker from 'dockerode';
import { PassThrough } from 'node:stream';
import type { ExecRequestInput, ExecResult } from '@oliveira/runtime-broker-client';

const MAX_OUTPUT_BYTES = 2_000_000;

/**
 * The one exec implementation every migrated engine now shares (previously duplicated, nearly
 * verbatim, across 9+ files — see git-engine/setup-engine/review-engine/repository-intelligence/
 * code-intelligence/contract-intelligence/agent-engine/repositoryBootstrap). Runs a one-shot,
 * non-interactive command, demuxes stdout/stderr (Docker multiplexes them into one stream with an
 * 8-byte frame header when Tty is off — raw concatenation would corrupt anything parsed from the
 * output), and returns once the process exits or `timeoutMs` elapses.
 *
 * `user` is constrained by the caller's Zod schema (`ExecRequestSchema`) to the broker's own exec
 * allowlist — this function trusts that validation already happened and does not re-check it, since
 * it's also reused internally by ide-engine/terminal-engine helpers that don't go through the HTTP
 * schema.
 */
export async function execInContainer(docker: Docker, containerId: string, input: ExecRequestInput): Promise<ExecResult> {
  const container = docker.getContainer(containerId);
  const timeoutMs = input.timeoutMs ?? 180_000;
  const timeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1000));
  const exec = await container.exec({
    // The in-container watchdog kills the actual command as well as timing out this HTTP request.
    // A Promise.race alone would return 504 while leaving clone/install/test processes running.
    Cmd: ['timeout', '-s', 'TERM', '-k', '2s', `${timeoutSeconds}s`, ...input.cmd],
    WorkingDir: input.workingDir,
    User: input.user,
    Env: input.env,
    AttachStdout: true,
    AttachStderr: true
  });
  const watchdogStartedAt = Date.now();
  const stream = await exec.start({ hijack: true, stdin: false });

  let output = '';
  const combined = new PassThrough();
  combined.on('data', (chunk: Buffer) => {
    if (output.length < MAX_OUTPUT_BYTES) output += chunk.toString('utf8');
  });
  docker.modem.demuxStream(stream, combined, combined);

  const ended = new Promise<void>((resolve, reject) => {
    stream.on('end', resolve);
    stream.on('close', resolve);
    stream.on('error', reject);
  });
  let timeoutHandle: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => reject(Object.assign(new Error('EXEC_TIMEOUT'), { statusCode: 504 })), timeoutMs + 3_000);
    timeoutHandle.unref();
  });
  try {
    await Promise.race([ended, timeout]);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }

  const result = await exec.inspect();
  const watchdogElapsedMs = Date.now() - watchdogStartedAt;
  // GNU coreutils reports an expired TERM watchdog as 124, while Alpine/BusyBox reports the
  // terminated child's 143. Only classify BusyBox's 143 after the rounded watchdog duration has
  // actually elapsed so a command that deliberately exits 143 immediately keeps its real status.
  const busyBoxTimeout = result.ExitCode === 143 && watchdogElapsedMs + 50 >= timeoutSeconds * 1000;
  if (result.ExitCode === 124 || result.ExitCode === 137 || busyBoxTimeout) {
    throw Object.assign(new Error('EXEC_TIMEOUT'), { statusCode: 504 });
  }
  return { exitCode: result.ExitCode ?? 1, output };
}
