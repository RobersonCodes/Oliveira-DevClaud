'use client';

import { useEffect, useRef, useState } from 'react';
import '@xterm/xterm/css/xterm.css';
import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

type TerminalSession = {
  id: string;
  workspaceId: string;
  title: string;
  tmuxName: string;
  active: boolean;
  cols: number;
  rows: number;
};

function TerminalCanvas({ session }: { session: TerminalSession }) {
  const host = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const socket = useRef<WebSocket | null>(null);
  const [state, setState] = useState<'connecting' | 'online' | 'offline'>('connecting');

  useEffect(() => {
    if (!host.current) return;
    let cancelled = false;
    let cleanup = () => {};

    // xterm/xterm-addon-fit ship UMD bundles that reference `self` at module-evaluation time,
    // so they must only be imported in the browser, never during Next.js server-side prerendering.
    Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')]).then(([{ Terminal }, { FitAddon }]) => {
      if (cancelled || !host.current) return;
      const xterm = new Terminal({
        cursorBlink: true,
        convertEol: true,
        fontSize: 14,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
        theme: { background: '#07090d', foreground: '#f4f7fb' },
        scrollback: 5000
      });
      const fit = new FitAddon();
      xterm.loadAddon(fit);
      xterm.open(host.current);
      fit.fit();
      terminal.current = xterm;

      const wsBase = API.replace(/^http/, 'ws');
      const ws = new WebSocket(`${wsBase}/api/v1/terminals/${session.id}/connect`);
      ws.binaryType = 'arraybuffer';
      socket.current = ws;

      ws.onopen = () => {
        setState('online');
        ws.send(JSON.stringify({ type: 'resize', cols: xterm.cols, rows: xterm.rows }));
        xterm.focus();
      };
      ws.onmessage = event => {
        if (typeof event.data === 'string') xterm.write(event.data);
        else xterm.write(new Uint8Array(event.data));
      };
      ws.onclose = () => {
        setState('offline');
        xterm.writeln('\r\n\x1b[33m[conexão destacada; a sessão tmux continua ativa]\x1b[0m');
      };
      ws.onerror = () => setState('offline');

      const input = xterm.onData(data => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'input', data }));
      });
      const resize = xterm.onResize(size => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'resize', ...size }));
      });
      const observer = new ResizeObserver(() => fit.fit());
      observer.observe(host.current);

      cleanup = () => {
        observer.disconnect();
        input.dispose();
        resize.dispose();
        ws.close();
        xterm.dispose();
        terminal.current = null;
        socket.current = null;
      };
    });

    return () => {
      cancelled = true;
      cleanup();
    };
  }, [session.id]);

  return <div className="terminal-shell"><div className="terminal-toolbar"><strong>{session.title}</strong><span className={`terminal-status ${state}`}>● {state}</span></div><div ref={host} className="terminal-canvas" /></div>;
}

export default function TerminalPage() {
  const [workspaceId, setWorkspaceId] = useState('');
  const [sessions, setSessions] = useState<TerminalSession[]>([]);
  const [selected, setSelected] = useState<TerminalSession | null>(null);
  const [message, setMessage] = useState('');

  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('workspaceId') ?? '';
    setWorkspaceId(id);
  }, []);

  useEffect(() => {
    if (!workspaceId) return;
    fetch(`${API}/api/v1/terminals?workspaceId=${encodeURIComponent(workspaceId)}`, { credentials: 'include' })
      .then(async r => r.ok ? r.json() : Promise.reject(await r.json()))
      .then((items: TerminalSession[]) => { setSessions(items); setSelected(items[0] ?? null); })
      .catch(() => setMessage('Não foi possível carregar os terminais deste workspace.'));
  }, [workspaceId]);

  async function createTerminal() {
    if (!workspaceId) { setMessage('Informe um workspaceId na URL.'); return; }
    setMessage('Criando sessão persistente...');
    const response = await fetch(`${API}/api/v1/terminals`, {
      method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId, title: `Terminal ${sessions.length + 1}`, cols: 120, rows: 34 })
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) { setMessage(body.error ?? 'Falha ao criar terminal.'); return; }
    setSessions(current => [...current, body]);
    setSelected(body);
    setMessage('');
  }

  async function closeTerminal(id: string) {
    await fetch(`${API}/api/v1/terminals/${id}`, { method: 'DELETE', credentials: 'include' });
    setSessions(current => current.filter(item => item.id !== id));
    if (selected?.id === id) setSelected(null);
  }

  return <main><aside><div className="brand">OLIVEIRA<br/><span>DEVCLOUD</span></div><nav><a href="/">Overview</a><br/><a href="/projects">Projects</a><br/><a href="/workspaces">Workspaces</a><br/>Agents<br/><b>Terminal</b><br/>Git<br/>Logs<br/>Settings</nav></aside><section className="content terminal-page"><header><div><p className="eyebrow">PERSISTENT RUNTIME</p><h1>Terminal v0.4</h1><p className="muted">WebSocket + xterm.js + Docker Exec + tmux</p></div><button onClick={createTerminal} disabled={!workspaceId || sessions.length >= 2}>+ Novo terminal</button></header>
  {!workspaceId && <div className="panel"><div><h2>Selecione um workspace</h2><p>Abra esta tela com <code>/terminal?workspaceId=...</code>. Na próxima versão o seletor será integrado ao dashboard.</p></div></div>}
  {workspaceId && <><div className="terminal-tabs">{sessions.map(item => <div key={item.id} className={selected?.id === item.id ? 'terminal-tab active' : 'terminal-tab'}><button onClick={() => setSelected(item)}>{item.title}</button><button className="terminal-close" onClick={() => closeTerminal(item.id)}>×</button></div>)}</div>{message && <p className="message">{message}</p>}{selected ? <TerminalCanvas key={selected.id} session={selected}/> : <div className="panel"><div><h2>Nenhum terminal ativo</h2><p>Crie até dois terminais por workspace. Fechar o navegador não encerra a sessão tmux.</p></div></div>}</>}
</section></main>;
}
