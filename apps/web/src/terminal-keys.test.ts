import { describe, expect, it } from 'vitest';
import { applyCtrlModifier, TERMINAL_TOUCH_KEYS } from '../lib/terminalKeys';

describe('mobile terminal toolbar', () => {
  it('exposes escape, ctrl, tab, arrows and useful shell symbols', () => {
    expect(TERMINAL_TOUCH_KEYS.map(key => key.label)).toEqual([
      'Esc', 'Ctrl', 'Tab', '↑', '↓', '←', '→', 'C', '/', '-', '|', '~'
    ]);
    expect(TERMINAL_TOUCH_KEYS.find(key => key.id === 'escape')?.sequence).toBe('\x1b');
    expect(TERMINAL_TOUCH_KEYS.find(key => key.id === 'tab')?.sequence).toBe('\t');
    expect(TERMINAL_TOUCH_KEYS.find(key => key.id === 'arrow-up')?.sequence).toBe('\x1b[A');
  });

  it('turns a one-shot Ctrl plus C into the terminal interrupt sequence', () => {
    expect(applyCtrlModifier('c')).toBe('\x03');
    expect(applyCtrlModifier('C')).toBe('\x03');
    expect(applyCtrlModifier('@')).toBe('\x00');
    expect(applyCtrlModifier('?')).toBe('\x7f');
  });

  it('does not corrupt pasted or pre-encoded terminal input', () => {
    expect(applyCtrlModifier('echo ok')).toBe('echo ok');
    expect(applyCtrlModifier('\x1b[A')).toBe('\x1b[A');
  });
});
