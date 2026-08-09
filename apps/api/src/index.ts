import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
// `npm run dev -w @oliveira/api` runs with cwd set to apps/api, not the repo root, so the
// default dotenv cwd-lookup would never find the root .env. Resolve it relative to this file instead.
loadEnv({ path: fileURLToPath(new URL('../../../.env', import.meta.url)) });

const { buildApp } = await import('./app.js');
const app = await buildApp();
const port = Number(process.env.API_PORT ?? 4000);
await app.listen({ port, host: '0.0.0.0' });
