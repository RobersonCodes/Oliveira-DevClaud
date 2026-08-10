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
  const o=await prisma.orchestration.findUnique({where:{id:orchestrationId},include:{workspace:true,steps:{include:{agentTask:{select:{status:true}}}}}}); if(!o||o.status==='CANCELLED'||o.status==='COMPLETED'||o.status==='FAILED') return;
  if(!o.workspace.containerId) throw new Error('WORKSPACE_HAS_NO_CONTAINER');
  if(!o.startedAt) await prisma.orchestration.update({where:{id:o.id},data:{startedAt:new Date(),status:'RUNNING'}});

  // Reconcile running agent steps with their persistent tmux runtime. `o.steps` is a snapshot read
  // at the top of this tick — by the time we act on it, a concurrent tick (or a user hitting
  // /cancel) may have already moved the step out of RUNNING. The `updateMany({where:{status:
  // 'RUNNING'}})` below is a compare-and-swap: it only takes effect if the step is *still* RUNNING
  // at write time, so a step someone else already cancelled/completed is never clobbered back to
  // COMPLETED/FAILED based on this tick's stale view of it.
  for(const step of o.steps.filter(s=>s.status==='RUNNING'&&s.type==='AGENT'&&s.agentTaskId&&s.agentTask?.status==='RUNNING')){
    const runtime=await agents.status(o.workspace.containerId,step.agentTaskId!);
    // UNKNOWN means the tmux session is gone AND no status file was written — the agent's process
    // was lost (container killed, host OOM, or cancelled outside the normal /cancel route) rather
    // than having finished normally. Treating it as still RUNNING left steps stuck forever with no
    // way to progress or fail the orchestration; folding it into the FAILED branch below closes
    // that gap.
    if(runtime.status==='COMPLETED'||runtime.status==='FAILED'||runtime.status==='UNKNOWN'){
      const ok=runtime.status==='COMPLETED';
      const wonRace=await prisma.$transaction(async tx=>{
        const claimed=await tx.orchestrationStep.updateMany({where:{id:step.id,status:'RUNNING'},data:{status:ok?'COMPLETED':'FAILED',exitCode:runtime.exitCode,finishedAt:new Date()}});
        if(claimed.count===0) return false;
        await tx.agentTask.update({where:{id:step.agentTaskId!},data:{status:ok?'COMPLETED':'FAILED',exitCode:runtime.exitCode,finishedAt:new Date(),reviewStatus:'READY'}});
        return true;
      });
      if(wonRace&&!ok){await prisma.orchestration.updateMany({where:{id:o.id,status:{not:'CANCELLED'}},data:{status:'FAILED',finishedAt:new Date()}});return;}
    }
  }
  // A process crash can happen after a step is atomically claimed but before its external runtime
  // starts. Keep a short startup grace window for concurrent ticks, then fail abandoned claims so
  // they never remain RUNNING forever with an AgentTask that is still QUEUED.
  const abandonedBefore=new Date(Date.now()-120_000);
  for(const step of o.steps.filter(s=>s.status==='RUNNING'&&s.type==='AGENT'&&s.agentTaskId&&s.agentTask?.status==='QUEUED'&&s.startedAt&&s.startedAt<abandonedBefore)){
    const now=new Date();
    const abandoned=await prisma.$transaction(async tx=>{
      const claimed=await tx.orchestrationStep.updateMany({where:{id:step.id,status:'RUNNING',agentTaskId:step.agentTaskId},data:{status:'FAILED',finishedAt:now,output:'Agent startup was interrupted'}});
      if(claimed.count===0)return false;
      await tx.agentTask.updateMany({where:{id:step.agentTaskId!,status:'QUEUED'},data:{status:'FAILED',finishedAt:now,reviewStatus:'READY'}});
      return true;
    });
    if(abandoned){await prisma.orchestration.updateMany({where:{id:o.id,status:{not:'CANCELLED'}},data:{status:'FAILED',finishedAt:now}});return;}
  }
  const fresh=await prisma.orchestrationStep.findMany({where:{orchestrationId:o.id}});
  const ready=readyStepKeys(fresh.map(s=>({key:s.key,status:s.status,dependsOn:s.dependsOn})));
  if(ready.length) await prisma.orchestrationStep.updateMany({where:{orchestrationId:o.id,key:{in:ready}},data:{status:'QUEUED'}});
  const queued=await prisma.orchestrationStep.findMany({where:{orchestrationId:o.id,status:'QUEUED',agentTaskId:null},orderBy:{key:'asc'}});
  for(const step of queued){
    if(step.type==='AGENT'){
      // Create the task and claim the step in one transaction. Only the winner of the conditional
      // update keeps its task; concurrent losers delete their provisional row before returning.
      const task=await prisma.$transaction(async tx=>{
        const candidate=await tx.agentTask.create({data:{workspaceId:o.workspaceId,agent:step.agent!,title:step.title,prompt:step.prompt!,status:'QUEUED'}});
        const claimed=await tx.orchestrationStep.updateMany({where:{id:step.id,status:'QUEUED',agentTaskId:null},data:{status:'RUNNING',startedAt:new Date(),agentTaskId:candidate.id}});
        if(claimed.count===0){await tx.agentTask.delete({where:{id:candidate.id}});return null;}
        return candidate;
      });
      if(!task)continue;
      try{
        const wt=await git.createWorktree(o.workspace.containerId,task.id,task.agent);
        const runtime=await agents.start({containerId:o.workspace.containerId,taskId:task.id,agent:task.agent,prompt:task.prompt,workingDirectory:wt.path});
        const activated=await prisma.$transaction(async tx=>{
          const stepStillOwned=await tx.orchestrationStep.updateMany({where:{id:step.id,status:'RUNNING',agentTaskId:task.id},data:{startedAt:new Date()}});
          if(stepStillOwned.count===0)return false;
          const taskStillQueued=await tx.agentTask.updateMany({where:{id:task.id,status:'QUEUED'},data:{status:'RUNNING',startedAt:new Date(),branchName:wt.branchName,worktreePath:wt.path,baseCommit:wt.baseCommit}});
          if(taskStillQueued.count===0)return false;
          await tx.agentRun.create({data:{taskId:task.id,workspaceId:o.workspaceId,sessionName:runtime.sessionName,statusFile:runtime.statusFile}});
          return true;
        });
        if(!activated){await agents.cancel(o.workspace.containerId,task.id).catch(()=>undefined);await git.cleanup(o.workspace.containerId,wt,true).catch(()=>undefined);}
      }catch(error){
        const now=new Date();
        await prisma.$transaction([
          prisma.agentTask.updateMany({where:{id:task.id,status:{in:['QUEUED','RUNNING']}},data:{status:'FAILED',finishedAt:now,reviewStatus:'READY'}}),
          prisma.orchestrationStep.updateMany({where:{id:step.id,status:'RUNNING',agentTaskId:task.id},data:{status:'FAILED',finishedAt:now}}),
          prisma.orchestration.updateMany({where:{id:o.id,status:{not:'CANCELLED'}},data:{status:'FAILED',finishedAt:now}})
        ]);
        throw error;
      }
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

const orchestrationWorker = new Worker('oliveira-orchestrations', async job=>{if(job.name==='tick') await tick(job.data.orchestrationId)}, {connection,concurrency:4});
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
const setupWorker = new Worker('oliveira-setup',async job=>{if(job.name==='provision')await provision(job.data.setupJobId)},{connection,concurrency:2});
console.log('Oliveira DevCloud setup worker v1.4 online');

// Recover jobs that were RUNNING when a worker/process stopped unexpectedly.
async function recoverInterruptedSetupJobs(){const cutoff=new Date(Date.now()-60_000);const stale=await prisma.setupJob.findMany({where:{status:SetupJobStatus.RUNNING,OR:[{heartbeatAt:null},{heartbeatAt:{lt:cutoff}}]}});for(const job of stale){await prisma.setupJob.update({where:{id:job.id},data:{status:SetupJobStatus.QUEUED,message:'Recuperando job interrompido'}});await setupLog(job.id,'Worker detectou execução interrompida; job reenfileirado',job.stage,'WARN');await setupQueue.requeue(job.id)}if(stale.length)console.log(`Recovered ${stale.length} interrupted setup job(s)`)}
recoverInterruptedSetupJobs().catch(error=>console.error('Setup recovery failed',error));

// Without this, `docker stop`/a rolling deploy SIGKILLs the process after its default grace period:
// BullMQ jobs mid-processing (an agent tick, a workspace provisioning step) are abandoned without
// releasing their lock cleanly, and the Redis/Prisma connections are torn down by the OS instead of
// closed. `Worker.close()` waits for the currently active job on that worker to finish before
// resolving, so in-flight work gets a chance to complete instead of being cut off mid-step.
let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, shutting down gracefully`);
  const forceExit = setTimeout(() => {
    console.warn('Graceful shutdown timed out after 15s, forcing exit');
    process.exit(1);
  }, 15_000);
  forceExit.unref();
  try {
    await Promise.all([orchestrationWorker.close(), setupWorker.close()]);
    await Promise.all([queue.queue.close(), setupQueue.close()]);
    await connection.quit();
    await prisma.$disconnect();
    clearTimeout(forceExit);
    process.exit(0);
  } catch (error) {
    console.error('Error during graceful shutdown', error);
    process.exit(1);
  }
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
