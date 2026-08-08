import { SecretKind } from '@oliveira/database';
import { resolveSecretByKind } from './secretResolver.js';
import { commandPlanJsonSchema, plannerSystemPrompt, validateAndNormalizeAiPlan, type CommandPlan, type PlannerProvider, type RepositoryContext } from '@oliveira/command-center-engine';

const OPENAI_URL='https://api.openai.com/v1/responses';
const ANTHROPIC_URL='https://api.anthropic.com/v1/messages';

function extractJson(text:string){
  const trimmed=text.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');
  return JSON.parse(trimmed);
}

async function planWithOpenAI(apiKey:string, objective:string, context:RepositoryContext):Promise<CommandPlan>{
  const response=await fetch(OPENAI_URL,{method:'POST',headers:{'content-type':'application/json','authorization':`Bearer ${apiKey}`},body:JSON.stringify({
    model:process.env.OPENAI_PLANNER_MODEL??'gpt-5-mini',
    instructions:plannerSystemPrompt(context),
    input:`Objetivo do usuário:\n${objective}`,
    text:{format:{type:'json_schema',name:'command_plan',strict:true,schema:commandPlanJsonSchema}}
  }),signal:AbortSignal.timeout(Number(process.env.AI_PLANNER_TIMEOUT_MS??30000))});
  if(!response.ok) throw new Error(`OPENAI_PLANNER_HTTP_${response.status}`);
  const data:any=await response.json();
  const text=typeof data.output_text==='string'?data.output_text:data.output?.flatMap((o:any)=>o.content??[]).find((c:any)=>typeof c.text==='string')?.text;
  if(!text) throw new Error('OPENAI_PLANNER_EMPTY_RESPONSE');
  return validateAndNormalizeAiPlan(extractJson(text));
}

async function planWithAnthropic(apiKey:string, objective:string, context:RepositoryContext):Promise<CommandPlan>{
  const response=await fetch(ANTHROPIC_URL,{method:'POST',headers:{'content-type':'application/json','x-api-key':apiKey,'anthropic-version':'2023-06-01'},body:JSON.stringify({
    model:process.env.ANTHROPIC_PLANNER_MODEL??'claude-sonnet-4-5',
    max_tokens:3000,
    system:plannerSystemPrompt(context)+'\nResponda somente JSON válido, sem markdown.',
    messages:[{role:'user',content:`Objetivo do usuário:\n${objective}`}]
  }),signal:AbortSignal.timeout(Number(process.env.AI_PLANNER_TIMEOUT_MS??30000))});
  if(!response.ok) throw new Error(`ANTHROPIC_PLANNER_HTTP_${response.status}`);
  const data:any=await response.json();
  const text=data.content?.find((c:any)=>c.type==='text')?.text;
  if(!text) throw new Error('ANTHROPIC_PLANNER_EMPTY_RESPONSE');
  return validateAndNormalizeAiPlan(extractJson(text));
}

export async function buildAiPlan(args:{organizationId:string;provider:Exclude<PlannerProvider,'DETERMINISTIC'>;objective:string;context:RepositoryContext}){
  if(args.provider==='OPENAI'){
    const key=await resolveSecretByKind(args.organizationId,SecretKind.OPENAI_API_KEY);
    if(!key) throw new Error('OPENAI_API_KEY_NOT_CONFIGURED');
    return planWithOpenAI(key,args.objective,args.context);
  }
  const key=await resolveSecretByKind(args.organizationId,SecretKind.ANTHROPIC_API_KEY);
  if(!key) throw new Error('ANTHROPIC_API_KEY_NOT_CONFIGURED');
  return planWithAnthropic(key,args.objective,args.context);
}
