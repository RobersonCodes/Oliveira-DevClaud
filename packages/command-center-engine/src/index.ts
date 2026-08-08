export type RepositoryContext = { stack?: string; packageManager?: string | null; suggestedPorts?: number[]; files?: string[]; contracts?: { summary?: {contracts:number;consumers:number;issues:number;highRisk:number}; contracts?: Array<{method:string;path:string;file:string;line:number;requestFields?:Array<{name:string}>;responseFields?:Array<{name:string}>}>; consumers?: Array<{method:string;path:string;file:string;line:number;requestFields?:string[]}>; issues?: Array<{severity:string;kind:string;message:string}> }; repository?: { topLevelDirectories?: string[]; manifests?: string[]; scripts?: Record<string,string>; dependencies?: string[]; devDependencies?: string[]; architectureHints?: string[]; testFiles?: number; routeFiles?: number; sourceFiles?: number; git?: { branch?: string; head?: string; changedFiles?: string[]; recentCommits?: string[] }; warnings?: string[] }; code?: { objectiveTerms?: string[]; files?: string[]; symbols?: Array<{name:string;kind:string;file:string;line:number;signature?:string;score?:number}>; endpoints?: Array<{method:string;path:string;file:string;line:number;handler?:string;score?:number}>; edges?: Array<{from:string;to:string;type:string}>; summary?: Record<string,number>; warnings?: string[] } };
export type CommandPlanStep = { key:string; title:string; type:'AGENT'|'SYSTEM'; agent?:'CODEX'|'CLAUDE'; prompt?:string; command?:string; dependsOn:string[] };
export type CommandPlan = { title:string; rationale:string; steps:CommandPlanStep[] };
export type PlannerProvider = 'DETERMINISTIC'|'OPENAI'|'ANTHROPIC';

const ALLOWED_SYSTEM_COMMANDS = new Set(['npm test','npm run test','npm run build','npm run lint','npm run typecheck']);
const MAX_STEPS = 12;

function mentions(text:string, words:string[]){const v=text.toLowerCase();return words.some(w=>v.includes(w));}
export function buildCommandPlan(objective:string, context:RepositoryContext):CommandPlan {
  const frontend=mentions(objective,['front','interface','ui','ux','responsiv','tela','checkout','css','react','next']);
  const backend=mentions(objective,['back','api','banco','database','endpoint','auth','pagamento','pedido','service']);
  const quality=mentions(objective,['teste','test','corrig','finaliz','termin','review','revis','produção','production']);
  const steps:CommandPlanStep[]=[];
  const focusedFiles=context.code?.files?.slice(0,8)??[];
  const focusedSymbols=context.code?.symbols?.slice(0,10).map(s=>`${s.name} (${s.file}:${s.line})`)??[];
  const contractSummary=context.contracts?.summary;
  const ctx=`Stack detectada: ${context.stack??'UNKNOWN'}${context.packageManager?`; package manager: ${context.packageManager}`:''}.`+(focusedFiles.length?`\nArquivos provavelmente relacionados: ${focusedFiles.join(', ')}.`:'')+(focusedSymbols.length?`\nSímbolos relacionados: ${focusedSymbols.join(', ')}.`:'')+(contractSummary?`\nContract Intelligence: ${contractSummary.contracts} endpoints produtores, ${contractSummary.consumers} consumidores e ${contractSummary.issues} alertas (${contractSummary.highRisk} de alto risco).`:'' );
  if(backend || !frontend) steps.push({key:'codex-implementation',title:'Implementação técnica',type:'AGENT',agent:'CODEX',prompt:`Objetivo: ${objective}\n${ctx}\nAnalise o repositório antes de alterar. Implemente a parte técnica/backend necessária, preserve a arquitetura existente e não altere arquivos sem necessidade.`,dependsOn:[]});
  if(frontend || !backend) steps.push({key:'claude-review',title:'Interface e revisão',type:'AGENT',agent:'CLAUDE',prompt:`Objetivo: ${objective}\n${ctx}\nAnalise o repositório antes de alterar. Trabalhe na interface/UX e faça revisão cuidadosa das mudanças necessárias, preservando padrões existentes.`,dependsOn:[]});
  const agents=steps.map(s=>s.key);
  const jsStack=['NEXTJS','REACT_VITE','NODEJS'].includes(String(context.stack??'').toUpperCase());
  if(jsStack && (quality || agents.length)){steps.push({key:'tests',title:'Quality gate · tests',type:'SYSTEM',command:'npm test',dependsOn:agents});steps.push({key:'build',title:'Quality gate · build',type:'SYSTEM',command:'npm run build',dependsOn:['tests']});}
  return {title: objective.length>72?`${objective.slice(0,69)}...`:objective,rationale:'Fallback determinístico e auditável baseado no objetivo e na stack detectada.',steps};
}

