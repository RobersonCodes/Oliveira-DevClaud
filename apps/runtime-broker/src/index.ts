import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
loadEnv({ path: fileURLToPath(new URL('../../../.env', import.meta.url)) });

const { buildBrokerApp } = await import('./app.js');
const app = await buildBrokerApp();
const port = Number(process.env.RUNTIME_BROKER_PORT ?? 5001);
// 0.0.0.0 is safe here specifically because this port is never published in docker-compose — only
// other containers on the same internal compose network can reach it by service name.
await app.listen({ port, host: '0.0.0.0' });

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info(`${signal} received, shutting down gracefully`);
  const forceExit = setTimeout(() => {
    app.log.warn('Graceful shutdown timed out after 10s, forcing exit');
    process.exit(1);
  }, 10_000);
  forceExit.unref();
  try {
    await app.close();
    clearTimeout(forceExit);
    process.exit(0);
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
