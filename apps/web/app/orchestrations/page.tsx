'use client';
import { useEffect, useState } from 'react';

const API=process.env.NEXT_PUBLIC_API_URL??'http://localhost:4000';
type Step={id:string;key:string;title:string;type:string;agent?:string;status:string;dependsOn:string[];exitCode?:number};
type Gate={command:string;exitCode:number;output:string;ok:boolean};
type ContractFinding={severity:'BLOCK'|'WARN'|'INFO';kind:string;endpoint?:string;message:string};
type ContractGate={ok:boolean;blocking:ContractFinding[];warnings:ContractFinding[];info:ContractFinding[];baseline:{contracts:number;consumers:number;issues:number;highRisk:number};candidate:{contracts:number;consumers:number;issues:number;highRisk:number}};
type RegressionFinding={id:string;type:string;severity:'LOW'|'MEDIUM'|'HIGH';confidence:string;blocking:boolean;title:string;description:string;files:string[];symbols?:string[];endpoints?:string[]};
type RegressionMetrics={sourceFileCount:number;testFileCount:number;endpointCount:number;symbolCount:number;classCount:number;functionCount:number;componentCount:number;consumerCount:number;contractCount:number};
type RegressionChanges={filesAdded:string[];filesModified:string[];filesDeleted:string[];testsAdded:string[];testsDeleted:string[];endpointsAdded:string[];endpointsRemoved:string[];symbolsAdded:string[];symbolsRemoved:string[];criticalSymbolsModified:string[]};
type RegressionReport={baseline:RegressionMetrics;candidate:RegressionMetrics;changes:RegressionChanges;regressions:RegressionFinding[];warnings:RegressionFinding[];riskScore:number;riskLevel:'LOW'|'MEDIUM'|'HIGH'|'CRITICAL';blocking:boolean;blockingReasons:string[];summary:string};
type ReviewSummary={conflicts?:string[];mergedBranches?:string[];gates?:Gate[];ready?:boolean;contractGate?:ContractGate|null;regressionIntelligence?:RegressionReport|null};
type Flow={id:string;title:string;objective:string;status:string;reviewStatus:string;reviewSummary?:ReviewSummary;mergeCommit?:string;steps:Step[]};

const riskLevelClass:Record<string,string>={LOW:'risk-low',MEDIUM:'risk-medium',HIGH:'risk-high',CRITICAL:'risk-critical'};
const severityLabel:Record<string,string>={HIGH:'HIGH',MEDIUM:'MEDIUM',LOW:'LOW'};

function gateOk(gates:Gate[]|undefined,needle:RegExp){const g=gates?.find(x=>needle.test(x.command));return g?g.ok:undefined}

