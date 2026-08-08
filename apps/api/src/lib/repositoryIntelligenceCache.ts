import { prisma } from '@oliveira/database';
import { getRepositoryRevision, inspectRepository, type RepositoryIntelligence } from '@oliveira/repository-intelligence';

export type RepositoryCacheResult = {
  intelligence: RepositoryIntelligence;
  cache: {
    hit: boolean;
    cacheable: boolean;
    reason: 'HIT' | 'MISS' | 'DIRTY_WORKTREE' | 'NO_HEAD' | 'FORCED_REFRESH';
    commitSha?: string;
  };
};

export async function getRepositoryIntelligenceCached(input: { workspaceId: string; containerId: string; force?: boolean }): Promise<RepositoryCacheResult> {
  const revision = await getRepositoryRevision(input.containerId);
  const cacheable = Boolean(revision.head && revision.clean);

  if (!input.force && cacheable && revision.head) {
    const cached = await prisma.repositorySnapshot.findUnique({ where: { workspaceId_commitSha: { workspaceId: input.workspaceId, commitSha: revision.head } } });
    if (cached) {
      return {
        intelligence: cached.payload as unknown as RepositoryIntelligence,
        cache: { hit: true, cacheable: true, reason: 'HIT', commitSha: revision.head }
      };
    }
  }

  const intelligence = await inspectRepository(input.containerId, revision);
  if (cacheable && revision.head) {
    await prisma.repositorySnapshot.upsert({
      where: { workspaceId_commitSha: { workspaceId: input.workspaceId, commitSha: revision.head } },
      create: { workspaceId: input.workspaceId, commitSha: revision.head, branch: revision.branch, payload: intelligence as any },
      update: { branch: revision.branch, payload: intelligence as any, generatedAt: new Date() }
    });
  }

  const reason: RepositoryCacheResult['cache']['reason'] = input.force
    ? 'FORCED_REFRESH'
    : !revision.head
      ? 'NO_HEAD'
      : !revision.clean
        ? 'DIRTY_WORKTREE'
        : 'MISS';

  return { intelligence, cache: { hit: false, cacheable, reason, commitSha: revision.head } };
}
