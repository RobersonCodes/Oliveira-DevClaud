'use client';

import { Suspense, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

type Port = { id: string; port: number; label?: string | null; protocol: string };

// code-server needs: allow-scripts (it's a full editor), allow-same-origin (so its own fetch/XHR/WS
// calls back to its real origin — ide-<id>.runtime.<domain>, never the panel's — carry the runtime
// cookie normally; safe specifically because that origin is already isolated from the panel),
// allow-forms + allow-modals (its own dialogs/inputs), allow-downloads (exporting files),
// allow-popups + allow-popups-to-escape-sandbox (opening links/terminals in a real, unsandboxed tab
// instead of a nested sandboxed one). No allow-top-navigation — the embedded IDE must never be able
// to navigate the panel itself out from under the user.
const IDE_IFRAME_SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-modals allow-downloads allow-popups allow-popups-to-escape-sandbox';

async function requestRuntimeTicket(workspaceId: string, purpose: 'ide' | 'preview', port?: number): Promise<string> {
  const res = await fetch(`${API}/api/v1/runtime-tickets`, {
    method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspaceId, purpose, port })
  });
  if (!res.ok) throw new Error('RUNTIME_TICKET_REQUEST_FAILED');
  const data = await res.json();
  return data.url as string;
}

export default function IdePage() {
  return <Suspense fallback={<div className="simple-page"><h1>IDE</h1></div>}><IdePageContent /></Suspense>;
}

function IdePageContent() {
  const params = useSearchParams();
  const workspaceId = params.get('workspaceId') ?? '';
  const [status, setStatus] = useState<'idle'|'starting'|'running'|'stopped'|'error'>('idle');
  const [ports, setPorts] = useState<Port[]>([]);
  const [port, setPort] = useState('3000');
  const [label, setLabel] = useState('App preview');
  const [message, setMessage] = useState('');
  const [ideUrl, setIdeUrl] = useState('');

  async function load() {
    if (!workspaceId) return;
    const [statusRes, portsRes] = await Promise.all([
      fetch(`${API}/api/v1/workspaces/${workspaceId}/ide/status`, { credentials: 'include' }),
      fetch(`${API}/api/v1/workspaces/${workspaceId}/ports`, { credentials: 'include' })
    ]);
    if (statusRes.ok) {
      const data = await statusRes.json();
      setStatus(data.status === 'running' ? 'running' : 'stopped');
    }
    if (portsRes.ok) setPorts(await portsRes.json());
  }

  useEffect(() => { void load(); }, [workspaceId]);

  // A fresh, short-lived bearer ticket is requested every time the IDE goes from not-running to
  // running. It remains replayable until its 60-second expiry, but is scoped to this runtime target.
  useEffect(() => {
    if (status !== 'running' || !workspaceId) { setIdeUrl(''); return; }
    let cancelled = false;
    requestRuntimeTicket(workspaceId, 'ide')
      .then(url => { if (!cancelled) setIdeUrl(url); })
      .catch(() => { if (!cancelled) { setStatus('error'); setMessage('Não foi possível autorizar o acesso à IDE.'); } });
    return () => { cancelled = true; };
  }, [status, workspaceId]);

  async function startIde() {
    setStatus('starting'); setMessage('');
    const res = await fetch(`${API}/api/v1/workspaces/${workspaceId}/ide/start`, { method: 'POST', credentials: 'include' });
    if (!res.ok) { setStatus('error'); setMessage('Não foi possível iniciar a IDE.'); return; }
    setStatus('running');
  }

  async function stopIde() {
    await fetch(`${API}/api/v1/workspaces/${workspaceId}/ide/stop`, { method: 'POST', credentials: 'include' });
    setStatus('stopped');
  }

  async function addPort() {
    const parsed = Number(port);
    const res = await fetch(`${API}/api/v1/workspaces/${workspaceId}/ports`, {
      method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ port: parsed, label })
    });
    if (!res.ok) { setMessage('Não foi possível registrar essa porta.'); return; }
    setMessage('Porta registrada.'); await load();
  }

  async function openPreview(previewPort: number) {
    try {
      const url = await requestRuntimeTicket(workspaceId, 'preview', previewPort);
      window.open(url, '_blank', 'noreferrer');
    } catch {
      setMessage('Não foi possível autorizar o acesso a esse preview.');
    }
  }

  if (!workspaceId) return <div className="simple-page"><h1>IDE</h1><p className="muted">Informe <code>?workspaceId=...</code> na URL.</p></div>;

  return <div className="ide-page">
    <header className="ide-header">
      <div><div className="eyebrow">OLIVEIRA DEVCLOUD · WEB IDE</div><h1>Workspace IDE</h1><p className="muted">{workspaceId}</p></div>
      <div className="ide-actions">
        {status !== 'running' ? <button onClick={startIde} disabled={status === 'starting'}>{status === 'starting' ? 'Iniciando…' : 'Abrir IDE'}</button> : <button className="ghost-btn" onClick={stopIde}>Parar IDE</button>}
      </div>
    </header>

    <section className="runtime-grid">
      <article><span>IDE</span><strong>{status}</strong><small>Runtime Gateway · origem isolada</small></article>
      <article><span>Porta interna</span><strong>13337</strong><small>não publicada no host</small></article>
      <article><span>Previews</span><strong>{ports.length}</strong><small>portas explicitamente registradas</small></article>
    </section>

    {message && <p className="message">{message}</p>}

    <section className="preview-manager">
      <div><h2>Application previews</h2><p className="muted">Registre a porta onde seu app está rodando, por exemplo 3000, 5173 ou 8080.</p></div>
      <div className="port-form"><input value={port} onChange={e=>setPort(e.target.value)} inputMode="numeric" placeholder="3000"/><input value={label} onChange={e=>setLabel(e.target.value)} placeholder="Nome do preview"/><button onClick={addPort}>Adicionar</button></div>
      <div className="preview-list">{ports.map(p => <button key={p.id} className="preview-link" onClick={() => openPreview(p.port)}><strong>{p.label || `Port ${p.port}`}</strong><span>:{p.port}</span></button>)}</div>
    </section>

    <section className="ide-frame-shell">
      <div className="ide-frame-bar"><span className={`status-dot ${status}`}></span><span>{status === 'running' ? 'IDE conectada ao workspace' : 'IDE parada'}</span></div>
      {status === 'running' && ideUrl
        ? <iframe className="ide-frame" src={ideUrl} title="Oliveira DevCloud IDE" allow="clipboard-read; clipboard-write" sandbox={IDE_IFRAME_SANDBOX} />
        : <div className="ide-empty"><strong>IDE offline</strong><p>Inicie o code-server para editar o repositório diretamente pelo navegador.</p></div>}
    </section>
  </div>;
}
