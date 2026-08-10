import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AgentReviewStatus, AgentTaskStatus, AgentType, prisma, Role } from '@oliveira/database';
import { DockerAgentEngine } from '@oliveira/agent-engine';
import { DockerGitIsolationEngine } from '@oliveira/git-engine';
import { requireOrgRole } from '../lib/auth.js';
import { audit } from '../lib/audit.js';

const engine = new DockerAgentEngine();
const git = new DockerGitIsolationEngine();

async function loadTask(request: FastifyRequest, taskId: string) {
  const task = await prisma.agentTask.findUnique({
    where: { id: taskId },
    include: { workspace: { include: { project: true } }, runs: { orderBy: { startedAt: 'desc' }, take: 1 } }
  });
  if (!task) throw Object.assign(new Error('AGENT_TASK_NOT_FOUND'), { statusCode: 404 });
  const auth = await requireOrgRole(request, task.workspace.project.organizationId, Role.DEVELOPER);
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
      startNow: z.boolean().default(true)
    }).parse(request.body);

    const workspace = await prisma.workspace.findUnique({ where: { id: body.workspaceId }, include: { project: true } });
    if (!workspace) throw Object.assign(new Error('WORKSPACE_NOT_FOUND'), { statusCode: 404 });
    const { user } = await requireOrgRole(request, workspace.project.organizationId, Role.DEVELOPER);
    if (!workspace.containerId) throw Object.assign(new Error('WORKSPACE_HAS_NO_CONTAINER'), { statusCode: 409 });

    const task = await prisma.agentTask.create({
      data: { workspaceId: workspace.id, agent: body.agent, title: body.title, prompt: body.prompt, status: AgentTaskStatus.QUEUED }
    });
    await audit({ userId: user.id, organizationId: workspace.project.organizationId, action: 'AGENT_TASK_CREATED', resource: 'AgentTask', resourceId: task.id, ipAddress: request.ip, metadata: { agent: body.agent } });
    if (!body.startNow) return reply.code(201).send(task);

    try {
      const worktree = await git.createWorktree(workspace.containerId, task.id, task.agent);
      const runtime = await engine.start({
        containerId: workspace.containerId,
        taskId: task.id,
        agent: task.agent,
        prompt: task.prompt,
        workingDirectory: worktree.path
      });
      const [updated] = await prisma.$transaction([
        prisma.agentTask.update({
          where: { id: task.id },
          data: {
            status: AgentTaskStatus.RUNNING,
            startedAt: new Date(),
            branchName: worktree.branchName,
            worktreePath: worktree.path,
            baseCommit: worktree.baseCommit,
            reviewStatus: AgentReviewStatus.PENDING
          }
        }),
        prisma.agentRun.create({ data: { taskId: task.id, workspaceId: workspace.id, sessionName: runtime.sessionName, statusFile: runtime.statusFile } })
      ]);
      await audit({ userId: user.id, organizationId: workspace.project.organizationId, action: 'AGENT_STARTED_ISOLATED', resource: 'AgentTask', resourceId: task.id, ipAddress: request.ip, metadata: { agent: task.agent, branchName: worktree.branchName } });
      return reply.code(201).send(updated);
    } catch (error) {
      await prisma.agentTask.update({ where: { id: task.id }, data: { status: AgentTaskStatus.FAILED, finishedAt: new Date(), metadata: { startError: error instanceof Error ? error.message : 'UNKNOWN' } } });
      throw error;
    }
  });

  app.post('/:taskId/start', async request => {
    const { taskId } = request.params as { taskId: string };
    const { task, user } = await loadTask(request, taskId);
    if (!task.workspace.containerId) throw Object.assign(new Error('WORKSPACE_HAS_NO_CONTAINER'), { statusCode: 409 });
    if (task.status === AgentTaskStatus.RUNNING) throw Object.assign(new Error('AGENT_ALREADY_RUNNING'), { statusCode: 409 });
    if (task.reviewStatus === AgentReviewStatus.MERGED || task.reviewStatus === AgentReviewStatus.REJECTED) throw Object.assign(new Error('AGENT_TASK_ALREADY_REVIEWED'), { statusCode: 409 });

    const worktree = task.worktreePath && task.branchName && task.baseCommit
      ? { path: task.worktreePath, branchName: task.branchName, baseCommit: task.baseCommit }
      : await git.createWorktree(task.workspace.containerId, task.id, task.agent);

    const runtime = await engine.start({ containerId: task.workspace.containerId, taskId: task.id, agent: task.agent, prompt: task.prompt, workingDirectory: worktree.path });
    await prisma.$transaction([
      prisma.agentTask.update({ where: { id: task.id }, data: { status: AgentTaskStatus.RUNNING, startedAt: new Date(), finishedAt: null, exitCode: null, branchName: worktree.branchName, worktreePath: worktree.path, baseCommit: worktree.baseCommit, reviewStatus: AgentReviewStatus.PENDING } }),
      prisma.agentRun.create({ data: { taskId: task.id, workspaceId: task.workspaceId, sessionName: runtime.sessionName, statusFile: runtime.statusFile } })
    ]);
    await audit({ userId: user.id, organizationId: task.workspace.project.organizationId, action: 'AGENT_STARTED_ISOLATED', resource: 'AgentTask', resourceId: task.id, ipAddress: request.ip, metadata: { branchName: worktree.branchName } });
    return { ok: true, worktree };
  });

  app.get('/:taskId/status', async request => {
    const { taskId } = request.params as { taskId: string };
    const { task } = await loadTask(request, taskId);
    if (!task.workspace.containerId) throw Object.assign(new Error('WORKSPACE_HAS_NO_CONTAINER'), { statusCode: 409 });
    if (task.status !== AgentTaskStatus.RUNNING) return task;
    const runtime = await engine.status(task.workspace.containerId, task.id);
    if (runtime.status === 'RUNNING' || runtime.status === 'UNKNOWN') return { ...task, runtime };
    const status = runtime.status === 'COMPLETED' ? AgentTaskStatus.COMPLETED : AgentTaskStatus.FAILED;
    const updated = await prisma.agentTask.update({ where: { id: task.id }, data: { status, exitCode: runtime.exitCode, finishedAt: new Date(), reviewStatus: AgentReviewStatus.READY } });
    const latestRun = task.runs[0];
    if (latestRun) await prisma.agentRun.update({ where: { id: latestRun.id }, data: { exitCode: runtime.exitCode, finishedAt: new Date() } });
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
    const { task, user } = await loadTask(request, taskId);
    if (!task.workspace.containerId) throw Object.assign(new Error('WORKSPACE_HAS_NO_CONTAINER'), { statusCode: 409 });
    if (task.status === AgentTaskStatus.RUNNING) throw Object.assign(new Error('STOP_AGENT_BEFORE_MERGE'), { statusCode: 409 });
    if (task.reviewStatus === AgentReviewStatus.MERGED) return { ok: true, mergeCommit: task.mergeCommit, alreadyMerged: true };
    if (task.reviewStatus === AgentReviewStatus.REJECTED) throw Object.assign(new Error('AGENT_TASK_REJECTED'), { statusCode: 409 });

    const worktree = requireWorktree(task);
    const result = await git.merge(task.workspace.containerId, worktree, task.id);
    await git.cleanup(task.workspace.containerId, worktree, true);
    const now = new Date();
    await prisma.agentTask.update({ where: { id: task.id }, data: { reviewStatus: AgentReviewStatus.MERGED, mergeCommit: result.mergeCommit, mergedAt: now } });
    await audit({ userId: user.id, organizationId: task.workspace.project.organizationId, action: 'AGENT_CHANGES_MERGED', resource: 'AgentTask', resourceId: task.id, ipAddress: request.ip, metadata: { branchName: task.branchName, mergeCommit: result.mergeCommit } });
    return { ok: true, mergeCommit: result.mergeCommit };
  });

  app.post('/:taskId/reject', async request => {
    const { taskId } = request.params as { taskId: string };
    const { task, user } = await loadTask(request, taskId);
    if (!task.workspace.containerId) throw Object.assign(new Error('WORKSPACE_HAS_NO_CONTAINER'), { statusCode: 409 });
    if (task.status === AgentTaskStatus.RUNNING) throw Object.assign(new Error('STOP_AGENT_BEFORE_REJECT'), { statusCode: 409 });
    if (task.reviewStatus === AgentReviewStatus.MERGED) throw Object.assign(new Error('AGENT_TASK_ALREADY_MERGED'), { statusCode: 409 });
    if (task.reviewStatus !== AgentReviewStatus.REJECTED && task.worktreePath && task.branchName && task.baseCommit) {
      await git.cleanup(task.workspace.containerId, requireWorktree(task), true);
    }
    await prisma.agentTask.update({ where: { id: task.id }, data: { reviewStatus: AgentReviewStatus.REJECTED, rejectedAt: new Date() } });
    await audit({ userId: user.id, organizationId: task.workspace.project.organizationId, action: 'AGENT_CHANGES_REJECTED', resource: 'AgentTask', resourceId: task.id, ipAddress: request.ip, metadata: { branchName: task.branchName } });
    return { ok: true };
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
    const step = await prisma.orchestrationStep.findUnique({ where: { agentTaskId: task.id } });
    const latestRun = task.runs[0];
    await prisma.$transaction([
      ...(step && step.status === 'RUNNING'
        ? [
            prisma.orchestrationStep.update({ where: { id: step.id }, data: { status: 'CANCELLED', finishedAt: now } }),
            prisma.orchestration.update({ where: { id: step.orchestrationId }, data: { status: 'CANCELLED', finishedAt: now } })
          ]
        : []),
      prisma.agentTask.update({ where: { id: task.id }, data: { status: AgentTaskStatus.CANCELLED, finishedAt: now, reviewStatus: AgentReviewStatus.READY } }),
      ...(latestRun
        ? [prisma.agentRun.update({ where: { id: latestRun.id }, data: { cancelledAt: now, finishedAt: now } })]
        : [])
    ]);
    await audit({ userId: user.id, organizationId: task.workspace.project.organizationId, action: 'AGENT_CANCELLED', resource: 'AgentTask', resourceId: task.id, ipAddress: request.ip });
    return { ok: true };
  });
}
