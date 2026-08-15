import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const source = (relativePath: string) => readFile(new URL(relativePath, import.meta.url), 'utf8');

describe('security audit coverage', () => {
  it.each([
    ['./routes/auth.ts', 'USER_LOGOUT'],
    ['./routes/auth.ts', 'SESSION_REVOKED'],
    ['./routes/auth.ts', 'SESSIONS_OTHERS_REVOKED'],
    ['./routes/orchestrations.ts', 'ORCHESTRATION_STARTED'],
    ['./routes/setup.ts', 'WORKSPACE_PROVISION_CANCELLED'],
    ['./routes/setup.ts', 'WORKSPACE_PROVISION_CANCEL_REQUESTED'],
    ['./routes/setup.ts', 'WORKSPACE_PROVISION_RETRIED'],
    ['./routes/agents.ts', 'AGENT_STATUS_RECONCILED'],
    ['./routes/agents.ts', 'AGENT_CHANGES_MERGED'],
    ['./routes/agents.ts', 'AGENT_CHANGES_REJECTED'],
    ['./routes/dead-letters.ts', 'DEAD_LETTER_RESOLVED'],
    ['./routes/dead-letters.ts', 'DEAD_LETTER_REQUEUED'],
    ['./lib/runtimeGateway.ts', 'RUNTIME_TICKET_ISSUED']
  ])('keeps %s covered by %s', async (file, action) => {
    expect(await source(file)).toMatch(new RegExp(`action:\\s*['"]${action}['"]`));
  });

  it('never places credential material in runtime ticket audit metadata', async () => {
    const runtimeGateway = await source('./lib/runtimeGateway.ts');
    const auditBlock = runtimeGateway.split("action: 'RUNTIME_TICKET_ISSUED'")[1]?.split('});')[0];
    expect(auditBlock).toBeDefined();
    expect(auditBlock).not.toMatch(/token|ticket|cookie|sid/i);
  });
});
