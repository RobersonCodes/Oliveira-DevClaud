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
  const exec = await container.exec({
    Cmd: input.cmd,
    WorkingDir: input.workingDir,
    User: input.user,
    Env: input.env,
    AttachStdout: true,
    AttachStderr: true
  });
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
  const timeoutMs = input.timeoutMs ?? 180_000;
  const timeout = new Promise<never>((_, reject) => {
    const t = setTimeout(() => reject(Object.assign(new Error('EXEC_TIMEOUT'), { statusCode: 504 })), timeoutMs);
    t.unref();
  });
  await Promise.race([ended, timeout]);

  const result = await exec.inspect();
  return { exitCode: result.ExitCode ?? 1, output };
}
