import type { CodeEdge, CodeEndpoint, CodeIntelligence, CodeSymbol } from '@oliveira/code-intelligence';

const RAW_STOP_WORDS = [
  'a','o','as','os','de','da','do','das','dos','e','em','no','na','nos','nas','um','uma','para','por','com','sem','que','como','ao','aos',
  'the','a','an','and','or','to','of','in','on','for','with','without','is','are','be','this','that','it','from',
  'faça','faca','fazer','finalize','terminar','termine','corrija','corrigir','revise','revisar','implemente','implementar','projeto','sistema'
];
const STOP_WORDS = new Set(RAW_STOP_WORDS.map(value=>value.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase()));

export type FocusedSymbol = Pick<CodeSymbol,'name'|'kind'|'file'|'line'|'signature'> & {score:number;matchedTerms:string[]};
export type FocusedEndpoint = CodeEndpoint & {score:number;matchedTerms:string[]};
export type FocusedCodeContext = {
  objectiveTerms:string[];
  files:string[];
  symbols:FocusedSymbol[];
  endpoints:FocusedEndpoint[];
  edges:CodeEdge[];
  summary:{candidateSymbols:number;selectedSymbols:number;selectedFiles:number;selectedEndpoints:number;expandedFiles:number};
  warnings:string[];
};

function normalize(value:string){return value.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();}
function tokens(objective:string){
  const raw=normalize(objective).split(/[^a-z0-9_$./-]+/).filter(Boolean);
  return [...new Set(raw.filter(t=>t.length>=3&&!STOP_WORDS.has(t)).slice(0,48))];
}
function matches(value:string,terms:string[]){const n=normalize(value);return terms.filter(t=>n.includes(t));}
function fileBase(file:string){return file.split('/').pop()??file;}
function scoreSymbol(symbol:CodeSymbol,terms:string[]){
  const name=matches(symbol.name,terms);const file=matches(symbol.file,terms);const sig=matches(symbol.signature??'',terms);
  let score=name.length*9+file.length*5+sig.length*3;
  const normalizedName=normalize(symbol.name);
  for(const term of terms){if(normalizedName===term)score+=18;else if(normalizedName.startsWith(term)||term.startsWith(normalizedName))score+=7}
  if(symbol.kind==='route')score+=1;
  return {score,matchedTerms:[...new Set([...name,...file,...sig])]};
}
function scoreEndpoint(endpoint:CodeEndpoint,terms:string[]){
  const path=matches(endpoint.path,terms);const file=matches(endpoint.file,terms);const handler=matches(endpoint.handler??'',terms);
  return {score:path.length*10+file.length*5+handler.length*8,matchedTerms:[...new Set([...path,...file,...handler])]};
}

export function buildFocusedCodeContext(objective:string,intelligence:CodeIntelligence):FocusedCodeContext{
  const objectiveTerms=tokens(objective);
  const rankedSymbols=intelligence.symbols.map(symbol=>({...symbol,...scoreSymbol(symbol,objectiveTerms)})).filter(s=>s.score>0).sort((a,b)=>b.score-a.score||a.file.localeCompare(b.file)).slice(0,24);
  const rankedEndpoints=intelligence.endpoints.map(endpoint=>({...endpoint,...scoreEndpoint(endpoint,objectiveTerms)})).filter(e=>e.score>0).sort((a,b)=>b.score-a.score||a.file.localeCompare(b.file)).slice(0,12);
  const seedFiles=new Set<string>([...rankedSymbols.map(s=>s.file),...rankedEndpoints.map(e=>e.file)]);

  // If the objective has no lexical hit, provide a small architecture-oriented fallback instead of an empty context.
  if(seedFiles.size===0){
    for(const symbol of intelligence.symbols.filter(s=>['class','component','function','method'].includes(s.kind)).slice(0,8))seedFiles.add(symbol.file);
    for(const endpoint of intelligence.endpoints.slice(0,4))seedFiles.add(endpoint.file);
  }

  const expanded=new Set(seedFiles);
  const relevantEdges:CodeEdge[]=[];
  for(const edge of intelligence.edges){
    if(seedFiles.has(edge.from)||seedFiles.has(edge.to)){
      if(relevantEdges.length<24)relevantEdges.push(edge);
      expanded.add(edge.from);expanded.add(edge.to);
    }
    if(expanded.size>=18&&relevantEdges.length>=24)break;
  }
  const files=[...expanded].slice(0,18);
  return {
    objectiveTerms,
    files,
    symbols:rankedSymbols,
    endpoints:rankedEndpoints,
    edges:relevantEdges,
    summary:{candidateSymbols:intelligence.symbols.length,selectedSymbols:rankedSymbols.length,selectedFiles:files.length,selectedEndpoints:rankedEndpoints.length,expandedFiles:Math.max(0,files.length-seedFiles.size)},
    warnings:seedFiles.size===0?['NO_LEXICAL_MATCH_FALLBACK_USED']:[]
  };
}
