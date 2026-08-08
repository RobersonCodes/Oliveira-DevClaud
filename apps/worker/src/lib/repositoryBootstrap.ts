import Docker from 'dockerode';

const docker = new Docker({ socketPath: process.env.DOCKER_SOCKET ?? '/var/run/docker.sock' });
const safeBranch = (v:string) => { if (!/^[A-Za-z0-9._\/-]+$/.test(v)) throw new Error('INVALID_BRANCH'); return v; };

async function exec(containerId:string, cmd:string[], env?:string[]) {
  const container=docker.getContainer(containerId);
  const ex=await container.exec({ Cmd:cmd, WorkingDir:'/workspace/repository', Env:env, AttachStdout:true, AttachStderr:true });
  const stream=await ex.start({ hijack:true, stdin:false });
  let output=''; stream.on('data',(b:Buffer)=>{ output += b.toString('utf8'); });
  await new Promise<void>((resolve,reject)=>{ stream.on('end',resolve); stream.on('error',reject); });
  const info=await ex.inspect();
  if ((info.ExitCode ?? 1)!==0) throw Object.assign(new Error('REPOSITORY_BOOTSTRAP_FAILED'),{ statusCode:500, details:output.slice(-4000) });
  return output;
}

export async function bootstrapRepository(input:{containerId:string; repositoryUrl:string; defaultBranch:string; githubToken?:string|null}) {
  const branch=safeBranch(input.defaultBranch);
  const authHeader=input.githubToken ? `Authorization: Bearer ${input.githubToken}` : null;
  const cloneArgs=['git'];
  if (authHeader) cloneArgs.push('-c',`http.extraHeader=${authHeader}`);
  cloneArgs.push('clone','--branch',branch,'--single-branch','--depth','50',input.repositoryUrl,'.');
  return exec(input.containerId,cloneArgs);
}
