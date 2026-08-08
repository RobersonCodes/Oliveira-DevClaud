import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma, Role } from '@oliveira/database';
import { OrchestrationQueue, validateDag } from '@oliveira/orchestrator-engine';
import { DockerReviewEngine } from '@oliveira/review-engine';
import { DockerGitIsolationEngine } from '@oliveira/git-engine';
import { requireOrgRole } from '../lib/auth.js';
import { audit } from '../lib/audit.js';
import { getRepositoryIntelligenceCached } from '../lib/repositoryIntelligenceCache.js';
import { getContractIntelligenceCached } from '../lib/contractIntelligenceCache.js';
import { inspectContracts, listContractFiles } from '@oliveira/contract-intelligence';
import { evaluateContractGate } from '@oliveira/contract-gate';

const queue = new OrchestrationQueue();
const reviews = new DockerReviewEngine();
const git = new DockerGitIsolationEngine();
const safeReviewGates = new Set(['npm test','npm run test','npm run build','npm run lint','npm run typecheck']);
const stepSchema = z.object({
  key: z.string().min(1).max(64), title: z.string().min(2).max(160), type: z.enum(['AGENT','SYSTEM']),
  agent: z.enum(['CODEX','CLAUDE']).optional(), prompt: z.string().max(30000).optional(),
  command: z.string().max(1000).optional(), dependsOn: z.array(z.string()).max(20).default([])
});