function MergeRiskCard({report,gates,contractGateOk}:{report:RegressionReport;gates?:Gate[];contractGateOk?:boolean}){
 const [open,setOpen]=useState(false);
 const badges:{label:string;ok:boolean|undefined}[]=[
  {label:'TESTS',ok:gateOk(gates,/\btest\b/i)},
  {label:'BUILD',ok:gateOk(gates,/\bbuild\b/i)},
  {label:'CONTRACTS',ok:contractGateOk},
  {label:'REGRESSIONS',ok:!report.blocking}
 ];
 const grouped:Record<string,RegressionFinding[]>={HIGH:[],MEDIUM:[]};
 for(const f of report.regressions)(grouped[f.severity]??=[]).push(f);
 return <div className="risk-card">
  <div className="risk-head">
   <div><span className="eyebrow">MERGE RISK</span><h3 className={riskLevelClass[report.riskLevel]}>{report.riskLevel}</h3></div>
   <div className="risk-score"><strong>{report.riskScore}</strong><span>/100</span></div>
  </div>
  <p className="risk-summary">{report.summary}</p>
  <div className="risk-badges">{badges.map(g=><span key={g.label} className={`risk-badge ${g.ok===undefined?'neutral':g.ok?'ok':'fail'}`}>{g.ok===undefined?'—':g.ok?'✓':'✗'} {g.label}</span>)}</div>
  {report.blocking&&<div className="risk-blocking"><b>Merge bloqueado automaticamente</b><ul>{report.blockingReasons.map((r,i)=><li key={i}>{r}</li>)}</ul></div>}
  {(['HIGH','MEDIUM'] as const).map(sev=>grouped[sev]?.length?<div className="risk-group" key={sev}>
   <h4>{severityLabel[sev]}</h4>
   {grouped[sev].map(f=><article className="risk-finding" key={f.id}>
    <div className="risk-finding-head"><b>{f.type}</b>{f.blocking&&<span className="risk-badge fail">BLOCKING</span>}</div>
    {(f.endpoints?.length?f.endpoints:f.symbols)?.length?<code>{(f.endpoints?.length?f.endpoints:f.symbols)!.join(', ')}</code>:null}
    <p>{f.description}</p>
    {f.files.length>0&&<small>Arquivos: {f.files.slice(0,5).join(', ')}{f.files.length>5?` +${f.files.length-5}`:''}</small>}
   </article>)}
  </div>:null)}
  {report.warnings.length>0&&<details className="risk-group risk-warnings"><summary>Warnings ({report.warnings.length})</summary>
   {report.warnings.map(f=><article className="risk-finding" key={f.id}><div className="risk-finding-head"><b>{f.type}</b></div><p>{f.description}</p></article>)}
  </details>}
  <details className="risk-baseline" open={open} onToggle={e=>setOpen((e.target as HTMLDetailsElement).open)}>
   <summary>Baseline → Candidato</summary>
   <div className="risk-metrics">
    <div><span>Tests</span><strong>{report.baseline.testFileCount} → {report.candidate.testFileCount}</strong></div>
    <div><span>Endpoints</span><strong>{report.baseline.endpointCount} → {report.candidate.endpointCount}</strong></div>
    <div><span>Symbols</span><strong>{report.baseline.symbolCount} → {report.candidate.symbolCount}</strong></div>
    <div><span>Files</span><strong>{report.baseline.sourceFileCount} → {report.candidate.sourceFileCount}</strong></div>
   </div>
   <p className="risk-changes">{report.changes.filesModified.length} modificados · {report.changes.filesAdded.length} adicionados · {report.changes.filesDeleted.length} removidos</p>
  </details>
 </div>;
}

