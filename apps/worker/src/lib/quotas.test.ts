import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { deadlineExceeded, directorySizeBytes, remainingDurationMs } from './quotas.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  while (temporaryDirectories.length) await fs.rm(temporaryDirectories.pop()!, { recursive: true, force: true });
});

describe('resource quota primitives', () => {
  it('measures nested files but never follows a symlink outside the workspace', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'odc-quota-'));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'odc-quota-outside-'));
    temporaryDirectories.push(root, outside);
    await fs.mkdir(path.join(root, 'repository'));
    await fs.writeFile(path.join(root, 'repository', 'inside.bin'), Buffer.alloc(1024));
    await fs.writeFile(path.join(outside, 'secret.bin'), Buffer.alloc(8192));
    await fs.symlink(outside, path.join(root, 'repository', 'outside-link'), 'junction');

    expect(await directorySizeBytes(root)).toBe(1024);
  });

  it('uses an inclusive deadline and never returns negative remaining time', () => {
    const startedAt = new Date('2026-08-14T00:00:00.000Z');
    expect(deadlineExceeded(startedAt, 60, new Date('2026-08-14T00:00:59.999Z'))).toBe(false);
    expect(deadlineExceeded(startedAt, 60, new Date('2026-08-14T00:01:00.000Z'))).toBe(true);
    expect(remainingDurationMs(startedAt, 60, new Date('2026-08-14T00:02:00.000Z'))).toBe(0);
  });

  it('rejects a missing workspace root instead of treating an unavailable quota as zero usage', async () => {
    const missing = path.join(os.tmpdir(), `odc-quota-missing-${crypto.randomUUID()}`);
    await expect(directorySizeBytes(missing)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