export async function orchestrationRoutes(app: FastifyInstance) {
  app.get('/', async request => {
    const q = z.object({ workspaceId: z.string().cuid() }).parse(request.query);
    const workspace = await prisma.workspace.findUnique({ where:{id:q.workspaceId}, include:{project:true} });
    if (!workspace) throw Object.assign(new Error('WORKSPACE_NOT_FOUND'),{statusCode:404});
    await requireOrgRole(request, workspace.project.organizationId, Role.DEVELOPER);
    return prisma.orchestration.findMany({ where:{workspaceId:q.workspaceId}, include:{steps:{orderBy:{key:'asc'}}}, orderBy:{createdAt:'desc'} });
  });

  app.post('/', async (request, reply) => {
    const body = z.object({ workspaceId:z.string().cuid(), title:z.string().min(3).max(120), objective:z.string().min(3).max(5000), steps:z.array(stepSchema).min(1).max(30), startNow:z.boolean().default(true) }).parse(request.body);
    validateDag(body.steps);
    const workspace = await prisma.workspace.findUnique({ where:{id:body.workspaceId}, include:{project:true} });
    if (!workspace) throw Object.assign(new Error('WORKSPACE_NOT_FOUND'),{statusCode:404});
    const {user}=await requireOrgRole(request, workspace.project.organizationId, Role.DEVELOPER);
    const orchestration=await prisma.orchestration.create({ data:{workspaceId:body.workspaceId,title:body.title,objective:body.objective,status:body.startNow?'QUEUED':'DRAFT',steps:{create:body.steps.map(s=>({key:s.key,title:s.title,type:s.type,agent:s.agent,prompt:s.prompt,command:s.command,dependsOn:s.dependsOn,status:s.dependsOn.length?'BLOCKED':'QUEUED'}))}},include:{steps:true} });
    await audit({userId:user.id,organizationId:workspace.project.organizationId,action:'ORCHESTRATION_CREATED',resource:'Orchestration',resourceId:orchestration.id,ipAddress:request.ip,metadata:{steps:body.steps.length}});
    if(body.startNow) await queue.tick(orchestration.id);
    return reply.code(201).send(orchestration);
  });

  app.post('/:id/start', async request => {
    const {id}=request.params as {id:string};
    const o=await prisma.orchestration.findUnique({where:{id},include:{workspace:{include:{project:true}}}});
    if(!o) throw Object.assign(new Error('ORCHESTRATION_NOT_FOUND'),{statusCode:404});
    await requireOrgRole(request,o.workspace.project.organizationId,Role.DEVELOPER);
    await prisma.orchestration.update({where:{id},data:{status:'QUEUED'}}); await queue.tick(id); return {ok:true};
  });

  app.post('/:id/cancel', async request => {
    const {id}=request.params as {id:string};
    const o=await prisma.orchestration.findUnique({where:{id},include:{workspace:{include:{project:true}}}});
    if(!o) throw Object.assign(new Error('ORCHESTRATION_NOT_FOUND'),{statusCode:404});
    const {user}=await requireOrgRole(request,o.workspace.project.organizationId,Role.DEVELOPER);
    await prisma.$transaction([prisma.orchestration.update({where:{id},data:{status:'CANCELLED',finishedAt:new Date()}}),prisma.orchestrationStep.updateMany({where:{orchestrationId:id,status:{in:['BLOCKED','QUEUED']}},data:{status:'CANCELLED'}})]);
    await audit({userId:user.id,organizationId:o.workspace.project.organizationId,action:'ORCHESTRATION_CANCELLED',resource:'Orchestration',resourceId:id,ipAddress:request.ip}); return {ok:true};
  });

  app.get('/:id/review', async request => {
    const { id } = request.params as { id: string };
    const o = await prisma.orchestration.findUnique({
      where: { id },
      include: { workspace: { include: { project: true } }, steps: { include: { agentTask: true }, orderBy: { key: 'asc' } } }
    });
    if (!o) throw Object.assign(new Error('ORCHESTRATION_NOT_FOUND'), { statusCode: 404 });
    await requireOrgRole(request, o.workspace.project.organizationId, Role.DEVELOPER);
    return o;
  });

  app.post('/:id/review/analyze', async request => {
    const { id } = request.params as { id: string };
    const o = await prisma.orchestration.findUnique({
      where: { id },
      include: { workspace: { include: { project: true } }, steps: { include: { agentTask: true }, orderBy: { key: 'asc' } } }
    });
    if (!o) throw Object.assign(new Error('ORCHESTRATION_NOT_FOUND'), { statusCode: 404 });
    const { user } = await requireOrgRole(request, o.workspace.project.organizationId, Role.DEVELOPER);
    if (!o.workspace.containerId) throw Object.assign(new Error('WORKSPACE_HAS_NO_CONTAINER'), { statusCode: 409 });
    if (!['WAITING_REVIEW','RUNNING'].includes(o.status)) throw Object.assign(new Error('ORCHESTRATION_NOT_REVIEWABLE'), { statusCode: 409 });

    const agentSteps = o.steps.filter(s => s.type === 'AGENT');
    if (!agentSteps.length || agentSteps.some(s => s.status !== 'COMPLETED' || !s.agentTask?.branchName)) {
      throw Object.assign(new Error('AGENT_STEPS_NOT_READY'), { statusCode: 409 });
    }
    // Capture any uncommitted agent edits before building the integration branch.
    for (const step of agentSteps) {
      const task = step.agentTask!;
      if (!task.worktreePath || !task.baseCommit || !task.branchName) throw Object.assign(new Error('AGENT_WORKTREE_NOT_READY'), { statusCode: 409 });
      await git.snapshot(o.workspace.containerId, { path: task.worktreePath, branchName: task.branchName, baseCommit: task.baseCommit }, task.id);
    }
    const branches = agentSteps.map(s => ({ taskId: s.agentTask!.id, branchName: s.agentTask!.branchName! }));
    const gates = o.steps.filter(s => s.type === 'SYSTEM' && s.command && safeReviewGates.has(s.command)).map(s => s.command!);
    await prisma.orchestration.update({ where: { id }, data: { reviewStatus: 'ANALYZING' } });
    try {
      // Contract baseline is captured from the current main worktree before the integration branch is analyzed.
      const repository = await getRepositoryIntelligenceCached({ workspaceId: o.workspace.id, containerId: o.workspace.containerId });
      const baselineContracts = await getContractIntelligenceCached({ workspaceId: o.workspace.id, containerId: o.workspace.containerId, repository: repository.intelligence });

      const result = await reviews.prepare(o.workspace.containerId, id, branches, gates);
      const gateFailed = result.gates.some(g => !g.ok);
      let contractGate = null;
      if (!result.conflicts.length && !gateFailed) {
        const candidateFiles = await listContractFiles(o.workspace.containerId, result.reviewPath);
        const candidateContracts = await inspectContracts(o.workspace.containerId, candidateFiles, result.reviewPath);
        contractGate = evaluateContractGate(baselineContracts.intelligence, candidateContracts);
      }
      const contractBlocked = contractGate ? !contractGate.ok : false;
      const reviewStatus = result.conflicts.length ? 'CONFLICT' : (gateFailed || contractBlocked) ? 'GATE_FAILED' : 'READY';
      const reviewSummary = { ...result, contractGate, ready: result.ready && !contractBlocked };
      const updated = await prisma.orchestration.update({
        where: { id }, data: {
          reviewStatus, reviewBranch: result.reviewBranch, reviewWorktreePath: result.reviewPath,
          reviewBaseCommit: result.baseCommit, reviewSummary: reviewSummary as any, reviewedAt: new Date(), status: 'WAITING_REVIEW'
        }
      });
      await audit({ userId: user.id, organizationId: o.workspace.project.organizationId, action: 'ORCHESTRATION_REVIEW_ANALYZED', resource: 'Orchestration', resourceId: id, ipAddress: request.ip, metadata: { reviewStatus, conflicts: result.conflicts.length, gates: result.gates.map(g => ({ command:g.command, ok:g.ok, exitCode:g.exitCode })), contractGate: contractGate ? { ok: contractGate.ok, blocking: contractGate.blocking.length, warnings: contractGate.warnings.length } : null } });
      return updated;
    } catch (error) {
      await prisma.orchestration.update({ where: { id }, data: { reviewStatus: 'GATE_FAILED', reviewSummary: { error: error instanceof Error ? error.message : 'UNKNOWN' } } });
      throw error;
    }
  });

  app.post('/:id/review/approve', async request => {
    const { id } = request.params as { id: string };
    const o = await prisma.orchestration.findUnique({
      where: { id }, include: { workspace: { include: { project: true } }, steps: { include: { agentTask: true } } }
    });
    if (!o) throw Object.assign(new Error('ORCHESTRATION_NOT_FOUND'), { statusCode: 404 });
    const { user } = await requireOrgRole(request, o.workspace.project.organizationId, Role.ADMIN);
    if (!o.workspace.containerId) throw Object.assign(new Error('WORKSPACE_HAS_NO_CONTAINER'), { statusCode: 409 });
    if (o.reviewStatus !== 'READY' || !o.reviewBaseCommit) throw Object.assign(new Error('REVIEW_NOT_READY'), { statusCode: 409 });

    await prisma.orchestration.update({ where:{id}, data:{ reviewStatus:'APPROVED', approvedAt:new Date() } });
    const result = await reviews.approve(o.workspace.containerId, id, o.reviewBaseCommit);
    const agentTasks = o.steps.map(s => s.agentTask).filter(Boolean);
    for (const task of agentTasks) {
      if (task!.worktreePath && task!.branchName && task!.baseCommit) {
        await git.cleanup(o.workspace.containerId, { path: task!.worktreePath, branchName: task!.branchName, baseCommit: task!.baseCommit }, true).catch(() => undefined);
      }
    }
    await prisma.$transaction([
      prisma.orchestration.update({ where:{id}, data:{ reviewStatus:'MERGED', status:'COMPLETED', mergeCommit:result.mergeCommit, mergedAt:new Date(), finishedAt:new Date() } }),
      prisma.agentTask.updateMany({ where:{id:{in:agentTasks.map(t=>t!.id)}}, data:{ reviewStatus:'MERGED', mergeCommit:result.mergeCommit, mergedAt:new Date() } })
    ]);
    await audit({ userId:user.id, organizationId:o.workspace.project.organizationId, action:'ORCHESTRATION_REVIEW_APPROVED_AND_MERGED', resource:'Orchestration', resourceId:id, ipAddress:request.ip, metadata:{mergeCommit:result.mergeCommit, agentTasks:agentTasks.length} });
    return { ok:true, mergeCommit:result.mergeCommit };
  });

  app.post('/:id/review/reject', async request => {
    const { id } = request.params as { id: string };
    const o = await prisma.orchestration.findUnique({ where:{id}, include:{workspace:{include:{project:true}}} });
    if(!o) throw Object.assign(new Error('ORCHESTRATION_NOT_FOUND'),{statusCode:404});
    const {user}=await requireOrgRole(request,o.workspace.project.organizationId,Role.ADMIN);
    if(!o.workspace.containerId) throw Object.assign(new Error('WORKSPACE_HAS_NO_CONTAINER'),{statusCode:409});
    await reviews.cleanup(o.workspace.containerId,id,true).catch(()=>undefined);
    await prisma.orchestration.update({where:{id},data:{reviewStatus:'REJECTED',rejectedAt:new Date(),status:'WAITING_REVIEW'}});
    await audit({userId:user.id,organizationId:o.workspace.project.organizationId,action:'ORCHESTRATION_REVIEW_REJECTED',resource:'Orchestration',resourceId:id,ipAddress:request.ip});
    return {ok:true};
  });

}
