import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { PwaLifecycle } from './pwa-lifecycle';
import './styles.css';

export const metadata: Metadata = {
  applicationName: 'Oliveira DevCloud',
  title: { default: 'Oliveira DevCloud', template: '%s · Oliveira DevCloud' },
  description: 'Workspace remoto orientado por agentes para desenvolver, revisar e entregar software.',
  manifest: '/manifest.webmanifest',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'DevCloud'
  },
  icons: {
    apple: [{ url: '/icon.png', sizes: '1254x1254', type: 'image/png' }]
  },
  formatDetection: { telephone: false }
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#090b0f',
  colorScheme: 'dark'
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="pt-BR"><body>{children}<PwaLifecycle /></body></html>;
}
