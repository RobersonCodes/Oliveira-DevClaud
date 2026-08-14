import { RuntimeBrokerClient } from '@oliveira/runtime-broker-client';

const broker = new RuntimeBrokerClient();
const safeBranch = (v: string) => { if (!/^[A-Za-z0-9._/-]+$/.test(v)) throw new Error('INVALID_BRANCH'); return v; };

/**
 * Shared by apps/api (repositories.ts) and apps/worker (index.ts) — previously two byte-for-byte
 * duplicate files, each with their own dockerode client. Consolidated here during the Runtime
 * Broker migration (Fase 4) since both call sites need the exact same behavior and there's no
 * reason for the duplication to survive the rewrite.
 */
export async function bootstrapRepository(input: { containerId: string; repositoryUrl: string; defaultBranch: string; githubToken?: string | null }) {
  const branch = safeBranch(input.defaultBranch);
  const authHeader = input.githubToken ? `Authorization: Bearer ${input.githubToken}` : null;
  const cloneArgs = ['git'];
  if (authHeader) cloneArgs.push('-c', `http.extraHeader=${authHeader}`);
  cloneArgs.push('clone', '--branch', branch, '--single-branch', '--depth', '50', input.repositoryUrl, '.');

  const result = await broker.exec(input.containerId, { cmd: cloneArgs, workingDir: '/workspace/repository' });
  if (result.exitCode !== 0) {
    throw Object.assign(new Error('REPOSITORY_BOOTSTRAP_FAILED'), { statusCode: 500, details: result.output.slice(-4000) });
  }
  return result.output;
}
