import { readFile } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import {
  API_BODY_LIMIT_BYTES,
  API_KEEP_ALIVE_TIMEOUT_MS,
  API_REQUEST_TIMEOUT_MS,
  buildApp
} from './app.js';

const nginxConfigs = [
  {
    path: new URL('../../../infra/production/nginx-devcloud.host.conf.example', import.meta.url),
    panelMarker: '# --- Painel (control plane)',
    runtimeMarker: '# --- Runtime Gateway',
    panelHost: 'app.aifunnelpro.com.br',
    runtimeHost: 'runtime.tiremax.shop'
  },
  {
    path: new URL('../../../infra/production/nginx.prod.conf', import.meta.url),
    panelMarker: '# --- Control plane (panel)',
    runtimeMarker: '# --- Runtime Gateway',
    panelHost: '${DEV_CLOUD_HOST}',
    runtimeHost: '${RUNTIME_BASE_DOMAIN}'
  }
] as const;

describe('HTTP boundary policy', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('configures explicit API receive and keep-alive limits', async () => {
    app = await buildApp({ logger: false, disableRateLimit: true });
    await app.ready();

    expect(app.initialConfig.bodyLimit).toBe(API_BODY_LIMIT_BYTES);
    expect(app.server.requestTimeout).toBe(API_REQUEST_TIMEOUT_MS);
    expect(app.server.keepAliveTimeout).toBe(API_KEEP_ALIVE_TIMEOUT_MS);
  });

  it('rejects a JSON control-plane payload larger than 1 MiB', async () => {
    app = await buildApp({ logger: false, disableRateLimit: true });
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        email: 'oversized@example.com',
        password: 'Correct-Horse-Battery-9',
        padding: 'x'.repeat(API_BODY_LIMIT_BYTES)
      })
    });

    expect(response.statusCode).toBe(413);
  });

  for (const config of nginxConfigs) {
    it(`keeps nginx limits and panel headers aligned in ${config.path.pathname.split('/').at(-1)}`, async () => {
      const source = await readFile(config.path, 'utf8');
      const panel = source.split(config.panelMarker)[1]?.split(config.runtimeMarker)[0];
      const runtime = source.split(config.runtimeMarker)[1];

      expect(panel).toBeDefined();
      expect(runtime).toBeDefined();
      expect(panel).toContain('client_max_body_size 1m;');
      expect(panel).toContain('client_header_timeout 10s;');
      expect(panel).toContain('client_body_timeout 30s;');
      expect(panel).toContain('proxy_connect_timeout 5s;');
      expect(panel).toContain('proxy_read_timeout 3600s;');
      expect(panel).toContain("frame-ancestors 'none'");
      expect(panel).toContain(`wss://${config.panelHost}`);
      expect(panel).toContain(`https://*.${config.runtimeHost}`);
      expect(panel).toContain('add_header X-Frame-Options DENY always;');
      expect(panel).toContain('add_header Referrer-Policy no-referrer always;');
      expect(panel).toContain('add_header Permissions-Policy');
      expect(runtime).toContain('client_max_body_size 25m;');
      expect(runtime).toContain('proxy_connect_timeout 5s;');
      expect(runtime).toContain('proxy_read_timeout 3600s;');
      expect(runtime).not.toContain('add_header Content-Security-Policy');
    });
  }
});
