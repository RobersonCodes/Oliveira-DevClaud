'use client';

import { useEffect, useRef, useState } from 'react';

type ConnectionState = 'online' | 'offline' | 'restored';

export function PwaLifecycle() {
  const [connection, setConnection] = useState<ConnectionState>('online');
  const wasOffline = useRef(false);

  useEffect(() => {
    let restoredTimer: ReturnType<typeof setTimeout> | undefined;
    const clearRestoredTimer = () => {
      if (!restoredTimer) return;
      clearTimeout(restoredTimer);
      restoredTimer = undefined;
    };

    const markOffline = () => {
      clearRestoredTimer();
      wasOffline.current = true;
      setConnection('offline');
    };
    const markOnline = () => {
      clearRestoredTimer();
      if (!wasOffline.current) {
        setConnection('online');
        return;
      }
      wasOffline.current = false;
      setConnection('restored');
      restoredTimer = setTimeout(() => setConnection('online'), 4_000);
    };

    if (!navigator.onLine) markOffline();
    window.addEventListener('offline', markOffline);
    window.addEventListener('online', markOnline);

    const registerServiceWorker = () => {
      if (process.env.NODE_ENV !== 'production' || !('serviceWorker' in navigator)) return;
      void navigator.serviceWorker.register('/sw.js', {
        scope: '/',
        updateViaCache: 'none'
      }).catch(() => undefined);
    };

    if (document.readyState === 'complete') registerServiceWorker();
    else window.addEventListener('load', registerServiceWorker, { once: true });

    return () => {
      window.removeEventListener('offline', markOffline);
      window.removeEventListener('online', markOnline);
      window.removeEventListener('load', registerServiceWorker);
      clearRestoredTimer();
    };
  }, []);

  if (connection === 'online') return null;

  return (
    <div className={`pwa-connection ${connection}`} role="status" aria-live="polite">
      <span aria-hidden="true" className="pwa-connection-dot" />
      <div>
        <strong>{connection === 'offline' ? 'Sem conexão' : 'Conexão restaurada'}</strong>
        <small>
          {connection === 'offline'
            ? 'Seu contexto continua nesta tela. Reconectaremos quando a rede voltar.'
            : 'A sessão continua disponível; você já pode retomar o trabalho.'}
        </small>
      </div>
      {connection === 'offline' && <button type="button" onClick={() => window.location.reload()}>Tentar novamente</button>}
    </div>
  );
}
