import { describe, expect, it } from 'vitest';
import { Role } from '@oliveira/database';
import { hashPassword, hasRole, verifyPassword } from './auth.js';

describe('auth primitives', () => {
  it('hashes credentials with bcrypt and verifies only the original password', async () => {
    const password = 'Correct-Horse-Battery-Staple-2026';
    const hash = await hashPassword(password);

    expect(hash).not.toBe(password);
    expect(await verifyPassword(password, hash)).toBe(true);
    expect(await verifyPassword('incorrect-password', hash)).toBe(false);
  });

  it('enforces the organization role hierarchy', () => {
    expect(hasRole(Role.OWNER, Role.ADMIN)).toBe(true);
    expect(hasRole(Role.ADMIN, Role.DEVELOPER)).toBe(true);
    expect(hasRole(Role.DEVELOPER, Role.DEVELOPER)).toBe(true);
    expect(hasRole(Role.DEVELOPER, Role.ADMIN)).toBe(false);
    expect(hasRole(Role.ADMIN, Role.OWNER)).toBe(false);
  });
});
