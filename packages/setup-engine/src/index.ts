import { RuntimeBrokerClient } from '@oliveira/runtime-broker-client';

export type StackKind = 'NEXTJS'|'REACT_VITE'|'NODE'|'SPRING_BOOT_MAVEN'|'SPRING_BOOT_GRADLE'|'PYTHON'|'DOCKER'|'UNKNOWN';
export type ProjectDetection = { stack: StackKind; packageManager?: 'npm'|'pnpm'|'yarn'; installCommand?: string[]; devCommand?: string[]; buildCommand?: string[]; suggestedPorts: number[]; evidence: string[] };

const broker = new RuntimeBrokerClient();

type DeadlineOptions = { deadlineAt?: Date };

function boundedTimeoutMs(defaultTimeoutMs:number, deadlineAt?:Date) {
  if (!deadlineAt) return defaultTimeoutMs;
  const remaining = deadlineAt.getTime() - Date.now();
  if (remaining <= 0) throw Object.assign(new Error('SETUP_DURATION_EXCEEDED'), { statusCode: 504 });
  return Math.max(1, Math.min(defaultTimeoutMs, remaining));
}

async function exec(containerId:string, cmd:string[], opts?:{workdir?:string; timeoutMs?:number; deadlineAt?:Date}) {
  return broker.exec(containerId, { cmd, workingDir: opts?.workdir ?? '/workspace/repository', user: 'devcloud', timeoutMs: boundedTimeoutMs(opts?.timeoutMs ?? 180000, opts?.deadlineAt) });
}

async function exists(containerId:string,file:string,opts?:DeadlineOptions){const r=await exec(containerId,['test','-f',file],opts);return r.exitCode===0}
async function read(containerId:string,file:string,opts?:DeadlineOptions){const r=await exec(containerId,['cat',file],opts);return r.exitCode===0?r.output:''}

export async function detectProject(containerId:string,opts?:DeadlineOptions):Promise<ProjectDetection>{
  const evidence:string[]=[];
  const hasPackage=await exists(containerId,'package.json',opts);
  if(hasPackage){
    evidence.push('package.json'); const raw=await read(containerId,'package.json',opts); let pkg:any={}; try{pkg=JSON.parse(raw)}catch{}
    const deps={...(pkg.dependencies??{}),...(pkg.devDependencies??{})};
    const pm: 'npm'|'pnpm'|'yarn' = await exists(containerId,'pnpm-lock.yaml',opts)?'pnpm':await exists(containerId,'yarn.lock',opts)?'yarn':'npm';
    evidence.push(pm==='npm'?(await exists(containerId,'package-lock.json',opts)?'package-lock.json':'npm'):pm==='pnpm'?'pnpm-lock.yaml':'yarn.lock');
    const install=pm==='npm'?['npm','ci']:pm==='pnpm'?['pnpm','install','--frozen-lockfile']:['yarn','install','--frozen-lockfile'];
    if(pm==='npm' && !(await exists(containerId,'package-lock.json',opts))) install.splice(1,1,'install');
    if(deps.next){evidence.push('next dependency');return {stack:'NEXTJS',packageManager:pm,installCommand:install,devCommand:[pm,'run','dev'],buildCommand:[pm,'run','build'],suggestedPorts:[3000],evidence}}
    if(deps.vite){evidence.push('vite dependency');return {stack:'REACT_VITE',packageManager:pm,installCommand:install,devCommand:[pm,'run','dev','--','--host','0.0.0.0'],buildCommand:[pm,'run','build'],suggestedPorts:[5173],evidence}}
    return {stack:'NODE',packageManager:pm,installCommand:install,devCommand:pkg.scripts?.dev?[pm,'run','dev']:undefined,buildCommand:pkg.scripts?.build?[pm,'run','build']:undefined,suggestedPorts:[3000],evidence};
  }
  if(await exists(containerId,'pom.xml',opts)) return {stack:'SPRING_BOOT_MAVEN',buildCommand:['mvn','-DskipTests','package'],devCommand:['mvn','spring-boot:run'],suggestedPorts:[8080],evidence:['pom.xml']};
  if(await exists(containerId,'build.gradle',opts)||await exists(containerId,'build.gradle.kts',opts)) return {stack:'SPRING_BOOT_GRADLE',buildCommand:['./gradlew','build','-x','test'],devCommand:['./gradlew','bootRun'],suggestedPorts:[8080],evidence:['Gradle build file']};
  if(await exists(containerId,'requirements.txt',opts)||await exists(containerId,'pyproject.toml',opts)) return {stack:'PYTHON',installCommand:await exists(containerId,'requirements.txt',opts)?['python','-m','pip','install','-r','requirements.txt']:undefined,suggestedPorts:[8000],evidence:['Python project file']};
  if(await exists(containerId,'Dockerfile',opts)||await exists(containerId,'docker-compose.yml',opts)||await exists(containerId,'compose.yml',opts)) return {stack:'DOCKER',suggestedPorts:[],evidence:['Docker configuration']};
  return {stack:'UNKNOWN',suggestedPorts:[],evidence:[]};
}

export async function installDependencies(containerId:string,detection:ProjectDetection,opts?:DeadlineOptions){
  if(!detection.installCommand) return {skipped:true,output:'No automatic dependency install for this stack.'};
  const r=await exec(containerId,detection.installCommand,{timeoutMs:600000,deadlineAt:opts?.deadlineAt});
  if(r.exitCode!==0) throw Object.assign(new Error('DEPENDENCY_INSTALL_FAILED'),{statusCode:422,details:r.output});
  return {skipped:false,output:r.output};
}
