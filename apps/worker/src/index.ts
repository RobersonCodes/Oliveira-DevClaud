import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
// `npm run dev -w @oliveira/worker` runs with cwd set to apps/worker, not the repo root, so the
// default dotenv cwd-lookup would never find the root .env. Resolve it relative to this file instead.
loadEnv({ path: fileURLToPath(new URL('../../../.env', import.meta.url)) });
import { Worker } from 'bullmq';
import { Redis as IORedis } from 'ioredis';
import { prisma } from '@oliveira/database';
import { DockerAgentEngine } from '@oliveira/agent-engine';
import { DockerGitIsolationEngine } from '@oliveira/git-engine';
import { readyStepKeys, OrchestrationQueue } from '@oliveira/orchestrator-engine';

const connection = new IORedis(process.env.REDIS_URL ?? 'redis://localhost:6379', { maxRetriesPerRequest:null });
const queue = new OrchestrationQueue(); const agents = new DockerAgentEngine(); const git = new DockerGitIsolationEngine();
const safeSystemCommands = new Set(['npm test','npm run test','npm run build','npm run lint','npm run typecheck']);

async function tick(orchestrationId:string){
  const o=await prisma.orchestration.findUnique({where:{id:orchestrationId},include:{workspace:true,steps:true}}); if(!o||o.status==='CANCELLED'||o.status==='COMPLETED'||o.status==='FAILED') return;
  if(!o.workspace.containerId) throw new Error('WORKSPACE_HAS_NO_CONTAINER');
  if(!o.startedAt) await prisma.orchestration.update({where:{id:o.id},data:{startedAt:new Date(),status:'RUNNING'}});

  // Reconcile running agent steps with their persistent tmux runtime.
  for(const step of o.steps.filter(s=>s.status==='RUNNING'&&s.type==='AGENT'&&s.agentTaskId)){
    const runtime=await agents.status(o.workspace.containerId,step.agentTaskId!);
    if(runtime.status==='COMPLETED'||runtime.status==='FAILED'){
      const ok=runtime.status==='COMPLETED';
      await prisma.$transaction([
        prisma.orchestrationStep.update({where:{id:step.id},data:{status:ok?'COMPLETED':'FAILED',exitCode:runtime.exitCode,finishedAt:new Date()}}),
        prisma.agentTask.update({where:{id:step.agentTaskId!},data:{status:ok?'COMPLETED':'FAILED',exitCode:runtime.exitCode,finishedAt:new Date(),reviewStatus:'READY'}})
      ]);
      if(!ok){await prisma.orchestration.update({where:{id:o.id},data:{status:'FAILED',finishedAt:new Date()}});return;}
    }
  }
  const fresh=await prisma.orchestrationStep.findMany({where:{orchestrationId:o.id}});
  const ready=readyStepKeys(fresh.map(s=>({key:s.key,status:s.status,dependsOn:s.dependsOn})));
  if(ready.length) await prisma.orchestrationStep.updateMany({where:{orchestrationId:o.id,key:{in:ready}},data:{status:'QUEUED'}});
  const queued=await prisma.orchestrationStep.findMany({where:{orchestrationId:o.id,status:'QUEUED'},orderBy:{key:'asc'}});
  for(const step of queued){
    if(step.type==='AGENT'){
      const task=await prisma.agentTask.create({data:{workspaceId:o.workspaceId,agent:step.agent!,title:step.title,prompt:step.prompt!,status:'QUEUED'}});
      const wt=await git.createWorktree(o.workspace.containerId,task.id,task.agent);
      const runtime=await agents.start({containerId:o.workspace.containerId,taskId:task.id,agent:task.agent,prompt:task.prompt,workingDirectory:wt.path});
      await prisma.$transaction([
        prisma.agentTask.update({where:{id:task.id},data:{status:'RUNNING',startedAt:new Date(),branchName:wt.branchName,worktreePath:wt.path,baseCommit:wt.baseCommit}}),
        prisma.agentRun.create({data:{taskId:task.id,workspaceId:o.workspaceId,sessionName:runtime.sessionName,statusFile:runtime.statusFile}}),
        prisma.orchestrationStep.update({where:{id:step.id},data:{status:'RUNNING',startedAt:new Date(),agentTaskId:task.id}})
      ]);
    } else {
      // v0.9: SYSTEM steps are declarations of integration quality gates.
      // They are executed only inside the temporary review worktree after all agent branches are merged there.
      if(!safeSystemCommands.has(step.command!)) {
        await prisma.orchestrationStep.update({where:{id:step.id},data:{status:'FAILED',output:'Command not allow-listed',finishedAt:new Date()}});
        await prisma.orchestration.update({where:{id:o.id},data:{status:'FAILED',finishedAt:new Date()}});
        return;
      }
      await prisma.orchestrationStep.update({where:{id:step.id},data:{status:'COMPLETED',exitCode:0,output:'Deferred to v0.9 integration review gate',startedAt:new Date(),finishedAt:new Date()}});
    }
  }
  const end=await prisma.orchestrationStep.findMany({where:{orchestrationId:o.id}});
  if(end.every(s=>s.status==='COMPLETED')) await prisma.orchestration.update({where:{id:o.id},data:{status:'WAITING_REVIEW'}});
  else await new Promise(r=>setTimeout(r,1500)).then(()=>queue.tick(o.id));
}

