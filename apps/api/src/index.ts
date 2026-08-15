import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
// `npm run dev -w @oliveira/api` runs with cwd set to apps/api, not the repo root, so the
// default dotenv cwd-lookup would never find the root .env. Resolve it relative to this file instead.
loadEnv({ path: fileURLToPath(new URL('../../../.env', import.meta.url)) });

const { buildApp } = await import('./app.js');
const { prisma } = await import('@oliveira/database');
const { startOrphanReaper } = await import('./lib/orphanReaper.js');
const app = await buildApp();
const port = Number(process.env.API_PORT ?? 4000);
await app.listen({ port, host: '0.0.0.0' });
const orphanReaper = startOrphanReaper({
  logger: app.log,
  intervalMs: Number(process.env.ORPHAN_REAPER_INTERVAL_MS ?? 300_000),
  graceMs: Number(process.env.ORPHAN_REAPER_GRACE_MS ?? 3_600_000)
});

// Without this, `docker stop`/a rolling deploy SIGTERMs the process immediately: in-flight HTTP
// requests get cut off mid-response, open terminal/IDE WebSocket connections drop without a close
// frame, and the Prisma connection pool is torn down by the OS rather than closed cleanly.
let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  orphanReaper.stop();
  app.log.info(`${signal} received, shutting down gracefully`);
  const forceExit = setTimeout(() => {
    app.log.warn('Graceful shutdown timed out after 10s, forcing exit');
    process.exit(1);
  }, 10_000);
  forceExit.unref();
  try {
    await app.close(); // drains in-flight HTTP requests and closes WebSocket connections (@fastify/websocket's onClose hook)
    await prisma.$disconnect();
    clearTimeout(forceExit);
    process.exit(0);
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