function assertString(value:unknown,name:string,min=1,max=6000){
  if(typeof value!=='string'||value.length<min||value.length>max) throw new Error(`INVALID_${name.toUpperCase()}`);
  return value;
}

export function validateAndNormalizeAiPlan(input:unknown):CommandPlan {
  if(!input||typeof input!=='object') throw new Error('AI_PLAN_NOT_OBJECT');
  const raw=input as Record<string,unknown>;
  const title=assertString(raw.title,'title',1,120);
  const rationale=assertString(raw.rationale,'rationale',1,2000);
  if(!Array.isArray(raw.steps)||raw.steps.length<1||raw.steps.length>MAX_STEPS) throw new Error('AI_PLAN_INVALID_STEP_COUNT');
  const steps:CommandPlanStep[]=raw.steps.map((item,index)=>{
    if(!item||typeof item!=='object') throw new Error(`AI_PLAN_INVALID_STEP_${index}`);
    const s=item as Record<string,unknown>;
    const key=assertString(s.key,'step_key',1,64).toLowerCase();
    if(!/^[a-z][a-z0-9_-]{0,63}$/.test(key)) throw new Error(`AI_PLAN_INVALID_KEY:${key}`);
    const stepTitle=assertString(s.title,'step_title',1,160);
    const type=s.type;
    if(type!=='AGENT'&&type!=='SYSTEM') throw new Error(`AI_PLAN_INVALID_TYPE:${key}`);
    const dependsOn=Array.isArray(s.dependsOn)?s.dependsOn.map((d)=>assertString(d,'dependency',1,64).toLowerCase()):[];
    if(type==='AGENT'){
      if(s.agent!=='CODEX'&&s.agent!=='CLAUDE') throw new Error(`AI_PLAN_INVALID_AGENT:${key}`);
      const prompt=assertString(s.prompt,'agent_prompt',10,6000);
      return {key,title:stepTitle,type,agent:s.agent,prompt,dependsOn};
    }
    const command=assertString(s.command,'system_command',1,120);
    if(!ALLOWED_SYSTEM_COMMANDS.has(command)) throw new Error(`AI_PLAN_COMMAND_NOT_ALLOWED:${command}`);
    return {key,title:stepTitle,type,command,dependsOn};
  });
  return {title,rationale,steps};
}

export function plannerSystemPrompt(context:RepositoryContext){
  return `Você é o planner seguro do Oliveira DevCloud. Gere SOMENTE um plano JSON para executar o objetivo do usuário.\n\nContexto do repositório: ${JSON.stringify(context)}\n\nRegras obrigatórias:\n- Máximo de ${MAX_STEPS} etapas.\n- type deve ser AGENT ou SYSTEM.\n- AGENT usa somente CODEX ou CLAUDE.\n- SYSTEM usa somente um destes comandos exatos: ${Array.from(ALLOWED_SYSTEM_COMMANDS).join(', ')}.\n- Não crie comandos shell arbitrários.\n- Não inclua secrets, tokens, URLs privadas ou instruções para contornar segurança.\n- Cada key deve seguir ^[a-z][a-z0-9_-]{0,63}$.\n- dependsOn deve referenciar keys existentes.\n- Prefira paralelismo entre agentes quando seguro.\n- Coloque quality gates depois das etapas de implementação.\n- O resultado deve ter exatamente: title, rationale, steps.`;
}

export const commandPlanJsonSchema = {
  type:'object', additionalProperties:false, required:['title','rationale','steps'],
  properties:{
    title:{type:'string',minLength:1,maxLength:120}, rationale:{type:'string',minLength:1,maxLength:2000},
    steps:{type:'array',minItems:1,maxItems:MAX_STEPS,items:{type:'object',additionalProperties:false,required:['key','title','type','dependsOn'],properties:{
      key:{type:'string',pattern:'^[a-z][a-z0-9_-]{0,63}$'}, title:{type:'string',minLength:1,maxLength:160}, type:{type:'string',enum:['AGENT','SYSTEM']},
      agent:{type:'string',enum:['CODEX','CLAUDE']}, prompt:{type:'string',minLength:10,maxLength:6000}, command:{type:'string',enum:Array.from(ALLOWED_SYSTEM_COMMANDS)},
      dependsOn:{type:'array',items:{type:'string',pattern:'^[a-z][a-z0-9_-]{0,63}$'}}
    }}}
  }
} as const;
