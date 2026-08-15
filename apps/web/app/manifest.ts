import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: '/',
    name: 'Oliveira DevCloud',
    short_name: 'DevCloud',
    description: 'Workspace remoto orientado por agentes para desenvolver, revisar e entregar software.',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'any',
    background_color: '#090b0f',
    theme_color: '#090b0f',
    lang: 'pt-BR',
    categories: ['developer-tools', 'productivity'],
    icons: [
      {
        src: '/icon.png',
        sizes: '1254x1254',
        type: 'image/png',
        purpose: 'any'
      }
    ],
    shortcuts: [
      { name: 'Projetos', short_name: 'Projetos', url: '/projects' },
      { name: 'Agentes', short_name: 'Agentes', url: '/agents' },
      { name: 'Terminal', short_name: 'Terminal', url: '/terminal' }
    ]
  };
}