new Worker('oliveira-orchestrations', async job=>{if(job.name==='tick') await tick(job.data.orchestrationId)}, {connection,concurrency:4});
console.log('Oliveira DevCloud orchestration worker online');

// v1.4 resilient asynchronous workspace provisioning
import { SetupStage, SetupJobStatus, SecretKind } from '@oliveira/database';
import { detectProject, installDependencies } from '@oliveira/setup-engine';
import { DockerIdeEngine } from '@oliveira/ide-engine';
import { SetupQueue } from '@oliveira/setup-queue';
import { bootstrapRepository } from './lib/repositoryBootstrap.js';
import { resolveSecretByKind } from './lib/secretResolver.js';

const setupIde=new DockerIdeEngine(); const setupQueue=new SetupQueue();
async function setupLog(id:string,message:string,stage?:SetupStage,level='INFO'){await prisma.setupJobLog.create({data:{setupJobId:id,message,stage,level}})}
async function setupProgress(id:string,stage:SetupStage,progress:number,message:string){await prisma.setupJob.update({where:{id},data:{stage,progress,message,status:SetupJobStatus.RUNNING,heartbeatAt:new Date(),startedAt:stage===SetupStage.CLONING_REPOSITORY?new Date():undefined}});await setupLog(id,message,stage)}
async function cancellationCheckpoint(id:string){const current=await prisma.setupJob.findUnique({where:{id},select:{status:true}});if(current?.status===SetupJobStatus.CANCEL_REQUESTED){await prisma.setupJob.update({where:{id},data:{status:SetupJobStatus.CANCELLED,stage:SetupStage.CANCELLED,message:'Provisionamento cancelado',finishedAt:new Date(),heartbeatAt:new Date()}});await setupLog(id,'Provisionamento interrompido em checkpoint seguro',SetupStage.CANCELLED,'WARN');return true}return false}
async function provision(setupJobId:string){
  const job=await prisma.setupJob.findUnique({where:{id:setupJobId},include:{workspace:{include:{project:true}}}}); if(!job)return;
  if([SetupJobStatus.READY,SetupJobStatus.CANCELLED].includes(job.status as any))return;
  const ws=job.workspace; if(!ws.containerId)throw new Error('WORKSPACE_HAS_NO_CONTAINER'); const options=(job.options??{}) as any;
  try{
    if(await cancellationCheckpoint(job.id))return;
    await setupProgress(job.id,SetupStage.CLONING_REPOSITORY,15,'Clonando repositório');
    if(options.clone!==false&&ws.project.repositoryUrl){const token=await resolveSecretByKind(job.organizationId,SecretKind.GITHUB_TOKEN);try{await bootstrapRepository({containerId:ws.containerId,repositoryUrl:ws.project.repositoryUrl,defaultBranch:ws.project.defaultBranch,githubToken:token});await setupLog(job.id,'Repositório clonado com sucesso',SetupStage.CLONING_REPOSITORY)}catch(e:any){if(!String(e?.details??'').includes('already exists and is not an empty directory'))throw e;await setupLog(job.id,'Repositório já presente; clone ignorado',SetupStage.CLONING_REPOSITORY,'WARN')}}
    if(await cancellationCheckpoint(job.id))return;
    await setupProgress(job.id,SetupStage.DETECTING_STACK,35,'Detectando stack'); const detection=await detectProject(ws.containerId);await setupLog(job.id,`Stack detectada: ${detection.stack}`,SetupStage.DETECTING_STACK);
    if(await cancellationCheckpoint(job.id))return;
    await setupProgress(job.id,SetupStage.INSTALLING_DEPS,55,'Instalando dependências'); let installResult:any={skipped:true};if(options.install!==false){installResult=await installDependencies(ws.containerId,detection);await setupLog(job.id,'Instalação de dependências concluída',SetupStage.INSTALLING_DEPS)}else await setupLog(job.id,'Instalação de dependências ignorada',SetupStage.INSTALLING_DEPS);
    if(await cancellationCheckpoint(job.id))return;
    await setupProgress(job.id,SetupStage.CONFIGURING_PORTS,78,'Configurando portas'); if(options.registerPorts!==false)for(const port of detection.suggestedPorts){if(port!==13337)await prisma.workspacePort.upsert({where:{workspaceId_port:{workspaceId:ws.id,port}},create:{workspaceId:ws.id,port,label:`${detection.stack} preview`},update:{label:`${detection.stack} preview`}})}
    if(await cancellationCheckpoint(job.id))return;
    await setupProgress(job.id,SetupStage.STARTING_IDE,90,'Iniciando IDE'); let ideResult:any=null;if(options.startIde!==false){ideResult=await setupIde.start(ws.containerId);await prisma.ideSession.upsert({where:{workspaceId:ws.id},create:{workspaceId:ws.id,active:true,port:ideResult.port,startedAt:new Date()},update:{active:true,port:ideResult.port,startedAt:new Date(),lastActiveAt:new Date()}})}
    if(await cancellationCheckpoint(job.id))return;
    const result={workspaceId:ws.id,detection,dependencies:installResult.skipped?'SKIPPED':'INSTALLED',ideUrl:ideResult?`/api/v1/proxy/ide/${ws.id}/`:null,ports:detection.suggestedPorts.map(port=>({port,previewUrl:`/api/v1/proxy/preview/${ws.id}/${port}/`}))};
    await prisma.setupJob.update({where:{id:job.id},data:{status:SetupJobStatus.READY,stage:SetupStage.READY,progress:100,message:'Workspace Ready',result,finishedAt:new Date(),heartbeatAt:new Date()}});await setupLog(job.id,'Workspace Ready',SetupStage.READY);
  }catch(e:any){const current=await prisma.setupJob.findUnique({where:{id:job.id},select:{status:true}});if(current?.status===SetupJobStatus.CANCELLED)return;await prisma.setupJob.update({where:{id:job.id},data:{status:SetupJobStatus.FAILED,stage:SetupStage.FAILED,message:'Provisionamento falhou',errorCode:String(e?.message??'SETUP_FAILED').slice(0,120),errorMessage:String(e?.details??e?.message??e).slice(0,4000),finishedAt:new Date(),heartbeatAt:new Date()}});await setupLog(job.id,String(e?.details??e?.message??e).slice(0,4000),SetupStage.FAILED,'ERROR');throw e}
}
new Worker('oliveira-setup',async job=>{if(job.name==='provision')await provision(job.data.setupJobId)},{connection,concurrency:2});
console.log('Oliveira DevCloud setup worker v1.4 online');

// Recover jobs that were RUNNING when a worker/process stopped unexpectedly.
async function recoverInterruptedSetupJobs(){const cutoff=new Date(Date.now()-60_000);const stale=await prisma.setupJob.findMany({where:{status:SetupJobStatus.RUNNING,OR:[{heartbeatAt:null},{heartbeatAt:{lt:cutoff}}]}});for(const job of stale){await prisma.setupJob.update({where:{id:job.id},data:{status:SetupJobStatus.QUEUED,message:'Recuperando job interrompido'}});await setupLog(job.id,'Worker detectou execução interrompida; job reenfileirado',job.stage,'WARN');await setupQueue.requeue(job.id)}if(stale.length)console.log(`Recovered ${stale.length} interrupted setup job(s)`)}
recoverInterruptedSetupJobs().catch(error=>console.error('Setup recovery failed',error));
