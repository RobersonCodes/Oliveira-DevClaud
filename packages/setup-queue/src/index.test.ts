import { describe, expect, it } from 'vitest';
import { SETUP_PROVISION_JOB_OPTIONS, setupProvisionJobId } from './index.js';

describe('setup provision retry policy', () => {
  it('uses a slower exponential backoff for expensive external operations', () => {
    expect(SETUP_PROVISION_JOB_OPTIONS).toMatchObject({
      attempts: 3,
      backoff: { type: 'exponential', delay: 5_000, jitter: 0.25 },
      removeOnComplete: 100,
      removeOnFail: 500
    });
  });

  it('uses the persistent SetupJob id as the idempotency key', () => {
    expect(setupProvisionJobId('setup-123')).toBe('setup-123');
    expect(setupProvisionJobId('setup-123')).toBe(setupProvisionJobId('setup-123'));
    expect(setupProvisionJobId('setup-456')).not.toBe(setupProvisionJobId('setup-123'));
  });
});
