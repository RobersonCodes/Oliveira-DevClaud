'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useRef, useState } from 'react';

type NavigationItem = {
  href: string;
  label: string;
  shortLabel?: string;
  icon: string;
};

export const primaryNavigation: readonly NavigationItem[] = [
  { href: '/', label: 'Visão geral', shortLabel: 'Início', icon: '⌂' },
  { href: '/projects', label: 'Projetos', icon: '◇' },
  { href: '/agents', label: 'Agentes', icon: '✦' },
  { href: '/terminal', label: 'Terminal', icon: '>_' }
];

export const secondaryNavigation: readonly NavigationItem[] = [
  { href: '/workspaces', label: 'Workspaces', icon: '□' },
  { href: '/orchestrations', label: 'Orquestrações', icon: '◎' },
  { href: '/ide', label: 'Browser IDE', icon: '</>' },
  { href: '/onboarding', label: 'Novo workspace', icon: '+' },
  { href: '/import', label: 'Importar GitHub', icon: '↙' },
  { href: '/command-center', label: 'AI Command Center', icon: '✣' },
  { href: '/repository-map', label: 'Repository Map', icon: '⌘' },
  { href: '/code-intelligence', label: 'Code Intelligence', icon: '{}' },
  { href: '/contract-intelligence', label: 'Contract Intelligence', icon: '⇄' },
  { href: '/settings/secrets', label: 'Secrets', icon: '◈' },
  { href: '/settings/sessions', label: 'Sessões', icon: '◉' }
];

function isCurrentRoute(pathname: string, href: string) {
  return href === '/' ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);
}

export function MobileNavigation() {
  const pathname = usePathname();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [moreOpen, setMoreOpen] = useState(false);

  if (pathname === '/login') return null;

  const moreIsCurrent = secondaryNavigation.some((item) => isCurrentRoute(pathname, item.href));
  const openMore = () => {
    setMoreOpen(true);
    dialogRef.current?.showModal();
  };
  const closeMore = () => {
    setMoreOpen(false);
    dialogRef.current?.close();
  };

  return <>
    <nav className="mobile-nav" aria-label="Navegação principal">
      {primaryNavigation.map((item) => {
        const current = isCurrentRoute(pathname, item.href);
        return <Link
          href={item.href}
          key={item.href}
          className={current ? 'active' : undefined}
          aria-current={current ? 'page' : undefined}
        >
          <span className="mobile-nav-icon" aria-hidden="true">{item.icon}</span>
          <span>{item.shortLabel ?? item.label}</span>
        </Link>;
      })}
      <button
        type="button"
        className={moreIsCurrent || moreOpen ? 'active' : undefined}
        aria-expanded={moreOpen}
        aria-haspopup="dialog"
        onClick={openMore}
      >
        <span className="mobile-nav-icon" aria-hidden="true">•••</span>
        <span>Mais</span>
      </button>
    </nav>

    <dialog
      ref={dialogRef}
      className="mobile-more-dialog"
      aria-labelledby="mobile-more-title"
      onClose={() => setMoreOpen(false)}
      onClick={(event) => {
        if (event.target === event.currentTarget) closeMore();
      }}
    >
      <div className="mobile-more-head">
        <div>
          <span className="eyebrow">OLIVEIRA DEVCLOUD</span>
          <h2 id="mobile-more-title">Navegação</h2>
        </div>
        <button type="button" className="mobile-more-close" aria-label="Fechar navegação" onClick={closeMore}>×</button>
      </div>
      <div className="mobile-more-grid">
        {secondaryNavigation.map((item) => {
          const current = isCurrentRoute(pathname, item.href);
          return <Link
            href={item.href}
            prefetch={false}
            key={item.href}
            className={current ? 'active' : undefined}
            aria-current={current ? 'page' : undefined}
            onClick={closeMore}
          >
            <span aria-hidden="true">{item.icon}</span>
            <strong>{item.label}</strong>
          </Link>;
        })}
      </div>
    </dialog>
  </>;
}
