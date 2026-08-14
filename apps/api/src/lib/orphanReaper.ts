import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { prisma } from '@oliveira/database';
import {
  RuntimeBrokerClient,
  type PruneWorkspaceResourcesResult
} from '@oliveira/runtime-broker-client';

export const DEFAULT_ORPHAN_REAPER_INTERVAL_MS = 5 * 60_000;
export const DEFAULT_ORPHAN_GRACE_MS = 60 * 60_000;

type Logger = {
  info(value: unknown, message?: string): void;
  error(value: unknown, message?: string): void;
};

export type OrphanReaperResult = {
  docker: PruneWorkspaceResourcesResult;
  removedStorage: string[];
  skippedRecentStorage: number;
  skippedUnsafeStorage: number;
  storageFailures: number;
};

export type OrphanReaperDependencies = {
  workspaceRoot: string;
  listWorkspaceIds(): Promise<string[]>;
  workspaceExists(workspaceId: string): Promise<boolean>;
  pruneDocker(input: { activeWorkspaceIds: string[]; orphanedBefore: string }): Promise<PruneWorkspaceResourcesResult>;
  now?: () => Date;
};

const workspaceIdSchema = z.string().cuid();

/**
 * PostgreSQL is the source of truth. Docker cleanup must succeed first; only then may storage be
 * removed, and never for an id the broker retained because a container/network is recent, attached
 * or failed cleanup. Every filesystem candidate is rechecked in PostgreSQL immediately before rm.
 */
export async function reapOrphanedWorkspaceResources(
  dependencies: OrphanReaperDependencies,
  graceMs = DEFAULT_ORPHAN_GRACE_MS
): Promise<OrphanReaperResult> {
  const now = dependencies.now?.() ?? new Date();
  const cutoff = new Date(now.getTime() - graceMs);
  const firstSnapshot = await dependencies.listWorkspaceIds();
  // Union a second snapshot to close the inventory window. A workspace created after it is still
  // protected by the independent creation-age grace period in both Docker and the filesystem.
  const secondSnapshot = await dependencies.listWorkspaceIds();
  const activeWorkspaceIds = [...new Set([...firstSnapshot, ...secondSnapshot])];
  const docker = await dependencies.pruneDocker({
    activeWorkspaceIds,
    orphanedBefore: cutoff.toISOString()
  });
  const retained = new Set(docker.retainedWorkspaceIds);
  const root = path.resolve(dependencies.workspaceRoot);
  const removedStorage: string[] = [];
  let skippedRecentStorage = 0;
  let skippedUnsafeStorage = 0;
  let storageFailures = 0;

  const entries = await fs.readdir(root, { withFileTypes: true }).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  });
  for (const entry of entries) {
    if (!entry.isDirectory() || !workspaceIdSchema.safeParse(entry.name).success) {
      skippedUnsafeStorage += 1;
      continue;
    }
    const target = path.resolve(root, entry.name);
    if (path.dirname(target) !== root || path.basename(target) !== entry.name || retained.has(entry.name)) {
      skippedUnsafeStorage += 1;
      continue;
    }
    try {
      const stat = await fs.lstat(target);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        skippedUnsafeStorage += 1;
        continue;
      }
      const newestMetadataMs = Math.max(stat.birthtimeMs, stat.ctimeMs, stat.mtimeMs);
      if (newestMetadataMs > cutoff.getTime()) {
        skippedRecentStorage += 1;
        continue;
      }
      // The point-of-delete check is intentionally per candidate, after lstat and after Docker.
      if (await dependencies.workspaceExists(entry.name)) continue;
      await fs.rm(target, { recursive: true, force: false, maxRetries: 3, retryDelay: 100 });
      removedStorage.push(entry.name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') storageFailures += 1;
    }
  }

  return { docker, removedStorage, skippedRecentStorage, skippedUnsafeStorage, storageFailures };
}

export function startOrphanReaper(options: {
  logger: Logger;
  intervalMs?: number;
  graceMs?: number;
  workspaceRoot?: string;
}) {
  const broker = new RuntimeBrokerClient();
  const dependencies: OrphanReaperDependencies = {
    workspaceRoot: path.resolve(options.workspaceRoot ?? process.env.WORKSPACE_ROOT ?? '/var/lib/oliveira-devcloud/workspaces'),
    listWorkspaceIds: async () => (await prisma.workspace.findMany({ select: { id: true } })).map(row => row.id),
    workspaceExists: async workspaceId => (await prisma.workspace.count({ where: { id: workspaceId } })) > 0,
    pruneDocker: input => broker.pruneWorkspaceResources(input)
  };
  // Invalid/over-aggressive environment values must never turn setInterval into a hot loop or
  // remove resources created moments ago. Production may tune upward, not below these floors.
  const requestedIntervalMs = options.intervalMs ?? DEFAULT_ORPHAN_REAPER_INTERVAL_MS;
  const requestedGraceMs = options.graceMs ?? DEFAULT_ORPHAN_GRACE_MS;
  const intervalMs = Number.isFinite(requestedIntervalMs) && requestedIntervalMs >= 60_000
    ? requestedIntervalMs
    : DEFAULT_ORPHAN_REAPER_INTERVAL_MS;
  const graceMs = Number.isFinite(requestedGraceMs) && requestedGraceMs >= 5 * 60_000
    ? requestedGraceMs
    : DEFAULT_ORPHAN_GRACE_MS;
  let running = false;
  const sweep = async () => {
    if (running) return;
    running = true;
    try {
      const result = await reapOrphanedWorkspaceResources(dependencies, graceMs);
      if (result.removedStorage.length || result.docker.removedContainers.length || result.docker.removedNetworks.length || result.docker.failures || result.storageFailures) {
        options.logger.info({ orphanReaper: result }, 'Workspace orphan reaper sweep');
      }
    } catch (error) {
      options.logger.error({ err: error }, 'Workspace orphan reaper failed');
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void sweep(), intervalMs);
  timer.unref();
  void sweep();
  return { stop: () => clearInterval(timer), sweep };
}
