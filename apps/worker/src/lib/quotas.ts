import fs from 'node:fs/promises';
import path from 'node:path';
import type { PrismaClient } from '@oliveira/database';

export const QUOTA_CODES = {
  workspaceDisk: 'WORKSPACE_DISK_QUOTA_EXCEEDED',
  workspaceDiskUnavailable: 'WORKSPACE_DISK_QUOTA_UNAVAILABLE',
  workspaceDuration: 'WORKSPACE_DURATION_EXCEEDED',
  agentDuration: 'AGENT_DURATION_EXCEEDED',
  orchestrationDuration: 'ORCHESTRATION_DURATION_EXCEEDED',
  setupDuration: 'SETUP_DURATION_EXCEEDED'
} as const;

export function deadlineExceeded(startedAt: Date | null, maxDurationSeconds: number, at = new Date()) {
  return startedAt !== null && at.getTime() >= startedAt.getTime() + maxDurationSeconds * 1000;
}

export function remainingDurationMs(startedAt: Date, maxDurationSeconds: number, at = new Date()) {
  return Math.max(0, startedAt.getTime() + maxDurationSeconds * 1000 - at.getTime());
}

export async function directorySizeBytes(directory: string, stopAfterBytes = Number.POSITIVE_INFINITY): Promise<number> {
  let total = 0;
  async function visit(current: string, root = false): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch (error) {
      if (!root && (error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      if (total > stopAfterBytes) return;
      const entryPath = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await visit(entryPath);
      else if (entry.isFile()) total += (await fs.stat(entryPath)).size;
    }
  }
  await visit(directory, true);
  return total;
}

export type ResourceQuotaDependencies = {
  database: PrismaClient;
  workspaceRoot: string;
  stopWorkspace(containerId: string): Promise<void>;
  cancelAgent(containerId: string, taskId: string): Promise<void>;
};

export type ResourceQuotaResult = {
  workspaces: number;
  agents: number;
  orchestrations: number;
  setupJobs: number;
  errors: number;
};

export async function enforceResourceQuotas(deps: ResourceQuotaDependencies, at = new Date()): Promise<ResourceQuotaResult> {
  const result: ResourceQuotaResult = { workspaces: 0, agents: 0, orchestrations: 0, setupJobs: 0, errors: 0 };
  const workspaces = await deps.database.workspace.findMany({
    where: { status: 'RUNNING', containerId: { not: null } },
    select: { id: true, containerId: true, diskMb: true, maxRuntimeMinutes: true, runtimeStartedAt: true }
  });

  for (const workspace of workspaces) {
    try {
      const diskLimitBytes = workspace.diskMb * 1024 * 1024;
      let usedBytes: number | null = null;
      try {
        usedBytes = await directorySizeBytes(path.join(deps.workspaceRoot, workspace.id), diskLimitBytes);
      } catch {
        // A running workspace whose bind mount cannot be measured must fail closed; otherwise a
        // permission/mount regression silently turns the persisted disk ceiling into no ceiling.
      }
      const code = usedBytes === null
        ? QUOTA_CODES.workspaceDiskUnavailable
        : usedBytes > diskLimitBytes
        ? QUOTA_CODES.workspaceDisk
        : deadlineExceeded(workspace.runtimeStartedAt, workspace.maxRuntimeMinutes * 60, at)
          ? QUOTA_CODES.workspaceDuration
          : null;
      if (!code || !workspace.containerId) continue;
      await deps.stopWorkspace(workspace.containerId);
      const won = await deps.database.$transaction(async tx => {
        const claimed = await tx.workspace.updateMany({
          where: { id: workspace.id, status: 'RUNNING' },
          data: { status: 'ERROR', runtimeStartedAt: null, quotaViolation: code, quotaExceededAt: at }
        });
        if (claimed.count === 0) return false;
        await tx.agentTask.updateMany({ where: { workspaceId: workspace.id, status: 'RUNNING' }, data: { status: 'FAILED', finishedAt: at, exitCode: 124, metadata: { quotaViolation: code } } });
        await tx.agentRun.updateMany({ where: { workspaceId: workspace.id, finishedAt: null }, data: { finishedAt: at, exitCode: 124 } });
        await tx.orchestrationStep.updateMany({ where: { orchestration: { workspaceId: workspace.id }, status: { in: ['BLOCKED', 'QUEUED', 'RUNNING'] } }, data: { status: 'FAILED', finishedAt: at, exitCode: 124, output: code } });
        await tx.orchestration.updateMany({ where: { workspaceId: workspace.id, status: { in: ['QUEUED', 'RUNNING'] } }, data: { status: 'FAILED', finishedAt: at } });
        await tx.setupJob.updateMany({ where: { workspaceId: workspace.id, status: { in: ['QUEUED', 'RUNNING', 'CANCEL_REQUESTED'] } }, data: { status: 'FAILED', stage: 'FAILED', errorCode: code, errorMessage: code, message: 'Resource quota exceeded', finishedAt: at, heartbeatAt: at } });
        return true;
      });
      if (won) result.workspaces += 1;
    } catch {
      result.errors += 1;
    }
  }

  const agents = await deps.database.agentTask.findMany({
    where: { status: 'RUNNING', startedAt: { not: null }, workspace: { containerId: { not: null }, status: 'RUNNING' } },
    select: { id: true, startedAt: true, maxDurationSeconds: true, workspace: { select: { containerId: true } }, orchestrationStep: { select: { id: true, orchestrationId: true } } }
  });
  for (const task of agents) {
    if (!deadlineExceeded(task.startedAt, task.maxDurationSeconds, at) || !task.workspace.containerId) continue;
    try {
      await deps.cancelAgent(task.workspace.containerId, task.id);
      const won = await deps.database.$transaction(async tx => {
        const claimed = await tx.agentTask.updateMany({ where: { id: task.id, status: 'RUNNING' }, data: { status: 'FAILED', finishedAt: at, exitCode: 124, metadata: { quotaViolation: QUOTA_CODES.agentDuration } } });
        if (claimed.count === 0) return false;
        await tx.agentRun.updateMany({ where: { taskId: task.id, finishedAt: null }, data: { finishedAt: at, exitCode: 124 } });
        if (task.orchestrationStep) {
          await tx.orchestrationStep.updateMany({ where: { id: task.orchestrationStep.id, status: 'RUNNING', agentTaskId: task.id }, data: { status: 'FAILED', finishedAt: at, exitCode: 124, output: QUOTA_CODES.agentDuration } });
          await tx.orchestration.updateMany({ where: { id: task.orchestrationStep.orchestrationId, status: { in: ['QUEUED', 'RUNNING'] } }, data: { status: 'FAILED', finishedAt: at } });
        }
        return true;
      });
      if (won) result.agents += 1;
    } catch {
      result.errors += 1;
    }
  }

  const orchestrations = await deps.database.orchestration.findMany({
    where: { status: 'RUNNING', startedAt: { not: null }, workspace: { containerId: { not: null }, status: 'RUNNING' } },
    select: { id: true, startedAt: true, maxDurationSeconds: true, workspace: { select: { containerId: true } }, steps: { where: { agentTask: { status: 'RUNNING' } }, select: { agentTaskId: true } } }
  });
  for (const orchestration of orchestrations) {
    if (!deadlineExceeded(orchestration.startedAt, orchestration.maxDurationSeconds, at) || !orchestration.workspace.containerId) continue;
    try {
      await Promise.all(orchestration.steps.flatMap(step => step.agentTaskId ? [deps.cancelAgent(orchestration.workspace.containerId!, step.agentTaskId)] : []));
      const won = await deps.database.$transaction(async tx => {
        const claimed = await tx.orchestration.updateMany({ where: { id: orchestration.id, status: 'RUNNING' }, data: { status: 'FAILED', finishedAt: at } });
        if (claimed.count === 0) return false;
        const tasks = await tx.orchestrationStep.findMany({ where: { orchestrationId: orchestration.id, agentTaskId: { not: null } }, select: { agentTaskId: true } });
        const taskIds = tasks.flatMap(task => task.agentTaskId ? [task.agentTaskId] : []);
        if (taskIds.length) {
          await tx.agentTask.updateMany({ where: { id: { in: taskIds }, status: 'RUNNING' }, data: { status: 'FAILED', finishedAt: at, exitCode: 124, metadata: { quotaViolation: QUOTA_CODES.orchestrationDuration } } });
          await tx.agentRun.updateMany({ where: { taskId: { in: taskIds }, finishedAt: null }, data: { finishedAt: at, exitCode: 124 } });
        }
        await tx.orchestrationStep.updateMany({ where: { orchestrationId: orchestration.id, status: { in: ['BLOCKED', 'QUEUED', 'RUNNING'] } }, data: { status: 'FAILED', finishedAt: at, exitCode: 124, output: QUOTA_CODES.orchestrationDuration } });
        return true;
      });
      if (won) result.orchestrations += 1;
    } catch {
      result.errors += 1;
    }
  }

  const setupJobs = await deps.database.setupJob.findMany({ where: { status: 'RUNNING', startedAt: { not: null } }, select: { id: true, startedAt: true, maxDurationSeconds: true } });
  for (const job of setupJobs) {
    if (!deadlineExceeded(job.startedAt, job.maxDurationSeconds, at)) continue;
    try {
      const failed = await deps.database.setupJob.updateMany({ where: { id: job.id, status: 'RUNNING' }, data: { status: 'FAILED', stage: 'FAILED', errorCode: QUOTA_CODES.setupDuration, errorMessage: QUOTA_CODES.setupDuration, message: 'Job duration quota exceeded', finishedAt: at, heartbeatAt: at } });
      if (failed.count > 0) {
        await deps.database.setupJobLog.create({ data: { setupJobId: job.id, stage: 'FAILED', level: 'WARN', message: QUOTA_CODES.setupDuration } });
        result.setupJobs += 1;
      }
    } catch {
      result.errors += 1;
    }
  }
  return result;
}
