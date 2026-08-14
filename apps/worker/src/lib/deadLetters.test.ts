import { describe, expect, it, vi } from 'vitest';
import { recordPermanentJobFailure, sanitizedPermanentErrorCode } from './deadLetters.js';

describe('dead-letter persistence', () => {
  it('normalizes unsafe error text without persisting its contents', () => {
    expect(sanitizedPermanentErrorCode(new Error('token=super-secret'))).toBe('PERMANENT_JOB_FAILURE');
    expect(sanitizedPermanentErrorCode(new Error('WORKSPACE_HAS_NO_CONTAINER'))).toBe('WORKSPACE_HAS_NO_CONTAINER');
  });

  it('upserts only identifier payload and a sanitized code', async () => {
    const upsert = vi.fn(async (args: unknown) => args);
    await recordPermanentJobFailure({
      database: { deadLetterJob: { upsert } } as never,
      queue: 'ORCHESTRATION', organizationId: 'org-1', workspaceId: 'ws-1',
      sourceId: 'orch-1', sourceJobId: 'bull-1', payload: { orchestrationId: 'orch-1' },
      attempts: 5, error: new Error('token=super-secret')
    });
    const serialized = JSON.stringify(upsert.mock.calls[0]?.[0]);
    expect(serialized).toContain('PERMANENT_JOB_FAILURE');
    expect(serialized).toContain('orchestrationId');
    expect(serialized).not.toContain('super-secret');
  });
});