export default function OrchestrationsPage(){
 const [workspaceId,setWorkspaceId]=useState(''); const [flows,setFlows]=useState<Flow[]>([]); const [message,setMessage]=useState('');
 async function load(){if(!workspaceId)return;const r=await fetch(`${API}/api/v1/orchestrations?workspaceId=${workspaceId}`,{credentials:'include'});if(r.ok)setFlows(await r.json())}
 useEffect(()=>{const id=new URLSearchParams(location.search).get('workspaceId')??'';setWorkspaceId(id)},[]);
 useEffect(()=>{load();const t=setInterval(load,3000);return()=>clearInterval(t)},[workspaceId]);
 async function action(id:string,path:string){setMessage('Processando...');const r=await fetch(`${API}/api/v1/orchestrations/${id}/${path}`,{method:'POST',credentials:'include'});const data=await r.json().catch(()=>({}));setMessage(r.ok?'Operação concluída.':`Falha: ${data.error??r.status}`);await load()}
 async function createDemo(){const body={workspaceId,title:'Checkout delivery',objective:'Implementar e validar checkout',startNow:true,steps:[{key:'backend',title:'Implementar backend',type:'AGENT',agent:'CODEX',prompt:'Implemente o backend necessário para concluir o checkout. Execute testes relevantes.',dependsOn:[]},{key:'frontend',title:'Revisar frontend',type:'AGENT',agent:'CLAUDE',prompt:'Revise e melhore o frontend do checkout. Preserve a arquitetura existente.',dependsOn:[]},{key:'test',title:'Executar testes',type:'SYSTEM',command:'npm test',dependsOn:['backend','frontend']},{key:'build',title:'Validar build',type:'SYSTEM',command:'npm run build',dependsOn:['test']}]};const r=await fetch(`${API}/api/v1/orchestrations`,{method:'POST',headers:{'content-type':'application/json'},credentials:'include',body:JSON.stringify(body)});setMessage(r.ok?'Orquestração iniciada.':'Falha ao iniciar.');await load()}
 return <main className="page"><div className="hero"><div><span className="eyebrow">REVIEW & MERGE · v2.5</span><h1>Orquestrações</h1><p>Coordene Codex e Claude, execute testes/build e bloqueie regressões de contrato e de código antes do merge final.</p></div><button className="primary" onClick={createDemo} disabled={!workspaceId}>Criar fluxo demonstrativo</button></div>{message&&<p>{message}</p>} {!workspaceId&&<div className="panel"><p>Abra esta página com <code>?workspaceId=...</code>.</p></div>}{flows.map(f=><section className="panel" key={f.id}><div className="row"><div><h2>{f.title}</h2><p>{f.objective}</p></div><div><span className="pill">{f.status}</span> <span className="pill">review: {f.reviewStatus}</span></div></div><div className="row"><div><button onClick={()=>action(f.id,'review/analyze')} disabled={!['WAITING_REVIEW','RUNNING'].includes(f.status)}>Analisar integração</button> <button className="primary" onClick={()=>action(f.id,'review/approve')} disabled={f.reviewStatus!=='READY'}>Aprovar e mesclar</button> <button onClick={()=>action(f.id,'review/reject')} disabled={!['READY','CONFLICT','GATE_FAILED','ANALYZING'].includes(f.reviewStatus)}>Rejeitar review</button></div>{f.mergeCommit&&<code>{f.mergeCommit.slice(0,12)}</code>}</div>{f.reviewSummary&&<div className="card"><h3>Review integrado</h3><p>Branches: {f.reviewSummary.mergedBranches?.join(', ')||'—'}</p><p>Conflitos: {f.reviewSummary.conflicts?.length?f.reviewSummary.conflicts.join(', '):'nenhum'}</p>{f.reviewSummary.gates?.map(g=><div key={g.command}><p><b>{g.ok?'✓':'✗'} {g.command}</b> · exit {g.exitCode}</p>{!g.ok&&<pre style={{whiteSpace:'pre-wrap',maxHeight:220,overflow:'auto'}}>{g.output}</pre>}</div>)}{f.reviewSummary.contractGate&&<div><h3>Contract Gate · {f.reviewSummary.contractGate.ok?'PASS':'BLOCK'}</h3><p>Baseline: {f.reviewSummary.contractGate.baseline.contracts} endpoints · Candidato: {f.reviewSummary.contractGate.candidate.contracts} endpoints</p>{f.reviewSummary.contractGate.blocking.map((x,n)=><p key={`b-${n}`}><b>BLOCK · {x.kind}</b>{x.endpoint?` · ${x.endpoint}`:''}<br/>{x.message}</p>)}{f.reviewSummary.contractGate.warnings.map((x,n)=><p key={`w-${n}`}><b>WARN · {x.kind}</b>{x.endpoint?` · ${x.endpoint}`:''}<br/>{x.message}</p>)}</div>}{f.reviewSummary.regressionIntelligence&&<MergeRiskCard report={f.reviewSummary.regressionIntelligence} gates={f.reviewSummary.gates} contractGateOk={f.reviewSummary.contractGate?.ok}/>}</div>}<div className="cards">{f.steps.map(s=><article className="card" key={s.id}><span className="eyebrow">{s.type}{s.agent?` · ${s.agent}`:''}</span><h3>{s.title}</h3><p>Status: <b>{s.status}</b></p><p>Depende de: {s.dependsOn.length?s.dependsOn.join(', '):'—'}</p>{s.exitCode!==undefined&&<p>Exit code: {s.exitCode}</p>}</article>)}</div></section>)}</main>
}
