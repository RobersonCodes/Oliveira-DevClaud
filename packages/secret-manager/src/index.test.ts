import crypto from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret, maskSecret } from './index.js';

const originalMasterKey = process.env.SECRETS_MASTER_KEY_BASE64;

afterEach(() => {
  if (originalMasterKey === undefined) delete process.env.SECRETS_MASTER_KEY_BASE64;
  else process.env.SECRETS_MASTER_KEY_BASE64 = originalMasterKey;
});

describe('secret-manager', () => {
  it('encrypts and decrypts an AES-256-GCM envelope with authenticated metadata', () => {
    process.env.SECRETS_MASTER_KEY_BASE64 = crypto.randomBytes(32).toString('base64');

    const payload = encryptSecret('postgres://user:password@db/internal', 'project:abc:production');

    expect(payload.version).toBe(1);
    expect(payload.iv).not.toEqual('');
    expect(payload.tag).not.toEqual('');
    expect(payload.ciphertext).not.toContain('postgres://');
    expect(decryptSecret(payload, 'project:abc:production')).toBe('postgres://user:password@db/internal');
  });

  it('rejects a payload when its authenticated metadata does not match', () => {
    process.env.SECRETS_MASTER_KEY_BASE64 = crypto.randomBytes(32).toString('base64');
    const payload = encryptSecret('sensitive-value', 'workspace:one');

    expect(() => decryptSecret(payload, 'workspace:two')).toThrow();
  });

  it('masks short and long secret values without exposing their center', () => {
    expect(maskSecret('short')).toBe('••••••••');
    expect(maskSecret('abcdefghijklmnop')).toBe('abcd••••••••mnop');
  });
});
