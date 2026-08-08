import type { ReactNode } from 'react';
import './styles.css';

export const metadata = { title: 'Oliveira DevCloud', description: 'AI-native remote development workspace' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="pt-BR"><body>{children}</body></html>;
}
