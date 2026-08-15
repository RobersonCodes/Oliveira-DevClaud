export type TerminalTouchKey = {
  id: string;
  label: string;
  ariaLabel: string;
  sequence?: string;
  modifier?: 'ctrl';
};

export const TERMINAL_TOUCH_KEYS: readonly TerminalTouchKey[] = [
  { id: 'escape', label: 'Esc', ariaLabel: 'Escape', sequence: '\x1b' },
  { id: 'ctrl', label: 'Ctrl', ariaLabel: 'Control, próxima tecla', modifier: 'ctrl' },
  { id: 'tab', label: 'Tab', ariaLabel: 'Tabulação', sequence: '\t' },
  { id: 'arrow-up', label: '↑', ariaLabel: 'Seta para cima', sequence: '\x1b[A' },
  { id: 'arrow-down', label: '↓', ariaLabel: 'Seta para baixo', sequence: '\x1b[B' },
  { id: 'arrow-left', label: '←', ariaLabel: 'Seta para esquerda', sequence: '\x1b[D' },
  { id: 'arrow-right', label: '→', ariaLabel: 'Seta para direita', sequence: '\x1b[C' },
  { id: 'ctrl-c', label: 'C', ariaLabel: 'Letra C, combine com Control para interromper', sequence: 'c' },
  { id: 'slash', label: '/', ariaLabel: 'Barra', sequence: '/' },
  { id: 'dash', label: '-', ariaLabel: 'Hífen', sequence: '-' },
  { id: 'pipe', label: '|', ariaLabel: 'Barra vertical', sequence: '|' },
  { id: 'tilde', label: '~', ariaLabel: 'Til', sequence: '~' }
];

export function applyCtrlModifier(data: string) {
  if (data.length !== 1) return data;
  if (data === '?') return '\x7f';

  const code = data.toUpperCase().charCodeAt(0);
  return code >= 64 && code <= 95 ? String.fromCharCode(code & 31) : data;
}
