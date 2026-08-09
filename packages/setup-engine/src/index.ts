import Docker from 'dockerode';
import { PassThrough } from 'node:stream';

export type StackKind = 'NEXTJS'|'REACT_VITE'|'NODE'|'SPRING_BOOT_MAVEN'|'SPRING_BOOT_GRADLE'|'PYTHON'|'DOCKER'|'UNKNOWN';
export type ProjectDetection = { stack: StackKind; packageManager?: 'npm'|'pnpm'|'yarn'; installCommand?: string[]; devCommand?: string[]; buildCommand?: string[]; suggestedPorts: number[]; evidence: string[] };

const docker = new Docker({ socketPath: process.env.DOCKER_SOCKET ?? '/var/run/docker.sock' });

async function exec(containerId:string, cmd:string[], opts?:{workdir?:string; timeoutMs?:number}) {
  const container=docker.getContainer(containerId);
  const ex=await container.exec({Cmd:cmd,WorkingDir:opts?.workdir ?? '/workspace/repository',User:'devcloud',AttachStdout:true,AttachStderr:true});
  const stream=await ex.start({hijack:true,stdin:false}); let output='';
  // Without a TTY, Docker multiplexes stdout/stderr into one stream with an 8-byte header per
  // frame; demuxStream splits those frames so `output` is clean text, not corrupted with headers.
  const combined=new PassThrough();
  combined.on('data',(b:Buffer)=>{output+=b.toString('utf8')});
  docker.modem.demuxStream(stream,combined,combined);
  const ended=new Promise<void>((resolve,reject)=>{stream.on('end',resolve);stream.on('error',reject)});
  const timeout=new Promise<never>((_,reject)=>setTimeout(()=>reject(new Error('SETUP_COMMAND_TIMEOUT')),opts?.timeoutMs ?? 180000));
  await Promise.race([ended,timeout]); const info=await ex.inspect();
  return {exitCode:info.ExitCode ?? 1,output:output.slice(-12000)};
}

async function exists(containerId:string,file:string){const r=await exec(containerId,['test','-f',file]);return r.exitCode===0}
async function read(containerId:string,file:string){const r=await exec(containerId,['cat',file]);return r.exitCode===0?r.output:''}

export async function detectProject(containerId:string):Promise<ProjectDetection>{
  const evidence:string[]=[];
  const hasPackage=await exists(containerId,'package.json');
  if(hasPackage){
    evidence.push('package.json'); const raw=await read(containerId,'package.json'); let pkg:any={}; try{pkg=JSON.parse(raw)}catch{}
    const deps={...(pkg.dependencies??{}),...(pkg.devDependencies??{})};
    const pm: 'npm'|'pnpm'|'yarn' = await exists(containerId,'pnpm-lock.yaml')?'pnpm':await exists(containerId,'yarn.lock')?'yarn':'npm';
    evidence.push(pm==='npm'?(await exists(containerId,'package-lock.json')?'package-lock.json':'npm'):pm==='pnpm'?'pnpm-lock.yaml':'yarn.lock');
    const install=pm==='npm'?['npm','ci']:pm==='pnpm'?['pnpm','install','--frozen-lockfile']:['yarn','install','--frozen-lockfile'];
    if(pm==='npm' && !(await exists(containerId,'package-lock.json'))) install.splice(1,1,'install');
    if(deps.next){evidence.push('next dependency');return {stack:'NEXTJS',packageManager:pm,installCommand:install,devCommand:[pm,'run','dev'],buildCommand:[pm,'run','build'],suggestedPorts:[3000],evidence}}
    if(deps.vite){evidence.push('vite dependency');return {stack:'REACT_VITE',packageManager:pm,installCommand:install,devCommand:[pm,'run','dev','--','--host','0.0.0.0'],buildCommand:[pm,'run','build'],suggestedPorts:[5173],evidence}}
    return {stack:'NODE',packageManager:pm,installCommand:install,devCommand:pkg.scripts?.dev?[pm,'run','dev']:undefined,buildCommand:pkg.scripts?.build?[pm,'run','build']:undefined,suggestedPorts:[3000],evidence};
  }
  if(await exists(containerId,'pom.xml')) return {stack:'SPRING_BOOT_MAVEN',buildCommand:['mvn','-DskipTests','package'],devCommand:['mvn','spring-boot:run'],suggestedPorts:[8080],evidence:['pom.xml']};
  if(await exists(containerId,'build.gradle')||await exists(containerId,'build.gradle.kts')) return {stack:'SPRING_BOOT_GRADLE',buildCommand:['./gradlew','build','-x','test'],devCommand:['./gradlew','bootRun'],suggestedPorts:[8080],evidence:['Gradle build file']};
  if(await exists(containerId,'requirements.txt')||await exists(containerId,'pyproject.toml')) return {stack:'PYTHON',installCommand:await exists(containerId,'requirements.txt')?['python','-m','pip','install','-r','requirements.txt']:undefined,suggestedPorts:[8000],evidence:['Python project file']};
  if(await exists(containerId,'Dockerfile')||await exists(containerId,'docker-compose.yml')||await exists(containerId,'compose.yml')) return {stack:'DOCKER',suggestedPorts:[],evidence:['Docker configuration']};
  return {stack:'UNKNOWN',suggestedPorts:[],evidence:[]};
}

export async function installDependencies(containerId:string,detection:ProjectDetection){
  if(!detection.installCommand) return {skipped:true,output:'No automatic dependency install for this stack.'};
  const r=await exec(containerId,detection.installCommand,{timeoutMs:600000});
  if(r.exitCode!==0) throw Object.assign(new Error('DEPENDENCY_INSTALL_FAILED'),{statusCode:422,details:r.output});
  return {skipped:false,output:r.output};
}
