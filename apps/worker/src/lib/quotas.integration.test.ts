import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { prisma } from '@oliveira/database';
import { enforceResourceQuotas, QUOTA_CODES } from './quotas.js';

const createdOrganizationIds: string[] = [];
const temporaryRoots: string[] = [];

beforeAll(async () => {
  await prisma.$connect();
});

afterEach(async () => {
  while (createdOrganizationIds.length) await prisma.organization.delete({ where: { id: createdOrganizationIds.pop()! } }).catch(() => undefined);
  while (temporaryRoots.length) await fs.rm(temporaryRoots.pop()!, { recursive: true, force: true });
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function createWorkspace(overrides: { diskMb?: number; runtimeStartedAt?: Date; maxRuntimeMinutes?: number } = {}) {
  const suffix = crypto.randomUUID();
  const organization = await prisma.organization.create({ data: { name: 'Quota test', slug: `quota-${suffix}` } });
  createdOrganizationIds.push(organization.id);
  const project = await prisma.project.create({ data: { organizationId: organization.id, name: 'Quota project', slug: 'quota-project' } });
  const workspace = await prisma.workspace.create({ data: {
    projectId: project.id,
    containerId: `container-${suffix}`,
    status: 'RUNNING',
    diskMb: overrides.diskMb ?? 100,
    runtimeStartedAt: overrides.runtimeStartedAt ?? new Date(),
    maxRuntimeMinutes: overrides.maxRuntimeMinutes ?? 480
  } });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'odc-quota-db-'));
  temporaryRoots.push(root);
  await fs.mkdir(path.join(root, workspace.id), { recursive: true });
  return { organization, project, workspace, root };
}

describe('resource quota reconciliation — real PostgreSQL and filesystem', () => {
  it('stops an over-disk workspace and atomically fails all active work owned by it', async () => {
    const fixture = await createWorkspace({ diskMb: 1 });
    await fs.writeFile(path.join(fixture.root, fixture.workspace.id, 'oversized.bin'), Buffer.alloc(1024 * 1024 + 1));
    const orchestration = await prisma.orchestration.create({ data: { workspaceId: fixture.workspace.id, title: 'Quota orchestration', objective: 'Must stop', status: 'RUNNING', startedAt: new Date() } });
    const task = await prisma.agentTask.create({ data: { workspaceId: fixture.workspace.id, agent: 'CODEX', title: 'Quota agent', prompt: 'Must stop', status: 'RUNNING', startedAt: new Date() } });
    const step = await prisma.orchestrationStep.create({ data: { orchestrationId: orchestration.id, key: 'agent', title: 'Agent', type: 'AGENT', status: 'RUNNING', agent: 'CODEX', prompt: 'Must stop', agentTaskId: task.id, startedAt: new Date() } });
    const setup = await prisma.setupJob.create({ data: { workspaceId: fixture.workspace.id, organizationId: fixture.organization.id, status: 'RUNNING', stage: 'INSTALLING_DEPS', startedAt: new Date() } });
    const stopWorkspace = vi.fn(async () => undefined);

    const result = await enforceResourceQuotas({ database: prisma, workspaceRoot: fixture.root, stopWorkspace, cancelAgent: async () => undefined });

    expect(stopWorkspace).toHaveBeenCalledWith(fixture.workspace.containerId);
    expect(await prisma.workspace.findUniqueOrThrow({ where: { id: fixture.workspace.id } })).toMatchObject({ status: 'ERROR', quotaViolation: QUOTA_CODES.workspaceDisk });
    expect(await prisma.agentTask.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({ status: 'FAILED', exitCode: 124 });
    expect(await prisma.orchestrationStep.findUniqueOrThrow({ where: { id: step.id } })).toMatchObject({ status: 'FAILED', output: QUOTA_CODES.workspaceDisk });
    expect((await prisma.orchestration.findUniqueOrThrow({ where: { id: orchestration.id } })).status).toBe('FAILED');
    expect(await prisma.setupJob.findUniqueOrThrow({ where: { id: setup.id } })).toMatchObject({ status: 'FAILED', errorCode: QUOTA_CODES.workspaceDisk });
    expect(result.workspaces).toBe(1);
  });

  it('cancels only the expired agent and preserves its still-running workspace', async () => {
    const at = new Date();
    const fixture = await createWorkspace();
    const task = await prisma.agentTask.create({ data: { workspaceId: fixture.workspace.id, agent: 'CLAUDE', title: 'Timed agent', prompt: 'Time out', status: 'RUNNING', startedAt: new Date(at.getTime() - 61_000), maxDurationSeconds: 60 } });
    const cancelAgent = vi.fn(async () => undefined);

    const result = await enforceResourceQuotas({ database: prisma, workspaceRoot: fixture.root, stopWorkspace: async () => undefined, cancelAgent }, at);

    expect(cancelAgent).toHaveBeenCalledWith(fixture.workspace.containerId, task.id);
    expect(await prisma.agentTask.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({ status: 'FAILED', exitCode: 124, metadata: { quotaViolation: QUOTA_CODES.agentDuration } });
    expect((await prisma.workspace.findUniqueOrThrow({ where: { id: fixture.workspace.id } })).status).toBe('RUNNING');
    expect(result.agents).toBe(1);
  });

  it('closes expired orchestration and setup deadlines without reviving terminal state', async () => {
    const at = new Date();
    const fixture = await createWorkspace();
    const orchestration = await prisma.orchestration.create({ data: { workspaceId: fixture.workspace.id, title: 'Timed orchestration', objective: 'Time out', status: 'RUNNING', startedAt: new Date(at.getTime() - 61_000), maxDurationSeconds: 60 } });
    const task = await prisma.agentTask.create({ data: { workspaceId: fixture.workspace.id, agent: 'CODEX', title: 'Child', prompt: 'Child', status: 'RUNNING', startedAt: at, maxDurationSeconds: 3600 } });
    await prisma.orchestrationStep.create({ data: { orchestrationId: orchestration.id, key: 'child', title: 'Child', type: 'AGENT', status: 'RUNNING', agent: 'CODEX', prompt: 'Child', agentTaskId: task.id, startedAt: at } });
    const setup = await prisma.setupJob.create({ data: { workspaceId: fixture.workspace.id, organizationId: fixture.organization.id, status: 'RUNNING', stage: 'INSTALLING_DEPS', startedAt: new Date(at.getTime() - 61_000), maxDurationSeconds: 60 } });

    const result = await enforceResourceQuotas({ database: prisma, workspaceRoot: fixture.root, stopWorkspace: async () => undefined, cancelAgent: async () => undefined }, at);

    expect((await prisma.orchestration.findUniqueOrThrow({ where: { id: orchestration.id } })).status).toBe('FAILED');
    expect((await prisma.agentTask.findUniqueOrThrow({ where: { id: task.id } })).status).toBe('FAILED');
    expect(await prisma.setupJob.findUniqueOrThrow({ where: { id: setup.id } })).toMatchObject({ status: 'FAILED', errorCode: QUOTA_CODES.setupDuration });
    expect(result).toMatchObject({ orchestrations: 1, setupJobs: 1, errors: 0 });
  });
});
