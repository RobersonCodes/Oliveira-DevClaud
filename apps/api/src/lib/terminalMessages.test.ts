import { describe, expect, it } from 'vitest';
import { parseTerminalClientMessage } from './terminalMessages.js';

describe('terminal WebSocket client messages', () => {
  it('parses a text frame delivered by ws as a Buffer instead of writing its JSON envelope', () => {
    const raw = Buffer.from(JSON.stringify({ type: 'input', data: '\x03' }));
    expect(parseTerminalClientMessage(raw, false)).toEqual({ type: 'input', data: '\x03' });
  });

  it('parses resize envelopes from fragmented text data', () => {
    const raw = [Buffer.from('{"type":"resize","cols":80,'), Buffer.from('"rows":24}')];
    expect(parseTerminalClientMessage(raw, false)).toEqual({ type: 'resize', cols: 80, rows: 24 });
  });

  it('preserves binary and legacy plain-text input as terminal data', () => {
    expect(parseTerminalClientMessage(Buffer.from('echo ok\r'), true)).toEqual({ type: 'input', data: 'echo ok\r' });
    expect(parseTerminalClientMessage(Buffer.from('pwd\r'), false)).toEqual({ type: 'input', data: 'pwd\r' });
  });

  it('rejects malformed or out-of-range control envelopes', () => {
    expect(() => parseTerminalClientMessage(Buffer.from('{"type":"resize","cols":10,"rows":24}'), false)).toThrow();
    expect(() => parseTerminalClientMessage(Buffer.from('{"type":"unknown"}'), false)).toThrow();
  });
});
