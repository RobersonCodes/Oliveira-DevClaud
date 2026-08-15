import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { issueRuntimeTicket, verifyRuntimeTicket } from './runtimeTicket.js';

describe('runtimeTicket', () => {
  const identity = { uid: 'user_1', sid: 'session_1' };
  const previous = process.env.RUNTIME_TICKET_SECRET;
  beforeEach(() => { process.env.RUNTIME_TICKET_SECRET = 'test-secret-do-not-use-in-production'; });
  afterEach(() => { if (previous === undefined) delete process.env.RUNTIME_TICKET_SECRET; else process.env.RUNTIME_TICKET_SECRET = previous; });

  it('round-trips a valid ticket', () => {
    const ticket = issueRuntimeTicket({ ...identity, workspaceId: 'ws_1', purpose: 'ide' });
    const payload = verifyRuntimeTicket(ticket);
    expect(payload).not.toBeNull();
    expect(payload?.uid).toBe('user_1');
    expect(payload?.sid).toBe('session_1');
    expect(payload?.workspaceId).toBe('ws_1');
    expect(payload?.purpose).toBe('ide');
  });

  it('carries the port for preview tickets', () => {
    const ticket = issueRuntimeTicket({ ...identity, workspaceId: 'ws_1', purpose: 'preview', port: 5173 });
    expect(verifyRuntimeTicket(ticket)?.port).toBe(5173);
  });

  it('rejects a ticket signed with a different secret', () => {
    const ticket = issueRuntimeTicket({ ...identity, workspaceId: 'ws_1', purpose: 'ide' });
    process.env.RUNTIME_TICKET_SECRET = 'a-completely-different-secret';
    expect(verifyRuntimeTicket(ticket)).toBeNull();
  });

  it('rejects a ticket with a tampered payload (workspaceId swapped after signing)', () => {
    const ticket = issueRuntimeTicket({ ...identity, workspaceId: 'ws_1', purpose: 'ide' });
    const [payloadB64, signature] = ticket.split('.');
    const tamperedPayload = JSON.parse(Buffer.from(payloadB64!, 'base64url').toString('utf8'));
    tamperedPayload.workspaceId = 'ws_2';
    const tamperedB64 = Buffer.from(JSON.stringify(tamperedPayload)).toString('base64url');
    expect(verifyRuntimeTicket(`${tamperedB64}.${signature}`)).toBeNull();
  });

  it('rejects an expired ticket', () => {
    const ticket = issueRuntimeTicket({ ...identity, workspaceId: 'ws_1', purpose: 'ide' }, -1);
    expect(verifyRuntimeTicket(ticket)).toBeNull();
  });

  it('rejects malformed tickets', () => {
    expect(verifyRuntimeTicket('not-a-ticket')).toBeNull();
    expect(verifyRuntimeTicket('')).toBeNull();
    expect(verifyRuntimeTicket('a.b.c')).toBeNull();
    expect(verifyRuntimeTicket(`${Buffer.from('not json').toString('base64url')}.sig`)).toBeNull();
  });

  it('throws a clear, non-silent error when RUNTIME_TICKET_SECRET is not configured', () => {
    delete process.env.RUNTIME_TICKET_SECRET;
    expect(() => issueRuntimeTicket({ ...identity, workspaceId: 'ws_1', purpose: 'ide' })).toThrow('RUNTIME_TICKET_SECRET_NOT_CONFIGURED');
  });
});
