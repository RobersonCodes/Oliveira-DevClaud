import crypto from 'node:crypto';
import Docker from 'dockerode';
import { buildBrokerApp, type BuildBrokerAppOptions } from './app.js';

/**
 * Starts a real broker instance (real Fastify app, real Docker daemon underneath) on an ephemeral
 * port, for any package's tests to point a `RuntimeBrokerClient` at — this is what "test against a
 * real broker, not a mock" means in practice. Every migrated engine's test suite uses this instead
 * of instantiating `dockerode` directly, so the exact same allowlist/validation code that runs in
 * production also runs in every one of those tests.
 */
export async function startTestBroker(overrides: { docker?: Docker; config?: BuildBrokerAppOptions['config'] } = {}) {
  const token = crypto.randomBytes(16).toString('hex');
  process.env.RUNTIME_BROKER_TOKEN = token;
  const app = await buildBrokerApp({ logger: false, docker: overrides.docker, config: overrides.config });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    token,
    app,
    close: () => app.close()
  };
}
