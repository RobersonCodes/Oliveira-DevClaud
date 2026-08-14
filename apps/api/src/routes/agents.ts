import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AgentReviewStatus, AgentTaskStatus, AgentType, prisma, Role } from '@oliveira/database';
import { DockerAgentEngine } from '@oliveira/agent-engine';
import { DockerGitIsolationEngine } from '@oliveira/git-engine';
import { requireOrgRole } from '../lib/auth.js';
import { audit } from '../lib/audit.js';

const engine = new DockerAgentEngine();
const git = new DockerGitIsolationEngine();

async function loadTask(request: FastifyRequest, taskId: string, required: Role = Role.DEVELOPER) {
  const task = await prisma.agentTask.findUnique({
    where: { id: taskId },
    include: { workspace: { include: { project: true } }, runs: { orderBy: { startedAt: 'desc' }, take: 1 } }
  });
  if (!task) throw Object.assign(new Error('AGENT_TASK_NOT_FOUND'), { statusCode: 404 });
  const auth = await requireOrgRole(request, task.workspace.project.organizationId, required);
  return { task, ...auth };
}

function requireWorktree(task: { branchName: string | null; worktreePath: string | null; baseCommit: string | null }) {
  if (!task.branchName || !task.worktreePath || !task.baseCommit) {
    throw Object.assign(new Error('AGENT_WORKTREE_NOT_READY'), { statusCode: 409 });
  }
  return { branchName: task.branchName, path: task.worktreePath, baseCommit: task.baseCommit };
}

