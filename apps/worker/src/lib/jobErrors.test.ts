import { describe, expect, it } from 'vitest';
import { UnrecoverableError } from 'bullmq';
import { asBullMqJobError, isPermanentJobError, jobErrorCode } from './jobErrors.js';

describe('BullMQ job error classification', () => {
  it.each([
    'WORKSPACE_HAS_NO_CONTAINER',
    'INVALID_BRANCH',
    'WORKSPACE_REPOSITORY_NOT_INITIALIZED'
  ])('marks invariant error %s as permanent', code => {
    const classified = asBullMqJobError(new Error(code));
    expect(classified).toBeInstanceOf(UnrecoverableError);
    expect(classified.message).toBe(code);
    expect(isPermanentJobError(classified)).toBe(true);
  });

  it.each(['ECONNRESET', 'ETIMEDOUT', 'REPOSITORY_BOOTSTRAP_FAILED'])('keeps transient error %s retryable', code => {
    const original = new Error(code);
    expect(asBullMqJobError(original)).toBe(original);
    expect(isPermanentJobError(original)).toBe(false);
  });

  it('normalizes non-Error rejections without exposing their value', () => {
    expect(asBullMqJobError({ token: 'must-not-leak' }).message).toBe('JOB_FAILED');
  });

  it('extracts a stable code from a qualified error', () => {
    expect(jobErrorCode(new Error('INVALID_BRANCH:main branch'))).toBe('INVALID_BRANCH');
  });
});
