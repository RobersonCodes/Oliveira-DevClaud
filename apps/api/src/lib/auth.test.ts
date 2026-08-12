import { describe, expect, it } from 'vitest';
import { Role } from '@oliveira/database';
import { canAccess, hashPassword, hasRole, sessionCookieName, sessionCookieOptions, verifyPassword } from './auth.js';

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

  it('enforces the complete anonymous/member/tenant-role/host-admin matrix', () => {
    const actors = {
      anonymous: { authenticated: false },
      member: { authenticated: true },
      developer: { authenticated: true, organizationRole: Role.DEVELOPER },
      admin: { authenticated: true, organizationRole: Role.ADMIN },
      owner: { authenticated: true, organizationRole: Role.OWNER },
      hostAdmin: { authenticated: true, hostAdmin: true }
    } as const;
    const expected = {
      AUTHENTICATED: ['member', 'developer', 'admin', 'owner', 'hostAdmin'],
      DEVELOPER: ['developer', 'admin', 'owner'],
      ADMIN: ['admin', 'owner'],
      OWNER: ['owner'],
      HOST_ADMIN: ['hostAdmin']
    } as const;

    for (const [policy, allowed] of Object.entries(expected)) {
      for (const [name, actor] of Object.entries(actors)) {
        expect(canAccess(actor, policy as keyof typeof expected), `${name} -> ${policy}`).toBe(new Set<string>(allowed).has(name));
      }
    }
  });

  it('uses a browser-enforced __Host- cookie boundary in production', () => {
    const name = sessionCookieName('production');
    expect(name).toBe('__Host-odc_session');
    expect(sessionCookieOptions(name)).toMatchObject({ secure: true, path: '/', httpOnly: true, sameSite: 'lax' });
    expect(sessionCookieOptions(name)).not.toHaveProperty('domain');
  });
});
