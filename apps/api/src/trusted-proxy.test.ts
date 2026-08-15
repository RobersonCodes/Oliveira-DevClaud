import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { parseTrustedProxyCidrs } from './lib/trustedProxy.js';

describe('trusted proxy boundary', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  async function appReportingRequestIdentity(trustedProxies: false | string[]) {
    app = await buildApp({ logger: false, disableRateLimit: true, trustedProxies });
    app.get('/__test/request-identity', async request => ({
      ip: request.ip,
      ips: request.ips,
      protocol: request.protocol,
      host: request.host
    }));
    return app;
  }

  it('disables proxy trust when no CIDR is configured', () => {
    expect(parseTrustedProxyCidrs(undefined)).toBe(false);
    expect(parseTrustedProxyCidrs('   ')).toBe(false);
  });

  it('parses explicit IPv4 and IPv6 addresses/CIDRs', () => {
    expect(parseTrustedProxyCidrs('172.30.0.1/32, ::1/128, 127.0.0.1')).toEqual([
      '172.30.0.1/32',
      '::1/128',
      '127.0.0.1'
    ]);
  });

  it.each(['hostname', '10.0.0.1/33', '::1/129', '10.0.0.1/', '10.0.0.1,,::1'])(
    'rejects an invalid proxy allowlist: %s',
    value => expect(() => parseTrustedProxyCidrs(value)).toThrow('INVALID_TRUSTED_PROXY_CIDRS')
  );

  it('ignores forwarded identity headers from an untrusted direct connection', async () => {
    const server = await appReportingRequestIdentity(['10.0.0.1/32']);
    const response = await server.inject({
      method: 'GET',
      url: '/__test/request-identity',
      remoteAddress: '203.0.113.40',
      headers: {
        host: 'api.internal',
        'x-forwarded-for': '198.51.100.20',
        'x-forwarded-host': 'attacker.example',
        'x-forwarded-proto': 'https'
      }
    });

    expect(response.json()).toMatchObject({
      ip: '203.0.113.40',
      protocol: 'http',
      host: 'api.internal'
    });
  });

  it('accepts the client identity from the configured proxy only', async () => {
    const server = await appReportingRequestIdentity(['10.0.0.1/32']);
    const response = await server.inject({
      method: 'GET',
      url: '/__test/request-identity',
      remoteAddress: '10.0.0.1',
      headers: {
        'x-forwarded-for': '198.51.100.20',
        'x-forwarded-host': 'app.aifunnelpro.com.br',
        'x-forwarded-proto': 'https'
      }
    });

    expect(response.json()).toMatchObject({
      ip: '198.51.100.20',
      ips: ['10.0.0.1', '198.51.100.20'],
      protocol: 'https',
      host: 'app.aifunnelpro.com.br'
    });
  });

  it('stops at the first untrusted hop instead of accepting a spoofed leftmost address', async () => {
    const server = await appReportingRequestIdentity(['10.0.0.1/32']);
    const response = await server.inject({
      method: 'GET',
      url: '/__test/request-identity',
      remoteAddress: '10.0.0.1',
      headers: { 'x-forwarded-for': '192.0.2.99, 198.51.100.20' }
    });

    expect(response.json()).toMatchObject({
      ip: '198.51.100.20',
      ips: ['10.0.0.1', '198.51.100.20']
    });
  });
});
