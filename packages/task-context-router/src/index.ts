export type RepositoryContext = {
  repository?: { architectureHints?: string[] };
  code?: {
    files?: string[];
    symbols?: Array<{name:string;kind:string;file:string;line:number;signature?:string;score?:number}>;
    endpoints?: Array<{method:string;path:string;file:string;line:number;handler?:string;score?:number}>;
    edges?: Array<{from:string;to:string;type:string}>;
  };
};
export type CommandPlanStep = {key:string;title:string;type:'AGENT'|'SYSTEM';agent?:'CODEX'|'CLAUDE';prompt?:string;command?:string;dependsOn:string[]};
type Agent='CODEX'|'CLAUDE';
type CodeSymbol=NonNullable<NonNullable<RepositoryContext['code']>['symbols']>[number];
type CodeEndpoint=NonNullable<NonNullable<RepositoryContext['code']>['endpoints']>[number];
type CodeEdge=NonNullable<NonNullable<RepositoryContext['code']>['edges']>[number];

export type TaskContext={agent:Agent;focus:'BACKEND'|'FRONTEND'|'GENERAL';files:string[];symbols:CodeSymbol[];endpoints:CodeEndpoint[];edges:CodeEdge[];repositoryHints:string[];reason:string};

const FRONT_HINTS=['app/','apps/web/','frontend/','client/','components/','pages/','views/','hooks/','styles/','css','tsx','jsx','ui/'];
const BACK_HINTS=['apps/api/','backend/','server/','api/','routes/','controllers/','services/','repositories/','database/','prisma/','models/','entities/','src/main/java'];
function norm(v:string){return v.toLowerCase().replace(/\\/g,'/');}
function scoreFile(file:string,agent:Agent){const n=norm(file),preferred=agent==='CLAUDE'?FRONT_HINTS:BACK_HINTS,opposite=agent==='CLAUDE'?BACK_HINTS:FRONT_HINTS;let score=0;for(const h of preferred)if(n.includes(h))score+=5;for(const h of opposite)if(n.includes(h))score-=3;if(agent==='CLAUDE'&&/\.(tsx|jsx|css|scss|sass|less)$/.test(n))score+=4;if(agent==='CODEX'&&/\.(ts|js|java|py|sql|prisma)$/.test(n)&&!/[.]tsx$|[.]jsx$/.test(n))score+=2;if(/test|spec|__tests__/.test(n))score+=1;return score;}
function inferFocus(agent:Agent,step:CommandPlanStep):TaskContext['focus']{const text=`${step.title} ${step.prompt??''}`.toLowerCase();if(/ui|ux|front|interface|component|page|screen|responsiv|css|style|hook/.test(text))return'FRONTEND';if(/api|back|database|banco|service|repository|controller|endpoint|auth|model|prisma/.test(text))return'BACKEND';return agent==='CLAUDE'?'FRONTEND':'BACKEND';}
function unique<T>(values:T[],key:(v:T)=>string){const seen=new Set<string>();return values.filter(v=>{const k=key(v);if(seen.has(k))return false;seen.add(k);return true;});}
export function routeTaskContext(step:CommandPlanStep,context:RepositoryContext):TaskContext|null{if(step.type!=='AGENT'||!step.agent)return null;const agent=step.agent,focus=inferFocus(agent,step),code=context.code;const ranked=(code?.files??[]).map((file:string)=>({file,score:scoreFile(file,agent)})).sort((a:{file:string;score:number},b:{file:string;score:number})=>b.score-a.score||a.file.localeCompare(b.file));const positive=ranked.filter((x:{score:number})=>x.score>0).map((x:{file:string})=>x.file);const selectedFiles=(positive.length?positive:ranked.map((x:{file:string})=>x.file)).slice(0,10);const symbols=unique<CodeSymbol>((code?.symbols??[]).filter((s:CodeSymbol)=>selectedFiles.includes(s.file)).sort((a:CodeSymbol,b:CodeSymbol)=>scoreFile(b.file,agent)-scoreFile(a.file,agent)),s=>`${s.file}:${s.line}:${s.name}`).slice(0,12);const endpoints=agent==='CODEX'?unique<CodeEndpoint>((code?.endpoints??[]).filter((e:CodeEndpoint)=>selectedFiles.includes(e.file)||scoreFile(e.file,agent)>0),e=>`${e.method}:${e.path}:${e.file}:${e.line}`).slice(0,8):[];const fileSet=new Set(selectedFiles);const edges=unique<CodeEdge>((code?.edges??[]).filter((e:CodeEdge)=>fileSet.has(e.from)||fileSet.has(e.to)),e=>`${e.from}>${e.to}:${e.type}`).slice(0,14);const repositoryHints=(context.repository?.architectureHints??[]).filter((h:string)=>agent==='CLAUDE'?/react|next|frontend|ui|client/i.test(h):/api|server|prisma|database|backend|spring|express|fastify/i.test(h)).slice(0,6);return{agent,focus,files:selectedFiles,symbols,endpoints,edges,repositoryHints,reason:`Contexto roteado para ${agent}: foco ${focus.toLowerCase()}, priorizando ${selectedFiles.length} arquivos do mapa seguro.`};}
export function buildTaskContextMap(steps:CommandPlanStep[],context:RepositoryContext):Record<string,TaskContext>{const out:Record<string,TaskContext>={};for(const step of steps){const routed=routeTaskContext(step,context);if(routed)out[step.key]=routed;}return out;}
export function appendTaskContext(prompt:string,task:TaskContext){const symbols=task.symbols.slice(0,8).map(s=>`${s.name} (${s.file}:${s.line})`).join(', '),endpoints=task.endpoints.slice(0,6).map(e=>`${e.method} ${e.path} (${e.file}:${e.line})`).join(', '),edges=task.edges.slice(0,8).map(e=>`${e.from} -> ${e.to}`).join(', ');return`${prompt}\n\n[DEVCLOUD TASK CONTEXT]\nAgente: ${task.agent}\nFoco: ${task.focus}\nArquivos priorizados: ${task.files.join(', ')||'nenhum'}${symbols?`\nSímbolos: ${symbols}`:''}${endpoints?`\nEndpoints: ${endpoints}`:''}${edges?`\nRelações: ${edges}`:''}\nUse este mapa apenas como prioridade inicial; confirme no repositório antes de alterar. Não extrapole acesso a arquivos fora do workspace.`;}
