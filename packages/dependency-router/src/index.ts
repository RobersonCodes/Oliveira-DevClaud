export type Agent = 'CODEX' | 'CLAUDE';
export type PlanStep = {
  key: string;
  title: string;
  type: 'AGENT' | 'SYSTEM';
  agent?: Agent;
  prompt?: string;
  command?: string;
  dependsOn: string[];
};

export type TaskContext = {
  agent: Agent;
  focus: 'BACKEND' | 'FRONTEND' | 'GENERAL';
  files: string[];
  endpoints?: Array<{method:string;path:string;file:string;line:number}>;
  edges?: Array<{from:string;to:string;type:string}>;
};

export type DependencyDecision = {
  from: string;
  to: string;
  kind: 'API_CONTRACT' | 'MODULE_EDGE' | 'SHARED_DOMAIN';
  confidence: 'HIGH' | 'MEDIUM';
  reason: string;
};

export type DependencyRoutingResult = {
  steps: PlanStep[];
  decisions: DependencyDecision[];
  parallelPairs: Array<{left:string;right:string;reason:string}>;
};

const STOP = new Set(['para','como','com','sem','uma','uns','das','dos','que','the','and','for','with','from','into','this','that','review','revisar','implementar','implementation','interface','backend','frontend','tarefa','task','agent','agente']);
const CONTRACT_WORDS = ['api','endpoint','route','rota','contract','contrato','schema','payload','request','response','checkout','payment','pagamento','pedido','order','auth','login','session','sessao','cart','carrinho'];
const CONSUMER_WORDS = ['consume','consumir','integrar','integration','integra','chama','call','fetch','client','hook','form','page','component','ui','interface','checkout'];
const PRODUCER_WORDS = ['api','endpoint','route','controller','service','repository','database','prisma','schema','model','auth'];

function norm(v:string){return v.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');}
function terms(v:string){return Array.from(new Set(norm(v).split(/[^a-z0-9_/-]+/).filter(x=>x.length>=4&&!STOP.has(x))));}
function overlap(a:string[],b:string[]){const bs=new Set(b);return a.filter(x=>bs.has(x));}
function hasAny(text:string,words:string[]){const n=norm(text);return words.some(w=>n.includes(w));}
function pathDomainTokens(paths:string[]){return Array.from(new Set(paths.flatMap(p=>norm(p).split(/[^a-z0-9]+/).filter(x=>x.length>=4&&!['src','apps','packages','components','services','routes','pages','hooks','controller','controllers','service','repository','repositories'].includes(x)))));}

function reaches(from:string,to:string,steps:PlanStep[]){
  const byKey=new Map(steps.map(s=>[s.key,s]));
  const seen=new Set<string>();
  const visit=(key:string):boolean=>{
    if(key===to)return true;
    if(seen.has(key))return false;
    seen.add(key);
    return (byKey.get(key)?.dependsOn??[]).some(visit);
  };
  return visit(from);
}

function wouldCycle(dependent:string,dependency:string,steps:PlanStep[]){
  // Adding dependent -> dependency creates a cycle when dependency already reaches dependent.
  return reaches(dependency,dependent,steps);
}

function addDependency(steps:PlanStep[],dependent:string,dependency:string){
  return steps.map(s=>s.key===dependent?{...s,dependsOn:Array.from(new Set([...s.dependsOn,dependency]))}:s);
}

export function routeTaskDependencies(input:PlanStep[],contexts:Record<string,TaskContext>):DependencyRoutingResult {
  let steps=input.map(s=>({...s,dependsOn:[...(s.dependsOn??[])]}));
  const decisions:DependencyDecision[]=[];
  const agentSteps=steps.filter(s=>s.type==='AGENT'&&s.agent);

  for(const frontend of agentSteps.filter(s=>contexts[s.key]?.focus==='FRONTEND')){
    for(const backend of agentSteps.filter(s=>contexts[s.key]?.focus==='BACKEND'&&s.key!==frontend.key)){
      if(frontend.dependsOn.includes(backend.key)||wouldCycle(frontend.key,backend.key,steps))continue;
      const fctx=contexts[frontend.key], bctx=contexts[backend.key];
      if(!fctx||!bctx)continue;
      const ftext=`${frontend.title} ${frontend.prompt??''}`;
      const btext=`${backend.title} ${backend.prompt??''}`;
      const ft=terms(ftext), bt=terms(btext);
      const domainOverlap=overlap([...ft,...pathDomainTokens(fctx.files)], [...bt,...pathDomainTokens(bctx.files)]).filter(t=>t.length>=4);
      const backendEndpoints=bctx.endpoints??[];
      const edgeBridge=(fctx.edges??[]).some(e=>fctx.files.includes(e.from)&&bctx.files.includes(e.to)) || (bctx.edges??[]).some(e=>fctx.files.includes(e.from)&&bctx.files.includes(e.to));
      const contractIntent=hasAny(ftext,CONSUMER_WORDS)&&hasAny(btext,PRODUCER_WORDS);
      const endpointDomain=backendEndpoints.some(e=>domainOverlap.some(t=>norm(`${e.path} ${e.file}`).includes(t)));

      let decision:DependencyDecision|null=null;
      if(edgeBridge){
        decision={from:frontend.key,to:backend.key,kind:'MODULE_EDGE',confidence:'HIGH',reason:`${frontend.key} referencia módulos priorizados por ${backend.key}; o consumidor deve aguardar o produtor.`};
      }else if(backendEndpoints.length>0&&contractIntent&&endpointDomain){
        decision={from:frontend.key,to:backend.key,kind:'API_CONTRACT',confidence:'HIGH',reason:`Contrato de API relacionado ao mesmo domínio (${domainOverlap.slice(0,3).join(', ')}) conecta frontend e backend.`};
      }else if(contractIntent&&domainOverlap.length>=2&&hasAny(`${ftext} ${btext}`,CONTRACT_WORDS)){
        decision={from:frontend.key,to:backend.key,kind:'SHARED_DOMAIN',confidence:'MEDIUM',reason:`As tarefas compartilham domínio (${domainOverlap.slice(0,3).join(', ')}) e indicam relação consumidor/produtor.`};
      }
      if(decision){steps=addDependency(steps,frontend.key,backend.key);decisions.push(decision);}
    }
  }

  const parallelPairs:Array<{left:string;right:string;reason:string}>=[];
  for(let i=0;i<agentSteps.length;i++)for(let j=i+1;j<agentSteps.length;j++){
    const a=agentSteps[i],b=agentSteps[j];
    if(!reaches(a.key,b.key,steps)&&!reaches(b.key,a.key,steps))parallelPairs.push({left:a.key,right:b.key,reason:'Nenhuma dependência forte foi detectada; execução paralela preservada.'});
  }
  return {steps,decisions,parallelPairs};
}
