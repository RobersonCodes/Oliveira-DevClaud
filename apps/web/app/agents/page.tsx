'use client';

import { useEffect, useMemo, useState } from 'react';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
type Agent = 'CODEX' | 'CLAUDE';
type Task = {
  id:string; workspaceId:string; agent:Agent; title:string; prompt:string; status:string;
  startedAt?:string|null; finishedAt?:string|null; exitCode?:number|null;
  branchName?:string|null; worktreePath?:string|null; baseCommit?:string|null;
  reviewStatus?:'PENDING'|'READY'|'MERGED'|'REJECTED'; mergeCommit?:string|null;
};
type Changes = { branchName:string; baseCommit:string; status:string; files:string; committedStat:string; committedDiff:string; workingStat:string; workingDiff:string };

export default function AgentsPage() {
  const [workspaceId,setWorkspaceId]=useState('');
  const [tasks,setTasks]=useState<Task[]>([]);
  const [agent,setAgent]=useState<Agent>('CODEX');
  const [title,setTitle]=useState('Implementar tarefa');
  const [prompt,setPrompt]=useState('Analise o projeto, implemente a tarefa solicitada e execute os testes relevantes. Não altere arquivos fora do escopo da tarefa.');
  const [selected,setSelected]=useState<string>('');
  const [logs,setLogs]=useState('');
  const [changes,setChanges]=useState<Changes|null>(null);
  const [message,setMessage]=useState('');
  const [reviewBusy,setReviewBusy]=useState(false);
  const selectedTask=useMemo(()=>tasks.find(t=>t.id===selected),[tasks,selected]);

  useEffect(()=>{ setWorkspaceId(new URLSearchParams(window.location.search).get('workspaceId') ?? ''); },[]);
  async function load(){ if(!workspaceId)return; const r=await fetch(`${API}/api/v1/agents?workspaceId=${encodeURIComponent(workspaceId)}`,{credentials:'include'}); if(r.ok)setTasks(await r.json()); }
  useEffect(()=>{ load(); },[workspaceId]);
  useEffect(()=>{ setChanges(null); },[selected]);
  useEffect(()=>{ if(!workspaceId)return; const timer=setInterval(async()=>{ await load(); if(selected){ const s=await fetch(`${API}/api/v1/agents/${selected}/status`,{credentials:'include'}); if(s.ok){ const updated=await s.json(); setTasks(current=>current.map(t=>t.id===selected?{...t,...updated}:t)); } const l=await fetch(`${API}/api/v1/agents/${selected}/logs?lines=500`,{credentials:'include'}); if(l.ok)setLogs((await l.json()).logs ?? ''); } },3000); return()=>clearInterval(timer); },[workspaceId,selected]);

  async function create(){
    if(!workspaceId){setMessage('Abra /agents?workspaceId=...');return;}
    setMessage('Criando Git Worktree e iniciando agente...');
    const r=await fetch(`${API}/api/v1/agents`,{method:'POST',credentials:'include',headers:{'content-type':'application/json'},body:JSON.stringify({workspaceId,agent,title,prompt,startNow:true})});
    const body=await r.json().catch(()=>({}));
    if(!r.ok){setMessage(body.error ?? 'Falha ao iniciar agente.');return;}
    setTasks(c=>[body,...c]); setSelected(body.id); setMessage(`Agente iniciado isoladamente em ${body.branchName ?? 'worktree próprio'}.`);
  }
  async function cancel(id:string){ await fetch(`${API}/api/v1/agents/${id}/cancel`,{method:'POST',credentials:'include'}); await load(); }
  async function viewChanges(){
    if(!selected)return; setReviewBusy(true);
    const r=await fetch(`${API}/api/v1/agents/${selected}/changes`,{credentials:'include'});
    const body=await r.json().catch(()=>({}));
    if(r.ok)setChanges(body); else setMessage(body.error ?? 'Não foi possível carregar o diff.');
    setReviewBusy(false);
  }
  async function reviewAction(action:'merge'|'reject'){
    if(!selectedTask)return;
    const text=action==='merge'?'Mesclar as alterações deste agente na branch principal?':'Rejeitar e remover o worktree/branch deste agente?';
    if(!window.confirm(text))return;
    setReviewBusy(true); setMessage(action==='merge'?'Realizando merge controlado...':'Descartando worktree isolado...');
    const r=await fetch(`${API}/api/v1/agents/${selectedTask.id}/${action}`,{method:'POST',credentials:'include'});
    const body=await r.json().catch(()=>({}));
    setMessage(r.ok ? (action==='merge'?`Merge concluído: ${body.mergeCommit?.slice(0,10) ?? 'OK'}`:'Alterações rejeitadas e isolamento removido.') : (body.error ?? `Falha ao ${action}.`));
    setChanges(null); await load(); setReviewBusy(false);
  }

  return <main><aside><div className="brand">OLIVEIRA<br/><span>DEVCLOUD</span></div><nav><a href="/">Overview</a><br/><a href="/projects">Projects</a><br/><a href="/workspaces">Workspaces</a><br/><b>Agents</b><br/><a href={`/terminal?workspaceId=${workspaceId}`}>Terminal</a><br/>Git<br/>Logs<br/>Settings</nav></aside><section className="content agents-page"><header><div><p className="eyebrow">MULTI-AGENT ISOLATION</p><h1>Agents v0.7</h1><p className="muted">Codex e Claude Code trabalham em branches/worktrees separados antes de qualquer merge.</p></div><span className="button">{workspaceId ? 'Workspace conectado' : 'Sem workspace'}</span></header>
    <div className="agent-layout"><section className="agent-compose"><div className="agent-switch"><button className={agent==='CODEX'?'active':''} onClick={()=>setAgent('CODEX')}>Codex</button><button className={agent==='CLAUDE'?'active':''} onClick={()=>setAgent('CLAUDE')}>Claude Code</button></div><label>Título<input value={title} onChange={e=>setTitle(e.target.value)}/></label><label>Prompt<textarea value={prompt} onChange={e=>setPrompt(e.target.value)} rows={10}/></label><button onClick={create} disabled={!workspaceId}>Executar em Worktree isolado</button><p className="message">{message}</p></section>
    <section className="agent-list"><p className="eyebrow">TASKS</p>{tasks.length===0?<div className="agent-empty">Nenhuma tarefa ainda.</div>:tasks.map(t=><button key={t.id} className={selected===t.id?'agent-card active':'agent-card'} onClick={()=>setSelected(t.id)}><span>{t.agent}</span><strong>{t.title}</strong><small>{t.status} · {t.reviewStatus ?? 'PENDING'}</small>{t.branchName&&<code>{t.branchName}</code>}</button>)}</section>
    <section className="agent-console"><div className="agent-console-bar"><div><span>{selectedTask?.agent ?? 'AGENT'}</span><strong>{selectedTask?.status ?? 'Selecione uma tarefa'}</strong></div><div className="review-actions">{selectedTask?.status==='RUNNING'&&<button className="danger" onClick={()=>cancel(selectedTask.id)}>Parar</button>}{selectedTask?.worktreePath&&selectedTask?.reviewStatus!=='MERGED'&&selectedTask?.reviewStatus!=='REJECTED'&&<button onClick={viewChanges} disabled={reviewBusy}>Comparar</button>}</div></div>
      <pre>{logs || 'Os logs da sessão aparecerão aqui.'}</pre>
      {changes&&<div className="review-panel"><div className="review-heading"><div><p className="eyebrow">CHANGE REVIEW</p><strong>{changes.branchName}</strong><small>base {changes.baseCommit.slice(0,10)}</small></div><div className="review-actions"><button onClick={()=>reviewAction('merge')} disabled={reviewBusy||selectedTask?.status==='RUNNING'}>Merge</button><button className="danger" onClick={()=>reviewAction('reject')} disabled={reviewBusy||selectedTask?.status==='RUNNING'}>Reject</button></div></div><div className="review-grid"><div><h3>Status</h3><pre>{changes.status||'clean'}</pre></div><div><h3>Arquivos</h3><pre>{changes.files||changes.workingStat||'Sem alterações detectadas.'}</pre></div></div><h3>Diff</h3><pre className="diff-view">{[changes.committedDiff,changes.workingDiff].filter(Boolean).join('\n')||'Nenhuma diferença textual.'}</pre></div>}
    </section></div>
  </section></main>;
}
