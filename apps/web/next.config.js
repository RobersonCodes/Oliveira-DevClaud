/** @type {import('next').NextConfig} */
const nextConfig = {
  async headers() {
    return [
      {
        source: '/sw.js',
        headers: [
          { key: 'Content-Type', value: 'application/javascript; charset=utf-8' },
          { key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' },
          { key: 'Content-Security-Policy', value: "default-src 'self'; script-src 'self'" },
          { key: 'Service-Worker-Allowed', value: '/' },
          { key: 'X-Content-Type-Options', value: 'nosniff' }
        ]
      }
    ];
  },
  async rewrites() {
    // Fase 1 hardening: the browser only ever talks to this app's own origin — no
    // NEXT_PUBLIC_API_URL, no hardcoded localhost:4000 fallback anywhere in the client bundle. In
    // production this rewrite is dead code: nginx already routes `/api/` straight to the api
    // service before the request reaches this Next.js server at all (see
    // infra/production/nginx.prod.conf). In local dev (`next dev` on :3000 by default, the API on
    // API_PORT — 4000 by default), this is what actually gets `/api/v1/...` requests (including
    // WebSocket upgrades and Server-Sent Events, both just HTTP requests on the wire) to the real
    // API process without the browser ever seeing a different origin.
    const apiPort = process.env.API_PORT ?? '4000';
    return [
      { source: '/api/:path*', destination: `http://localhost:${apiPort}/api/:path*` }
    ];
  }
};

module.exports = nextConfig;
