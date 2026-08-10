import { RuntimeBrokerClient, type RuntimeBrokerClientOptions } from '@oliveira/runtime-broker-client';

export type WorktreeInfo = {
  path: string;
  branchName: string;
  baseCommit: string;
};

export type ReviewDiff = {
  branchName: string;
  baseCommit: string;
  status: string;
  files: string;
  committedStat: string;
  committedDiff: string;
  workingStat: string;
  workingDiff: string;
};

export type FileChangeStatus = 'ADDED' | 'MODIFIED' | 'DELETED' | 'RENAMED';
export type FileChange = { status: FileChangeStatus; path: string; previousPath?: string };

const safeTaskId = (value: string) => {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw new Error('INVALID_TASK_ID');
  return value;
};

const safeAgent = (value: string) => {
  const lower = value.toLowerCase();
  if (lower !== 'codex' && lower !== 'claude') throw new Error('INVALID_AGENT');
  return lower;
};

export class DockerGitIsolationEngine {
  private readonly broker: RuntimeBrokerClient;

  constructor(opts?: RuntimeBrokerClientOptions) {
    this.broker = new RuntimeBrokerClient(opts);
  }

  private async exec(containerId: string, cmd: string[], workingDir = '/workspace/repository') {
    return this.broker.exec(containerId, { cmd, workingDir });
  }

  private assertOk(result: { exitCode: number; output: string }, errorCode: string) {
    if (result.exitCode !== 0) {
      const error = new Error(errorCode);
      Object.assign(error, { detail: result.output.slice(-4000) });
      throw error;
    }
    return result.output.trim();
  }

  async ensureRepository(containerId: string) {
    const check = await this.exec(containerId, ['git', 'rev-parse', '--is-inside-work-tree']);
    if (check.exitCode !== 0 || !check.output.includes('true')) throw new Error('WORKSPACE_REPOSITORY_NOT_INITIALIZED');
  }

  async createWorktree(containerId: string, taskId: string, agent: string): Promise<WorktreeInfo> {
    const id = safeTaskId(taskId);
    const agentName = safeAgent(agent);
    await this.ensureRepository(containerId);

    const baseCommit = this.assertOk(await this.exec(containerId, ['git', 'rev-parse', 'HEAD']), 'GIT_HEAD_NOT_FOUND');
    const branchName = `agent/${agentName}/${id}`;
    const path = `/workspace/worktrees/${id}`;

    const existing = await this.exec(containerId, ['git', 'show-ref', '--verify', '--quiet', `refs/heads/${branchName}`]);
    if (existing.exitCode === 0) throw new Error('AGENT_BRANCH_ALREADY_EXISTS');

    this.assertOk(
      await this.exec(containerId, ['git', 'worktree', 'add', '-b', branchName, path, baseCommit]),
      'WORKTREE_CREATE_FAILED'
    );

    return { path, branchName, baseCommit };
  }

  async review(containerId: string, worktree: WorktreeInfo): Promise<ReviewDiff> {
    const status = (await this.exec(containerId, ['git', 'status', '--short', '--branch'], worktree.path)).output;
    const files = (await this.exec(containerId, ['git', 'diff', '--name-status', worktree.baseCommit, 'HEAD'], worktree.path)).output;
    const committedStat = (await this.exec(containerId, ['git', 'diff', '--stat', worktree.baseCommit, 'HEAD'], worktree.path)).output;
    const committedDiff = (await this.exec(containerId, ['git', 'diff', '--no-ext-diff', '--unified=3', worktree.baseCommit, 'HEAD'], worktree.path)).output;
    const workingStat = (await this.exec(containerId, ['git', 'diff', '--stat', 'HEAD'], worktree.path)).output;
    const workingDiff = (await this.exec(containerId, ['git', 'diff', '--no-ext-diff', '--unified=3', 'HEAD'], worktree.path)).output;
    return {
      branchName: worktree.branchName,
      baseCommit: worktree.baseCommit,
      status,
      files,
      committedStat,
      committedDiff: committedDiff.slice(0, 250_000),
      workingStat,
      workingDiff: workingDiff.slice(0, 250_000)
    };
  }

  /** Authoritative added/modified/deleted/renamed file list between two commits in a worktree. */
  async diffNameStatus(containerId: string, worktreePath: string, baseCommit: string, headRef = 'HEAD'): Promise<FileChange[]> {
    const result = await this.exec(containerId, ['git', 'diff', '--no-ext-diff', '--name-status', baseCommit, headRef], worktreePath);
    if (result.exitCode !== 0) return [];
    const changes: FileChange[] = [];
    for (const line of result.output.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parts = trimmed.split('\t');
      const code = parts[0];
      if (code.startsWith('R') && parts.length >= 3) {
        changes.push({ status: 'RENAMED', path: parts[2], previousPath: parts[1] });
      } else if (parts.length >= 2) {
        const status: FileChangeStatus = code.startsWith('A') ? 'ADDED' : code.startsWith('D') ? 'DELETED' : 'MODIFIED';
        changes.push({ status, path: parts[1] });
      }
    }
    return changes;
  }

  async snapshot(containerId: string, worktree: WorktreeInfo, taskId: string) {
    const dirty = await this.exec(containerId, ['git', 'status', '--porcelain'], worktree.path);
    this.assertOk(dirty, 'WORKTREE_STATUS_FAILED');
    if (!dirty.output.trim()) return { committed: false };

    this.assertOk(await this.exec(containerId, ['git', 'add', '-A'], worktree.path), 'WORKTREE_STAGE_FAILED');
    const message = `chore(agent): snapshot ${safeTaskId(taskId)}`;
    this.assertOk(await this.exec(containerId, [
      'git', '-c', 'user.name=Oliveira DevCloud', '-c', 'user.email=devcloud@local',
      'commit', '-m', message
    ], worktree.path), 'WORKTREE_COMMIT_FAILED');
    return { committed: true };
  }

  async merge(containerId: string, worktree: WorktreeInfo, taskId: string) {
    await this.snapshot(containerId, worktree, taskId);

    const mainDirty = await this.exec(containerId, ['git', 'status', '--porcelain'], '/workspace/repository');
    this.assertOk(mainDirty, 'MAIN_WORKTREE_STATUS_FAILED');
    if (mainDirty.output.trim()) throw new Error('MAIN_WORKTREE_DIRTY');

    const result = await this.exec(containerId, [
      'git', '-c', 'user.name=Oliveira DevCloud', '-c', 'user.email=devcloud@local',
      'merge', '--no-ff', worktree.branchName, '-m', `merge(agent): ${safeTaskId(taskId)}`
    ], '/workspace/repository');
    this.assertOk(result, 'AGENT_MERGE_FAILED');
    const mergeCommit = this.assertOk(await this.exec(containerId, ['git', 'rev-parse', 'HEAD']), 'MERGE_COMMIT_NOT_FOUND');
    return { mergeCommit };
  }

  async cleanup(containerId: string, worktree: WorktreeInfo, deleteBranch = true) {
    await this.exec(containerId, ['git', 'worktree', 'remove', '--force', worktree.path]);
    await this.exec(containerId, ['git', 'worktree', 'prune']);
    if (deleteBranch) await this.exec(containerId, ['git', 'branch', '-D', worktree.branchName]);
  }
}
