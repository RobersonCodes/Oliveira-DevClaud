import crypto from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { prisma } from '@oliveira/database';
import { recoverInterruptedRuntimeJobs } from './recovery.js';
import { createPrismaRuntimeRecoveryDependencies } from './recoveryStore.js';

const createdOrganizationIds: string[] = [];

beforeAll(async () => {
  await prisma.$connect();
});

afterEach(async () => {
  while (createdOrganizationIds.length) {
    await prisma.organization.delete({ where: { id: createdOrganizationIds.pop()! } }).catch(() => undefined);
  }
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function createRuntimeGraph(at: Date) {
  const suffix = crypto.randomUUID();
  const organization = await prisma.organization.create({
    data: { name: 'Recovery test', slug: `recovery-${suffix}` }
  });
  createdOrganizationIds.push(organization.id);
  const project = await prisma.project.create({
    data: { organizationId: organization.id, name: 'Recovery project', slug: 'recovery-project' }
  });
  const workspace = await prisma.workspace.create({
    data: { projectId: project.id, status: 'RUNNING', containerId: `container-${suffix}` }
  });
  const orchestration = await prisma.orchestration.create({
    data: {
      workspaceId: workspace.id,
      title: 'Interrupted orchestration',
      objective: 'Recover exactly once',
      status: 'RUNNING',
      startedAt: new Date(at.getTime() - 180_000),
      heartbeatAt: new Date(at.getTime() - 120_000)
    }
  });
  const task = await prisma.agentTask.create({
    data: {
      workspaceId: workspace.id,
      agent: 'CODEX',
      title: 'Interrupted agent',
      prompt: 'Recover me',
      status: 'RUNNING',
      startedAt: new Date(at.getTime() - 180_000),
      heartbeatAt: new Date(at.getTime() - 120_000)
    }
  });
  const step = await prisma.orchestrationStep.create({
    data: {
      orchestrationId: orchestration.id,
      key: 'agent-step',
      title: 'Agent step',
      type: 'AGENT',
      status: 'RUNNING',
      agent: 'CODEX',
      prompt: 'Recover me',
      agentTaskId: task.id,
      startedAt: new Date(at.getTime() - 180_000)
    }
  });
  const run = await prisma.agentRun.create({
    data: {
      taskId: task.id,
      workspaceId: workspace.id,
      sessionName: `odc-agent-${task.id}`.slice(0, 64),
      statusFile: `/tmp/odc-agent-${task.id}.status`
    }
  });
  return { organization, project, workspace, orchestration, task, step, run };
}

describe('runtime recovery store — real PostgreSQL', () => {
  it('reconciles a completed runtime and resumes its orchestration', async () => {
    const at = new Date();
    const graph = await createRuntimeGraph(at);
    const enqueueOrchestration = vi.fn(async () => undefined);
    const result = await recoverInterruptedRuntimeJobs(createPrismaRuntimeRecoveryDependencies({
      database: prisma,
      inspectAgent: async () => ({ status: 'COMPLETED', exitCode: 0 }),
      enqueueOrchestration
    }), { at });

    const [task, step, orchestration, run] = await Promise.all([
      prisma.agentTask.findUniqueOrThrow({ where: { id: graph.task.id } }),
      prisma.orchestrationStep.findUniqueOrThrow({ where: { id: graph.step.id } }),
      prisma.orchestration.findUniqueOrThrow({ where: { id: graph.orchestration.id } }),
      prisma.agentRun.findUniqueOrThrow({ where: { id: graph.run.id } })
    ]);
    expect(task).toMatchObject({ status: 'COMPLETED', exitCode: 0, reviewStatus: 'READY' });
    expect(step).toMatchObject({ status: 'COMPLETED', exitCode: 0 });
    expect(orchestration.status).toBe('RUNNING');
    expect(orchestration.heartbeatAt).toEqual(at);
    expect(run).toMatchObject({ exitCode: 0, finishedAt: at });
    expect(enqueueOrchestration).toHaveBeenCalledOnce();
    expect(result.completedAgents).toBe(1);
  });

  it('fails the task, step and orchestration when the stale runtime is gone', async () => {
    const at = new Date();
    const graph = await createRuntimeGraph(at);
    const result = await recoverInterruptedRuntimeJobs(createPrismaRuntimeRecoveryDependencies({
      database: prisma,
      inspectAgent: async () => ({ status: 'UNKNOWN' }),
      enqueueOrchestration: async () => undefined
    }), { at });

    const [task, step, orchestration] = await Promise.all([
      prisma.agentTask.findUniqueOrThrow({ where: { id: graph.task.id } }),
      prisma.orchestrationStep.findUniqueOrThrow({ where: { id: graph.step.id } }),
      prisma.orchestration.findUniqueOrThrow({ where: { id: graph.orchestration.id } })
    ]);
    expect(task.status).toBe('FAILED');
    expect(step).toMatchObject({ status: 'FAILED', output: 'Agent runtime was lost after its heartbeat expired' });
    expect(orchestration.status).toBe('FAILED');
    expect(result.failedAgents).toBe(1);
  });

  it('allows only one worker to claim and enqueue a stale orchestration', async () => {
    const at = new Date();
    const graph = await createRuntimeGraph(at);
    await prisma.agentTask.update({ where: { id: graph.task.id }, data: { status: 'COMPLETED', finishedAt: at } });
    await prisma.orchestrationStep.update({ where: { id: graph.step.id }, data: { status: 'COMPLETED', finishedAt: at } });
    const enqueueOrchestration = vi.fn(async () => undefined);
    const createDependencies = () => createPrismaRuntimeRecoveryDependencies({
      database: prisma,
      inspectAgent: async () => ({ status: 'UNKNOWN' }),
      enqueueOrchestration
    });

    const results = await Promise.all([
      recoverInterruptedRuntimeJobs(createDependencies(), { at }),
      recoverInterruptedRuntimeJobs(createDependencies(), { at })
    ]);

    expect(enqueueOrchestration).toHaveBeenCalledTimes(1);
    expect(results.reduce((sum, result) => sum + result.orchestrations, 0)).toBe(1);
    expect((await prisma.orchestration.findUniqueOrThrow({ where: { id: graph.orchestration.id } })).heartbeatAt).toEqual(at);
  });

  it('preserves a concurrent cancellation instead of reviving a terminal state', async () => {
    const at = new Date();
    const graph = await createRuntimeGraph(at);
    const enqueueOrchestration = vi.fn(async () => undefined);
    const result = await recoverInterruptedRuntimeJobs(createPrismaRuntimeRecoveryDependencies({
      database: prisma,
      inspectAgent: async () => {
        await prisma.$transaction(async tx => {
          await tx.agentTask.update({ where: { id: graph.task.id }, data: { status: 'CANCELLED', finishedAt: at } });
          await tx.orchestrationStep.update({ where: { id: graph.step.id }, data: { status: 'CANCELLED', finishedAt: at } });
          await tx.orchestration.update({ where: { id: graph.orchestration.id }, data: { status: 'CANCELLED', finishedAt: at } });
        });
        return { status: 'COMPLETED', exitCode: 0 };
      },
      enqueueOrchestration
    }), { at });

    const [task, step, orchestration] = await Promise.all([
      prisma.agentTask.findUniqueOrThrow({ where: { id: graph.task.id } }),
      prisma.orchestrationStep.findUniqueOrThrow({ where: { id: graph.step.id } }),
      prisma.orchestration.findUniqueOrThrow({ where: { id: graph.orchestration.id } })
    ]);
    expect(task.status).toBe('CANCELLED');
    expect(step.status).toBe('CANCELLED');
    expect(orchestration.status).toBe('CANCELLED');
    expect(enqueueOrchestration).not.toHaveBeenCalled();
    expect(result.racesLost).toBe(1);
  });
});
