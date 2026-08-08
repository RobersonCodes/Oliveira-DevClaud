import crypto from 'node:crypto';

const VERSION = 1;
const ALG = 'aes-256-gcm';
const IV_BYTES = 12;

function masterKey(): Buffer {
  const raw = process.env.SECRETS_MASTER_KEY_BASE64;
  if (!raw) throw new Error('SECRETS_MASTER_KEY_BASE64 is required');
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error('SECRETS_MASTER_KEY_BASE64 must decode to exactly 32 bytes');
  return key;
}

export type EncryptedSecret = { version: number; iv: string; tag: string; ciphertext: string };

export function encryptSecret(plaintext: string, aad: string): EncryptedSecret {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALG, masterKey(), iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { version: VERSION, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') };
}

export function decryptSecret(payload: EncryptedSecret, aad: string): string {
  if (payload.version !== VERSION) throw new Error('Unsupported secret envelope version');
  const decipher = crypto.createDecipheriv(ALG, masterKey(), Buffer.from(payload.iv, 'base64'));
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
  const clear = Buffer.concat([decipher.update(Buffer.from(payload.ciphertext, 'base64')), decipher.final()]);
  return clear.toString('utf8');
}

export function maskSecret(value: string): string {
  if (value.length <= 8) return '••••••••';
  return `${value.slice(0, 4)}••••••••${value.slice(-4)}`;
}
