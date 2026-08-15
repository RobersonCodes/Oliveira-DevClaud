/**
 * Structured audit log for every Docker operation the broker performs — stdout JSON lines, meant to
 * be picked up by whatever log pipeline the host already has. Deliberately never includes exec
 * `cmd` arguments or `output`: both can carry secrets (e.g. a GitHub token embedded in a git clone
 * command's `-c http.extraHeader=...` argument) or repository source, neither of which belongs in
 * an infrastructure log. `cmd0` (just the binary name, e.g. "git"/"npm"/"tmux") is safe and useful
 * for at-a-glance observability without that risk.
 */
export type AuditEvent = {
  op: string;
  containerId?: string;
  workspaceId?: string;
  cmd0?: string;
  exitCode?: number;
  success: boolean;
  durationMs: number;
  error?: string;
};

export function auditLog(event: AuditEvent): void {
  process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), type: 'runtime-broker-audit', ...event })}\n`);
}

export async function withAudit<T>(op: string, meta: Omit<AuditEvent, 'op' | 'success' | 'durationMs'>, fn: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  try {
    const result = await fn();
    auditLog({ op, ...meta, success: true, durationMs: Date.now() - startedAt });
    return result;
  } catch (err) {
    auditLog({ op, ...meta, success: false, durationMs: Date.now() - startedAt, error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}
