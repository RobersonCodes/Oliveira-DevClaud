import Docker from 'dockerode';
import { PassThrough } from 'node:stream';

export type ReviewBranch = { taskId: string; branchName: string };
export type GateResult = { command: string; exitCode: number; output: string; ok: boolean };
export type ReviewPreparation = {
  reviewBranch: string;
  reviewPath: string;
  baseCommit: string;
  conflicts: string[];
  mergedBranches: string[];
  gates: GateResult[];
  ready: boolean;
};

const safeId = (value: string) => {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw new Error('INVALID_REVIEW_ID');
  return value;
};
const safeBranch = (value: string) => {
  if (!/^[a-zA-Z0-9._\/-]{1,220}$/.test(value) || value.includes('..') || value.startsWith('-')) throw new Error('INVALID_BRANCH_NAME');
  return value;
};

export class DockerReviewEngine {
  private readonly docker: Docker;
  constructor(socketPath = process.env.DOCKER_SOCKET ?? '/var/run/docker.sock') { this.docker = new Docker({ socketPath }); }

  private async exec(containerId: string, cmd: string[], workingDir = '/workspace/repository') {
    const container = this.docker.getContainer(containerId);
    const execution = await container.exec({ Cmd: cmd, WorkingDir: workingDir, AttachStdout: true, AttachStderr: true });
    const stream = await execution.start({ hijack: true });
    // See DockerGitIsolationEngine.exec() for why this needs demuxing rather than raw concatenation.
    const chunks: Buffer[] = [];
    const combined = new PassThrough();
    combined.on('data', (chunk: Buffer) => chunks.push(chunk));
    this.docker.modem.demuxStream(stream, combined, combined);
    await new Promise<void>((resolve, reject) => {
      stream.on('end', resolve); stream.on('close', resolve); stream.on('error', reject);
    });
    const result = await execution.inspect();
    return { exitCode: result.ExitCode ?? 1, output: Buffer.concat(chunks).toString('utf8') };
  }

  private ok(result: { exitCode:number; output:string }, code:string) {
    if (result.exitCode !== 0) { const e = new Error(code); Object.assign(e,{detail:result.output.slice(-4000)}); throw e; }
    return result.output.trim();
  }

  async cleanup(containerId:string, orchestrationId:string, deleteBranch=true) {
    const id=safeId(orchestrationId), path=`/workspace/reviews/${id}`, branch=`review/${id}`;
    await this.exec(containerId,['git','merge','--abort'],path).catch(()=>undefined);
    await this.exec(containerId,['git','worktree','remove','--force',path]);
    await this.exec(containerId,['git','worktree','prune']);
    if(deleteBranch) await this.exec(containerId,['git','branch','-D',branch]);
  }

  async prepare(containerId:string, orchestrationId:string, branches:ReviewBranch[], gateCommands:string[]):Promise<ReviewPreparation>{
    const id=safeId(orchestrationId); if(!branches.length) throw new Error('REVIEW_REQUIRES_AGENT_BRANCHES');
    const branch=`review/${id}`, path=`/workspace/reviews/${id}`;
    await this.cleanup(containerId,id,true).catch(()=>undefined);
    const baseCommit=this.ok(await this.exec(containerId,['git','rev-parse','HEAD']),'GIT_HEAD_NOT_FOUND');
    this.ok(await this.exec(containerId,['git','worktree','add','-b',branch,path,baseCommit]),'REVIEW_WORKTREE_CREATE_FAILED');
    const conflicts:string[]=[]; const mergedBranches:string[]=[];
    for(const item of branches){
      const agentBranch=safeBranch(item.branchName);
      const merge=await this.exec(containerId,['git','-c','user.name=Oliveira DevCloud','-c','user.email=devcloud@local','merge','--no-ff','--no-edit',agentBranch],path);
      if(merge.exitCode!==0){
        const names=await this.exec(containerId,['git','diff','--name-only','--diff-filter=U'],path);
        conflicts.push(...names.output.split(/\r?\n/).map(x=>x.trim()).filter(Boolean));
        await this.exec(containerId,['git','merge','--abort'],path);
        break;
      }
      mergedBranches.push(agentBranch);
    }
    const gates:GateResult[]=[];
    if(!conflicts.length){
      for(const command of gateCommands){
        const [bin,...args]=command.split(' ');
        const result=await this.exec(containerId,[bin,...args],path);
        gates.push({command,exitCode:result.exitCode,output:result.output.slice(-20000),ok:result.exitCode===0});
        if(result.exitCode!==0) break;
      }
    }
    return { reviewBranch:branch, reviewPath:path, baseCommit, conflicts:[...new Set(conflicts)], mergedBranches, gates, ready:conflicts.length===0&&gates.every(g=>g.ok) };
  }

  async approve(containerId:string, orchestrationId:string, expectedBaseCommit:string){
    const id=safeId(orchestrationId), branch=`review/${id}`;
    const current=this.ok(await this.exec(containerId,['git','rev-parse','HEAD']),'GIT_HEAD_NOT_FOUND');
    if(current!==expectedBaseCommit) throw new Error('MAIN_BRANCH_MOVED_SINCE_REVIEW');
    const dirty=this.ok(await this.exec(containerId,['git','status','--porcelain']),'MAIN_WORKTREE_STATUS_FAILED');
    if(dirty) throw new Error('MAIN_WORKTREE_DIRTY');
    const merge=await this.exec(containerId,['git','-c','user.name=Oliveira DevCloud','-c','user.email=devcloud@local','merge','--no-ff',branch,'-m',`merge(orchestration): ${id}`]);
    this.ok(merge,'ORCHESTRATION_MERGE_FAILED');
    const mergeCommit=this.ok(await this.exec(containerId,['git','rev-parse','HEAD']),'MERGE_COMMIT_NOT_FOUND');
    await this.cleanup(containerId,id,true);
    return {mergeCommit};
  }
}
