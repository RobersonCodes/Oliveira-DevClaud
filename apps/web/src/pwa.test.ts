import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import manifest from '../app/manifest.js';

const require = createRequire(import.meta.url);
const nextConfig = require('../next.config.js') as {
  headers: () => Promise<Array<{ source: string; headers: Array<{ key: string; value: string }> }>>;
};

describe('PWA shell', () => {
  it('publishes an installable, scoped manifest with explicit PWA artwork', () => {
    const value = manifest();
    expect(value).toMatchObject({
      id: '/',
      start_url: '/',
      scope: '/',
      display: 'standalone',
      background_color: '#090b0f',
      theme_color: '#090b0f'
    });
    expect(value.icons).toContainEqual({
      src: '/icon.png',
      sizes: '1254x1254',
      type: 'image/png',
      purpose: 'any'
    });
  });

  it('keeps the service worker network-only for authenticated application content', async () => {
    const worker = await readFile(new URL('../public/sw.js', import.meta.url), 'utf8');
    expect(worker).toContain("self.addEventListener('install'");
    expect(worker).toContain("self.addEventListener('activate'");
    expect(worker).not.toContain("self.addEventListener('fetch'");
    expect(worker).not.toMatch(/caches\.(open|match)/);
  });

  it('serves the worker with a root scope and disables HTTP caching', async () => {
    const workerHeaders = (await nextConfig.headers()).find(entry => entry.source === '/sw.js');
    expect(Object.fromEntries(workerHeaders?.headers.map(header => [header.key, header.value]) ?? [])).toMatchObject({
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Content-Type': 'application/javascript; charset=utf-8',
      'Service-Worker-Allowed': '/',
      'X-Content-Type-Options': 'nosniff'
    });
  });
});
