import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma, Role } from '@oliveira/database';
import { detectProject } from '@oliveira/setup-engine';
import { getRepositoryIntelligenceCached } from '../lib/repositoryIntelligenceCache.js';
import { getCodeIntelligenceCached } from '../lib/codeIntelligenceCache.js';
import { getContractIntelligenceCached } from '../lib/contractIntelligenceCache.js';
import { buildFocusedCodeContext } from '@oliveira/context-engine';
import { buildCommandPlan, type CommandPlan, type PlannerProvider } from '@oliveira/command-center-engine';
import { appendTaskContext, buildTaskContextMap } from '@oliveira/task-context-router';
import { routeTaskDependencies } from '@oliveira/dependency-router';
import { buildAiPlan } from '../lib/aiPlanner.js';
import { OrchestrationQueue, validateDag } from '@oliveira/orchestrator-engine';
import { requireOrgRole } from '../lib/auth.js';
import { audit } from '../lib/audit.js';

const queue=new OrchestrationQueue();
const requestSchema=z.object({workspaceId:z.string().cuid(),objective:z.string().min(10).max(5000),startNow:z.boolean().default(false),planner:z.enum(['AUTO','DETERMINISTIC','OPENAI','ANTHROPIC']).default('AUTO')});

export async function commandCenterRoutes(app:FastifyInstance){
  app.get('/',async request=>{
    const q=z.object({workspaceId:z.string().cuid()}).parse(request.query);
    const ws=await prisma.workspace.findUnique({where:{id:q.workspaceId},include:{project:true}});
    if(!ws)throw Object.assign(new Error('WORKSPACE_NOT_FOUND'),{statusCode:404});
    await requireOrgRole(request,ws.project.organizationId,Role.DEVELOPER);
    return prisma.commandRun.findMany({where:{workspaceId:q.workspaceId},orderBy:{createdAt:'desc'},take:20,include:{orchestration:{include:{steps:{orderBy:{key:'asc'}}}}}});
  });

  app.post('/plan',async(request,reply)=>{
    const body=requestSchema.parse(request.body);
    const ws=await prisma.workspace.findUnique({where:{id:body.workspaceId},include:{project:true}});
    if(!ws)throw Object.assign(new Error('WORKSPACE_NOT_FOUND'),{statusCode:404});
    const {user}=await requireOrgRole(request,ws.project.organizationId,Role.DEVELOPER);
    if(!ws.containerId)throw Object.assign(new Error('WORKSPACE_HAS_NO_CONTAINER'),{statusCode:409});
    const run=await prisma.commandRun.create({data:{workspaceId:ws.id,userId:user.id,objective:body.objective,status:'PLANNING'}});
    try{
      const [detection,intelligenceResult]=await Promise.all([detectProject(ws.containerId),getRepositoryIntelligenceCached({workspaceId:ws.id,containerId:ws.containerId})]);
      const intelligence=intelligenceResult.intelligence;
      const [codeResult,contractResult]=await Promise.all([getCodeIntelligenceCached({workspaceId:ws.id,containerId:ws.containerId,repository:intelligence}),getContractIntelligenceCached({workspaceId:ws.id,containerId:ws.containerId,repository:intelligence})]);
      const focusedCode=buildFocusedCodeContext(body.objective,codeResult.intelligence);
      const contractIntel=contractResult.intelligence;
      const context={stack:detection.stack,packageManager:detection.packageManager,suggestedPorts:detection.suggestedPorts,files:intelligence.files.slice(0,160),repository:{topLevelDirectories:intelligence.topLevelDirectories,manifests:intelligence.manifests,scripts:intelligence.scripts,dependencies:intelligence.dependencies,devDependencies:intelligence.devDependencies,architectureHints:intelligence.architectureHints,testFiles:intelligence.testFiles,routeFiles:intelligence.routeFiles,sourceFiles:intelligence.sourceFiles,git:intelligence.git,warnings:intelligence.warnings},code:focusedCode,contracts:{summary:contractIntel.summary,contracts:contractIntel.contracts.slice(0,30),consumers:contractIntel.consumers.slice(0,30),issues:contractIntel.issues.slice(0,30)}};
      let provider:PlannerProvider='DETERMINISTIC';
      let fallbackReason:string|null=null;
      let plan:CommandPlan;
      const requested=body.planner;
      const preferred=requested==='AUTO'?(process.env.DEFAULT_AI_PLANNER_PROVIDER??'OPENAI'):requested;
      if(preferred==='OPENAI'||preferred==='ANTHROPIC'){
        try{ provider=preferred; plan=await buildAiPlan({organizationId:ws.project.organizationId,provider,objective:body.objective,context}); }
        catch(error){
          if(requested!=='AUTO') throw error;
          fallbackReason=error instanceof Error?error.message:'AI_PLANNER_FAILED';
          provider='DETERMINISTIC'; plan=buildCommandPlan(body.objective,context);
        }
      } else plan=buildCommandPlan(body.objective,context);
      validateDag(plan.steps);
      const taskContexts=buildTaskContextMap(plan.steps,context);
      const dependencyRouting=routeTaskDependencies(plan.steps,taskContexts);
      validateDag(dependencyRouting.steps);
      const routedPlan:CommandPlan={...plan,steps:dependencyRouting.steps};
      const contractFileById=new Map<string,string>();
      for(const c of contractIntel.contracts)contractFileById.set(c.id,c.file);
      for(const c of contractIntel.consumers)contractFileById.set(c.id,c.file);
      const risksFor=(files:string[])=>contractIntel.issues.filter(issue=>{const producer=issue.producerId?contractFileById.get(issue.producerId):undefined;const consumer=issue.consumerId?contractFileById.get(issue.consumerId):undefined;return Boolean((producer&&files.includes(producer))||(consumer&&files.includes(consumer)));}).slice(0,8);
      const routedSteps=routedPlan.steps.map(step=>{
        if(step.type!=='AGENT'||!step.prompt)return step;
        const taskContext=taskContexts[step.key];
        const decisionNotes=dependencyRouting.decisions.filter(d=>d.from===step.key).map(d=>`Dependência arquitetural: aguarde ${d.to}. Motivo: ${d.reason}`).join('\n');
        const risks=taskContext?risksFor(taskContext.files):[];
        const contractNotes=risks.map(r=>`${r.severity} · ${r.kind}: ${r.message}`).join('\n');
        let enriched=taskContext?appendTaskContext(step.prompt,taskContext):step.prompt;
        if(decisionNotes)enriched+=`\n\n[DEVCLOUD DEPENDENCY ROUTING]\n${decisionNotes}`;
        if(contractNotes)enriched+=`\n\n[DEVCLOUD CONTRACT INTELLIGENCE]\nRiscos inferidos relacionados aos arquivos priorizados:\n${contractNotes}\nConfirme o contrato real no código antes de alterar produtor ou consumidor.`;
        return {...step,prompt:enriched};
      });
      const contextByKey=Object.fromEntries(Object.entries(taskContexts).map(([key,value])=>[key,{...value,contractRisks:risksFor(value.files),dependencyRouting:dependencyRouting.decisions.filter(d=>d.from===key),parallelWith:dependencyRouting.parallelPairs.filter(p=>p.left===key||p.right===key).map(p=>p.left===key?p.right:p.left)}]));
      const orchestration=await prisma.orchestration.create({data:{workspaceId:ws.id,title:routedPlan.title,objective:body.objective,status:body.startNow?'QUEUED':'DRAFT',steps:{create:routedSteps.map(s=>({key:s.key,title:s.title,type:s.type,agent:s.agent,prompt:s.prompt,taskContext:contextByKey[s.key] as any,command:s.command,dependsOn:s.dependsOn,status:s.dependsOn.length?'BLOCKED':'QUEUED'}))}},include:{steps:true}});
      const updated=await prisma.commandRun.update({where:{id:run.id},data:{status:body.startNow?'STARTED':'READY',repositoryContext:context as any,plan:routedPlan as any,plannerProvider:provider,plannerFallbackReason:fallbackReason,orchestrationId:orchestration.id,startedAt:body.startNow?new Date():null}});
      await audit({userId:user.id,organizationId:ws.project.organizationId,action:'COMMAND_CENTER_PLAN_CREATED',resource:'CommandRun',resourceId:run.id,ipAddress:request.ip,metadata:{orchestrationId:orchestration.id,startNow:body.startNow,stack:detection.stack,plannerProvider:provider,plannerFallbackReason:fallbackReason,repositorySourceFiles:intelligence.sourceFiles,repositoryChangedFiles:intelligence.git.changedFiles.length,repositoryCacheHit:intelligenceResult.cache.hit,repositoryCacheReason:intelligenceResult.cache.reason,codeCacheHit:codeResult.cache.hit,contractCacheHit:contractResult.cache.hit,contractIssues:contractIntel.summary.issues,contractHighRisk:contractIntel.summary.highRisk,focusedFiles:focusedCode.summary.selectedFiles,focusedSymbols:focusedCode.summary.selectedSymbols,taskContexts:Object.keys(taskContexts).length,dependencyDecisions:dependencyRouting.decisions.length,parallelPairs:dependencyRouting.parallelPairs.length}});
      if(body.startNow)await queue.tick(orchestration.id);
      return reply.code(201).send({run:updated,plan:routedPlan,orchestration,dependencyRouting});
    }catch(error){await prisma.commandRun.update({where:{id:run.id},data:{status:'FAILED',errorMessage:error instanceof Error?error.message:'UNKNOWN'}});throw error;}
  });

  app.post('/:id/start',async request=>{
    const {id}=z.object({id:z.string().cuid()}).parse(request.params);
    const run=await prisma.commandRun.findUnique({where:{id},include:{workspace:{include:{project:true}}}});
    if(!run)throw Object.assign(new Error('COMMAND_RUN_NOT_FOUND'),{statusCode:404});
    const {user}=await requireOrgRole(request,run.workspace.project.organizationId,Role.DEVELOPER);
    if(!run.orchestrationId||run.status!=='READY')throw Object.assign(new Error('COMMAND_RUN_NOT_READY'),{statusCode:409});
    await prisma.$transaction([prisma.commandRun.update({where:{id},data:{status:'STARTED',startedAt:new Date()}}),prisma.orchestration.update({where:{id:run.orchestrationId},data:{status:'QUEUED'}})]);
    await queue.tick(run.orchestrationId);
    await audit({userId:user.id,organizationId:run.workspace.project.organizationId,action:'COMMAND_CENTER_STARTED',resource:'CommandRun',resourceId:id,ipAddress:request.ip,metadata:{orchestrationId:run.orchestrationId}});
    return {ok:true,orchestrationId:run.orchestrationId};
  });
}
