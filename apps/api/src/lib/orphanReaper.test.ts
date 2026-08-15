import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { reapOrphanedWorkspaceResources } from './orphanReaper.js';

const roots: string[] = [];
const activeId = 'cm12345678901234567890123';
const orphanId = 'cm22345678901234567890123';
const retainedByDockerId = 'cm32345678901234567890123';
const appearedDuringSweepId = 'cm42345678901234567890123';
const recentId = 'cm52345678901234567890123';

afterEach(async () => {
  while (roots.length) {
    const root = path.resolve(roots.pop()!);
    if (!root.startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('UNSAFE_TEST_CLEANUP_PATH');
    await fs.rm(root, { recursive: true, force: true });
  }
});

describe('workspace orphan reaper', () => {
  it('removes only old, direct CUID storage after Docker cleanup and a point-of-delete DB recheck', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'odc-orphan-reaper-'));
    roots.push(root);
    for (const id of [activeId, orphanId, retainedByDockerId, appearedDuringSweepId, recentId]) {
      await fs.mkdir(path.join(root, id));
      await fs.writeFile(path.join(root, id, 'proof.txt'), id);
    }
    await fs.mkdir(path.join(root, 'operator-notes'));
    await fs.writeFile(path.join(root, 'cm62345678901234567890123'), 'not a directory');
    const futureNow = new Date(Date.now() + 2 * 60 * 60_000);
    await fs.utimes(path.join(root, recentId), futureNow, futureNow);

    const snapshots = [[activeId], [activeId]];
    let brokerInput: { activeWorkspaceIds: string[]; orphanedBefore: string } | undefined;
    const result = await reapOrphanedWorkspaceResources({
      workspaceRoot: root,
      now: () => futureNow,
      listWorkspaceIds: async () => snapshots.shift() ?? [],
      workspaceExists: async id => id === activeId || id === appearedDuringSweepId,
      pruneDocker: async input => {
        brokerInput = input;
        return {
          removedContainers: ['orphan-container'],
          removedNetworks: ['orphan-network'],
          retainedWorkspaceIds: [retainedByDockerId],
          skippedRecent: 1,
          skippedAttachedNetworks: 0,
          failures: 0
        };
      }
    }, 60 * 60_000);

    expect(brokerInput?.activeWorkspaceIds).toEqual([activeId]);
    expect(result.removedStorage).toEqual([orphanId]);
    await expect(fs.stat(path.join(root, orphanId))).rejects.toMatchObject({ code: 'ENOENT' });
    for (const preserved of [activeId, retainedByDockerId, appearedDuringSweepId, recentId, 'operator-notes']) {
      await expect(fs.stat(path.join(root, preserved))).resolves.toBeDefined();
    }
    expect(result.skippedRecentStorage).toBe(1);
    expect(result.skippedUnsafeStorage).toBe(3);
    expect(result.storageFailures).toBe(0);
  });

  it('does not touch storage when Docker inventory/cleanup fails', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'odc-orphan-reaper-failure-'));
    roots.push(root);
    await fs.mkdir(path.join(root, orphanId));

    await expect(reapOrphanedWorkspaceResources({
      workspaceRoot: root,
      listWorkspaceIds: async () => [],
      workspaceExists: async () => false,
      pruneDocker: async () => { throw new Error('BROKER_UNAVAILABLE'); }
    }, 0)).rejects.toThrow('BROKER_UNAVAILABLE');
    await expect(fs.stat(path.join(root, orphanId))).resolves.toBeDefined();
  });
});
