'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiJson } from '../../../lib/apiClient';

interface SessionDevice {
  id: string;
  userAgent: string | null;
  ipAddress: string | null;
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string;
  current: boolean;
}

function deviceName(userAgent: string | null) {
  if (!userAgent) return 'Dispositivo desconhecido';
  if (/mobile|android|iphone|ipad/i.test(userAgent)) return 'Dispositivo móvel';
  return 'Navegador desktop';
}

function dateTime(value: string) {
  return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

export default function SessionsPage() {
  const [sessions, setSessions] = useState<SessionDevice[]>([]);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setSessions(await apiJson<SessionDevice[]>('/api/v1/auth/sessions'));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Falha ao carregar sessões.');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function revoke(session: SessionDevice) {
    if (session.current && !window.confirm('Revogar esta sessão fará logout neste dispositivo. Continuar?')) return;
    setBusy(session.id);
    setMessage('');
    try {
      await apiJson(`/api/v1/auth/sessions/${session.id}`, { method: 'DELETE' });
      if (session.current) {
        window.location.href = '/login';
        return;
      }
      setMessage('Sessão revogada.');
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Falha ao revogar sessão.');
    } finally {
      setBusy(null);
    }
  }

  async function revokeOthers() {
    if (!window.confirm('Revogar todas as outras sessões?')) return;
    setBusy('others');
    setMessage('');
    try {
      const result = await apiJson<{ revoked: number }>('/api/v1/auth/sessions/others', { method: 'DELETE' });
      setMessage(`${result.revoked} outra(s) sessão(ões) revogada(s).`);
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Falha ao revogar outras sessões.');
    } finally {
      setBusy(null);
    }
  }

  return <main className="sessions-page">
    <header className="sessions-head">
      <div>
        <a className="back-link" href="/">← Voltar ao painel</a>
        <p className="eyebrow">SEGURANÇA DA CONTA</p>
        <h1>Sessões e dispositivos</h1>
        <p className="sub">Revise onde sua conta está conectada. A revogação bloqueia também os runtimes vinculados à sessão.</p>
      </div>
      <button className="danger" disabled={busy !== null || sessions.length < 2} onClick={revokeOthers}>Revogar outras</button>
    </header>
    {message && <p className="message">{message}</p>}
    <section className="session-list" aria-live="polite">
      {sessions.map(session => <article className="session-card" key={session.id}>
        <div>
          <div className="session-title">
            <strong>{deviceName(session.userAgent)}</strong>
            {session.current && <span>ATUAL</span>}
          </div>
          <p>{session.userAgent ?? 'User-Agent não informado'}</p>
          <dl>
            <div><dt>IP</dt><dd>{session.ipAddress ?? 'não informado'}</dd></div>
            <div><dt>Último uso</dt><dd>{dateTime(session.lastUsedAt)}</dd></div>
            <div><dt>Criada em</dt><dd>{dateTime(session.createdAt)}</dd></div>
            <div><dt>Expira em</dt><dd>{dateTime(session.expiresAt)}</dd></div>
          </dl>
        </div>
        <button className={session.current ? 'ghost-btn' : 'danger'} disabled={busy !== null} onClick={() => revoke(session)}>
          {busy === session.id ? 'Revogando…' : session.current ? 'Sair deste dispositivo' : 'Revogar'}
        </button>
      </article>)}
      {!sessions.length && !message && <p className="empty-copy">Carregando sessões…</p>}
    </section>
  </main>;
}