export async function agentRoutes(app: FastifyInstance) {
  app.get('/', async request => {
    const query = z.object({ workspaceId: z.string().cuid() }).parse(request.query);
    const workspace = await prisma.workspace.findUnique({ where: { id: query.workspaceId }, include: { project: true } });
    if (!workspace) throw Object.assign(new Error('WORKSPACE_NOT_FOUND'), { statusCode: 404 });
    await requireOrgRole(request, workspace.project.organizationId, Role.DEVELOPER);
    return prisma.agentTask.findMany({
      where: { workspaceId: workspace.id },
      include: { runs: { orderBy: { startedAt: 'desc' }, take: 1 } },
      orderBy: { id: 'desc' }
    });
  });

  app.post('/', async (request, reply) => {
    const body = z.object({
      workspaceId: z.string().cuid(),
      agent: z.nativeEnum(AgentType),
      title: z.string().trim().min(3).max(120),
      prompt: z.string().trim().min(3).max(30000),
      maxDurationSeconds: z.number().int().min(60).max(14400).default(3600),
      startNow: z.boolean().default(true)
    }).parse(request.body);

    const workspace = await prisma.workspace.findUnique({ where: { id: body.workspaceId }, include: { project: true } });
    if (!workspace) throw Object.assign(new Error('WORKSPACE_NOT_FOUND'), { statusCode: 404 });
    const { user } = await requireOrgRole(request, workspace.project.organizationId, Role.DEVELOPER);
    if (!workspace.containerId) throw Object.assign(new Error('WORKSPACE_HAS_NO_CONTAINER'), { statusCode: 409 });

    const task = await prisma.agentTask.create({
      data: { workspaceId: workspace.id, agent: body.agent, title: body.title, prompt: body.prompt, maxDurationSeconds: body.maxDurationSeconds, status: AgentTaskStatus.QUEUED }
    });
    await audit({ userId: user.id, organizationId: workspace.project.organizationId, action: 'AGENT_TASK_CREATED', resource: 'AgentTask', resourceId: task.id, ipAddress: request.ip, metadata: { agent: body.agent, maxDurationSeconds: body.maxDurationSeconds } });
    if (!body.startNow) return reply.code(201).send(task);

    try {
      const now = new Date();
      const claimed = await prisma.agentTask.updateMany({ where: { id: task.id, status: AgentTaskStatus.QUEUED }, data: { status: AgentTaskStatus.RUNNING, startedAt: now, heartbeatAt: now } });
      if (claimed.count === 0) throw Object.assign(new Error('AGENT_TASK_NOT_STARTABLE'), { statusCode: 409 });
      const worktree = await git.createWorktree(workspace.containerId, task.id, task.agent);
      const runtime = await engine.start({
        containerId: workspace.containerId,
        taskId: task.id,
        agent: task.agent,
        prompt: task.prompt,
        workingDirectory: worktree.path,
        maxDurationSeconds: task.maxDurationSeconds
      });
      const updated = await prisma.$transaction(async tx => {
        const activated = await tx.agentTask.updateMany({
          where: { id: task.id, status: AgentTaskStatus.RUNNING },
          data: {
            branchName: worktree.branchName,
            worktreePath: worktree.path,
            baseCommit: worktree.baseCommit,
            reviewStatus: AgentReviewStatus.PENDING
          }
        });
        if (activated.count === 0) return null;
        await tx.agentRun.create({ data: { taskId: task.id, workspaceId: workspace.id, sessionName: runtime.sessionName, statusFile: runtime.statusFile } });
        return tx.agentTask.findUniqueOrThrow({ where: { id: task.id } });
      });
      if (!updated) {
        await engine.cancel(workspace.containerId, task.id).catch(() => undefined);
        await git.cleanup(workspace.containerId, worktree, true).catch(() => undefined);
        throw Object.assign(new Error('AGENT_START_LOST_RACE'), { statusCode: 409 });
      }
      await audit({ userId: user.id, organizationId: workspace.project.organizationId, action: 'AGENT_STARTED_ISOLATED', resource: 'AgentTask', resourceId: task.id, ipAddress: request.ip, metadata: { agent: task.agent, branchName: worktree.branchName } });
      return reply.code(201).send(updated);
    } catch (error) {
      await prisma.agentTask.updateMany({ where: { id: task.id, status: { in: [AgentTaskStatus.QUEUED, AgentTaskStatus.RUNNING] } }, data: { status: AgentTaskStatus.FAILED, finishedAt: new Date(), metadata: { startError: error instanceof Error ? error.message : 'UNKNOWN' } } });
      throw error;
    }
  });

  app.post('/:taskId/start', async request => {
    const { taskId } = request.params as { taskId: string };
    const { task, user } = await loadTask(request, taskId);
    if (!task.workspace.containerId) throw Object.assign(new Error('WORKSPACE_HAS_NO_CONTAINER'), { statusCode: 409 });
    if (task.status === AgentTaskStatus.RUNNING) throw Object.assign(new Error('AGENT_ALREADY_RUNNING'), { statusCode: 409 });
    if (task.reviewStatus === AgentReviewStatus.MERGED || task.reviewStatus === AgentReviewStatus.REJECTED) throw Object.assign(new Error('AGENT_TASK_ALREADY_REVIEWED'), { statusCode: 409 });

    const now = new Date();
    const claimed = await prisma.agentTask.updateMany({ where: { id: task.id, status: task.status, reviewStatus: task.reviewStatus }, data: { status: AgentTaskStatus.RUNNING, startedAt: now, heartbeatAt: now, finishedAt: null, exitCode: null, reviewStatus: AgentReviewStatus.PENDING } });
    if (claimed.count === 0) throw Object.assign(new Error('AGENT_TASK_NOT_STARTABLE'), { statusCode: 409 });
    let worktree: ReturnType<typeof requireWorktree>;
    try {
      worktree = task.worktreePath && task.branchName && task.baseCommit
        ? { path: task.worktreePath, branchName: task.branchName, baseCommit: task.baseCommit }
        : await git.createWorktree(task.workspace.containerId, task.id, task.agent);
      const runtime = await engine.start({ containerId: task.workspace.containerId, taskId: task.id, agent: task.agent, prompt: task.prompt, workingDirectory: worktree.path, maxDurationSeconds: task.maxDurationSeconds });
      await prisma.$transaction(async tx => {
        const activated = await tx.agentTask.updateMany({ where: { id: task.id, status: AgentTaskStatus.RUNNING }, data: { branchName: worktree.branchName, worktreePath: worktree.path, baseCommit: worktree.baseCommit } });
        if (activated.count === 0) throw Object.assign(new Error('AGENT_START_LOST_RACE'), { statusCode: 409 });
        await tx.agentRun.create({ data: { taskId: task.id, workspaceId: task.workspaceId, sessionName: runtime.sessionName, statusFile: runtime.statusFile } });
      });
    } catch (error) {
      await engine.cancel(task.workspace.containerId, task.id).catch(() => undefined);
      await prisma.agentTask.updateMany({ where: { id: task.id, status: AgentTaskStatus.RUNNING }, data: { status: AgentTaskStatus.FAILED, finishedAt: new Date() } });
      throw error;
    }
    await audit({ userId: user.id, organizationId: task.workspace.project.organizationId, action: 'AGENT_STARTED_ISOLATED', resource: 'AgentTask', resourceId: task.id, ipAddress: request.ip, metadata: { branchName: worktree.branchName } });
    return { ok: true, worktree };
  });

  app.get('/:taskId/status', async request => {
    const { taskId } = request.params as { taskId: string };
    const { task, user } = await loadTask(request, taskId);
    if (!task.workspace.containerId) throw Object.assign(new Error('WORKSPACE_HAS_NO_CONTAINER'), { statusCode: 409 });
    if (task.status !== AgentTaskStatus.RUNNING) return task;
    const runtime = await engine.status(task.workspace.containerId, task.id);
    if (runtime.status === 'RUNNING' || runtime.status === 'UNKNOWN') return { ...task, runtime };
    const status = runtime.status === 'COMPLETED' ? AgentTaskStatus.COMPLETED : AgentTaskStatus.FAILED;
    const reconciled = await prisma.agentTask.updateMany({ where: { id: task.id, status: AgentTaskStatus.RUNNING }, data: { status, exitCode: runtime.exitCode, finishedAt: new Date(), reviewStatus: AgentReviewStatus.READY } });
    if (reconciled.count === 0) return prisma.agentTask.findUniqueOrThrow({ where: { id: task.id } });
    const updated = await prisma.agentTask.findUniqueOrThrow({ where: { id: task.id } });
    const latestRun = task.runs[0];
    if (latestRun) await prisma.agentRun.update({ where: { id: latestRun.id }, data: { exitCode: runtime.exitCode, finishedAt: new Date() } });
    await audit({
      userId: user.id,
      organizationId: task.workspace.project.organizationId,
      action: 'AGENT_STATUS_RECONCILED',
      resource: 'AgentTask',
      resourceId: task.id,
      ipAddress: request.ip,
      metadata: { previousStatus: task.status, status, exitCode: runtime.exitCode }
    });
    return { ...updated, runtime };
  });

  app.get('/:taskId/logs', async request => {
    const { taskId } = request.params as { taskId: string };
    const query = z.object({ lines: z.coerce.number().int().min(20).max(2000).default(300) }).parse(request.query);
    const { task } = await loadTask(request, taskId);
    if (!task.workspace.containerId) throw Object.assign(new Error('WORKSPACE_HAS_NO_CONTAINER'), { statusCode: 409 });
    return { logs: await engine.logs(task.workspace.containerId, task.id, query.lines) };
  });

  app.get('/:taskId/changes', async request => {
    const { taskId } = request.params as { taskId: string };
    const { task } = await loadTask(request, taskId);
    if (!task.workspace.containerId) throw Object.assign(new Error('WORKSPACE_HAS_NO_CONTAINER'), { statusCode: 409 });
    return git.review(task.workspace.containerId, requireWorktree(task));
  });

  app.post('/:taskId/merge', async request => {
    const { taskId } = request.params as { taskId: string };
    const { task, user } = await loadTask(request, taskId, Role.ADMIN);
    if (!task.workspace.containerId) throw Object.assign(new Error('WORKSPACE_HAS_NO_CONTAINER'), { statusCode: 409 });
    if (task.status === AgentTaskStatus.RUNNING) throw Object.assign(new Error('STOP_AGENT_BEFORE_MERGE'), { statusCode: 409 });
    if (task.reviewStatus === AgentReviewStatus.MERGED) return { ok: true, mergeCommit: task.mergeCommit, alreadyMerged: true };
    if (task.reviewStatus === AgentReviewStatus.REJECTED) throw Object.assign(new Error('AGENT_TASK_REJECTED'), { statusCode: 409 });
    const claimed = await prisma.agentTask.updateMany({ where: { id: task.id, reviewStatus: AgentReviewStatus.READY }, data: { reviewStatus: AgentReviewStatus.MERGING } });
    if (claimed.count === 0) {
      const current = await prisma.agentTask.findUnique({ where: { id: task.id }, select: { reviewStatus: true, mergeCommit: true } });
      if (current?.reviewStatus === AgentReviewStatus.MERGED) return { ok: true, mergeCommit: current.mergeCommit, alreadyMerged: true };
      throw Object.assign(new Error('AGENT_REVIEW_NOT_READY'), { statusCode: 409 });
    }

    try {
      const worktree = requireWorktree(task);
      const result = await git.merge(task.workspace.containerId, worktree, task.id);
      await git.cleanup(task.workspace.containerId, worktree, true);
      const now = new Date();
      const merged = await prisma.agentTask.updateMany({ where: { id: task.id, reviewStatus: AgentReviewStatus.MERGING }, data: { reviewStatus: AgentReviewStatus.MERGED, mergeCommit: result.mergeCommit, mergedAt: now } });
      if (merged.count === 0) throw Object.assign(new Error('AGENT_MERGE_LOST_RACE'), { statusCode: 409 });
      await audit({ userId: user.id, organizationId: task.workspace.project.organizationId, action: 'AGENT_CHANGES_MERGED', resource: 'AgentTask', resourceId: task.id, ipAddress: request.ip, metadata: { branchName: task.branchName, mergeCommit: result.mergeCommit } });
      return { ok: true, mergeCommit: result.mergeCommit, alreadyMerged: false };
    } catch (error) {
      await prisma.agentTask.updateMany({ where: { id: task.id, reviewStatus: AgentReviewStatus.MERGING }, data: { reviewStatus: AgentReviewStatus.READY } });
      throw error;
    }
  });

  app.post('/:taskId/reject', async request => {
    const { taskId } = request.params as { taskId: string };
    const { task, user } = await loadTask(request, taskId, Role.ADMIN);
    if (!task.workspace.containerId) throw Object.assign(new Error('WORKSPACE_HAS_NO_CONTAINER'), { statusCode: 409 });
    if (task.status === AgentTaskStatus.RUNNING) throw Object.assign(new Error('STOP_AGENT_BEFORE_REJECT'), { statusCode: 409 });
    if (task.reviewStatus === AgentReviewStatus.MERGED) throw Object.assign(new Error('AGENT_TASK_ALREADY_MERGED'), { statusCode: 409 });
    if (task.reviewStatus === AgentReviewStatus.REJECTED) return { ok: true, alreadyRejected: true };
    const rejected = await prisma.agentTask.updateMany({ where: { id: task.id, reviewStatus: { in: [AgentReviewStatus.PENDING, AgentReviewStatus.READY] } }, data: { reviewStatus: AgentReviewStatus.REJECTED, rejectedAt: new Date() } });
    if (rejected.count === 0) {
      const current = await prisma.agentTask.findUnique({ where: { id: task.id }, select: { reviewStatus: true } });
      if (current?.reviewStatus === AgentReviewStatus.REJECTED) return { ok: true, alreadyRejected: true };
      throw Object.assign(new Error('AGENT_REVIEW_NOT_REJECTABLE'), { statusCode: 409 });
    }
    if (task.worktreePath && task.branchName && task.baseCommit) {
      await git.cleanup(task.workspace.containerId, requireWorktree(task), true);
    }
    await audit({ userId: user.id, organizationId: task.workspace.project.organizationId, action: 'AGENT_CHANGES_REJECTED', resource: 'AgentTask', resourceId: task.id, ipAddress: request.ip, metadata: { branchName: task.branchName } });
    return { ok: true, alreadyRejected: false };
  });

  app.post('/:taskId/cancel', async request => {
    const { taskId } = request.params as { taskId: string };
    const { task, user } = await loadTask(request, taskId);
    if (!task.workspace.containerId) throw Object.assign(new Error('WORKSPACE_HAS_NO_CONTAINER'), { statusCode: 409 });
    await engine.cancel(task.workspace.containerId, task.id).catch(() => undefined);
    const now = new Date();
    // A task started as part of an orchestration DAG has a matching OrchestrationStep; killing the
    // agent's tmux session here without also moving that step out of RUNNING left it stuck forever
    // (the worker's tick() only reconciles COMPLETED/FAILED/UNKNOWN runtimes, and the killed session
    // reports neither — it just stops existing). Cancelling the step, and the orchestration it
    // belongs to, keeps both in sync with the agent actually being stopped.
    //
    // Every write here is a compare-and-swap (`updateMany` guarded by the row's current status),
    // not a blind `update`. A concurrent worker tick() can legitimately complete or fail this exact
    // task/step between our read above and this write; without the guard, this transaction would
    // unconditionally stomp that outcome back to CANCELLED. The task claim gates everything else —
    // if it loses (task is already terminal), we skip the step/orchestration cascade entirely.
    const latestRun = task.runs[0];
    const cancelled = await prisma.$transaction(async tx => {
      const taskClaim = await tx.agentTask.updateMany({
        where: { id: task.id, status: { in: ['QUEUED', 'RUNNING'] } },
        data: { status: AgentTaskStatus.CANCELLED, finishedAt: now, reviewStatus: AgentReviewStatus.READY }
      });
      if (taskClaim.count === 0) return false;

      const step = await tx.orchestrationStep.findUnique({ where: { agentTaskId: task.id } });
      if (step) {
        const stepClaim = await tx.orchestrationStep.updateMany({ where: { id: step.id, status: 'RUNNING' }, data: { status: 'CANCELLED', finishedAt: now } });
        if (stepClaim.count > 0) {
          await tx.orchestration.updateMany({ where: { id: step.orchestrationId, status: { in: ['DRAFT', 'QUEUED', 'RUNNING'] } }, data: { status: 'CANCELLED', finishedAt: now } });
        }
      }
      if (latestRun) await tx.agentRun.update({ where: { id: latestRun.id }, data: { cancelledAt: now, finishedAt: now } });
      return true;
    });
    await audit({ userId: user.id, organizationId: task.workspace.project.organizationId, action: 'AGENT_CANCELLED', resource: 'AgentTask', resourceId: task.id, ipAddress: request.ip, metadata: { alreadyTerminal: !cancelled } });
    return { ok: true };
  });
}
