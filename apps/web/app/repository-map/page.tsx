'use client';
import { useEffect, useMemo, useState } from 'react';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
type Kind = 'source'|'test'|'route'|'manifest'|'config'|'infra'|'other';
type TreeNode = { name:string; path:string; type:'directory'|'file'; kind?:Kind; children?:TreeNode[] };
type Intelligence = {
  generatedAt:string; files:string[]; tree:TreeNode[]; topLevelDirectories:string[]; manifests:string[]; architectureHints:string[];
  testFiles:number; routeFiles:number; sourceFiles:number; warnings:string[];
  git:{branch?:string;head?:string;changedFiles:string[];clean:boolean;recentCommits:string[]};
};
type Response = { intelligence:Intelligence; cache:{hit:boolean;cacheable:boolean;reason:string;commitSha?:string} };

const kindLabels:Record<Kind,string>={source:'SOURCE',test:'TEST',route:'ROUTE',manifest:'MANIFEST',config:'CONFIG',infra:'INFRA',other:'FILE'};

function Node({node,depth=0}:{node:TreeNode;depth?:number}){
  const [open,setOpen]=useState(depth<2);
  if(node.type==='file') return <div className="repo-node repo-file" style={{paddingLeft:depth*16}}><span className={`repo-kind ${node.kind??'other'}`}>{kindLabels[node.kind??'other']}</span><span>{node.name}</span></div>;
  return <div><button className="repo-node repo-dir" style={{paddingLeft:depth*16}} onClick={()=>setOpen(v=>!v)}><span>{open?'▾':'▸'}</span><b>{node.name}</b><small>{node.children?.length??0}</small></button>{open&&node.children?.map(child=><Node key={child.path} node={child} depth={depth+1}/>)}</div>;
}

export default function RepositoryMap(){
  const [workspaceId,setWorkspaceId]=useState('');
  const [data,setData]=useState<Response|null>(null);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  useEffect(()=>setWorkspaceId(new URLSearchParams(location.search).get('workspaceId')??''),[]);
  async function load(refresh=false){
    if(!workspaceId)return; setBusy(true); setError('');
    const r=await fetch(`${API}/api/v1/repository-intelligence/${workspaceId}${refresh?'?refresh=true':''}`,{credentials:'include'});
    const body=await r.json().catch(()=>({}));
    if(r.ok)setData(body); else setError(body.error??`HTTP_${r.status}`);
    setBusy(false);
  }
  useEffect(()=>{if(workspaceId)void load(false)},[workspaceId]);
  const changed=useMemo(()=>new Set(data?.intelligence.git.changedFiles??[]),[data]);
  return <main className="repo-map-page"><header className="repo-map-head"><div><a className="back-link" href="/">← Control Plane</a><p className="eyebrow">OLIVEIRA DEVCLOUD · v1.8</p><h1>Repository Map</h1><p>Mapa estrutural seguro do repositório com cache incremental por commit SHA.</p></div><div className="head-actions"><button className="ghost-btn" disabled={busy||!workspaceId} onClick={()=>load(true)}>Reanalisar</button><a className="primary-link" href={`/command-center?workspaceId=${workspaceId}`}>Abrir Command Center</a></div></header>
  {!workspaceId&&<section className="dash-panel"><p>Abra esta página com <code>?workspaceId=...</code>.</p></section>}
  {error&&<section className="dash-panel"><p>Falha: <code>{error}</code></p></section>}
  {data&&<><div className="metric-grid repo-metrics"><article><span>Arquivos-fonte</span><strong>{data.intelligence.sourceFiles}</strong><small>mapa limitado a 400 arquivos</small></article><article><span>Testes</span><strong>{data.intelligence.testFiles}</strong><small>arquivos detectados</small></article><article><span>Rotas/controllers</span><strong>{data.intelligence.routeFiles}</strong><small>camada HTTP/API</small></article><article><span>Cache</span><strong>{data.cache.hit?'HIT':'MISS'}</strong><small>{data.cache.reason}</small></article></div>
  <div className="repo-layout"><section className="repo-tree-panel"><div className="panel-title"><div><p className="eyebrow">STRUCTURE</p><h2>Árvore do repositório</h2></div><span className="status-pill">{busy?'ANALYZING':'READY'}</span></div><div className="repo-tree">{data.intelligence.tree.map(node=><Node key={node.path} node={node}/>)}</div></section>
  <aside className="repo-insights"><section><p className="eyebrow">GIT REVISION</p><h3>{data.intelligence.git.branch||'branch desconhecida'}</h3><code>{data.intelligence.git.head?.slice(0,12)||'HEAD indisponível'}</code><p className={data.intelligence.git.clean?'repo-clean':'repo-dirty'}>{data.intelligence.git.clean?'✓ worktree limpo':`● ${changed.size} arquivo(s) modificado(s)`}</p></section>
  <section><p className="eyebrow">ARQUITETURA</p><div className="repo-tags">{data.intelligence.architectureHints.length?data.intelligence.architectureHints.map(v=><span key={v}>{v}</span>):<small>Nenhum padrão adicional detectado.</small>}</div></section>
  <section><p className="eyebrow">MANIFESTS</p><div className="repo-tags">{data.intelligence.manifests.map(v=><span key={v}>{v}</span>)}</div></section>
  <section><p className="eyebrow">CACHE POLICY</p><p>Repos limpos usam snapshot por SHA. Worktrees com alterações locais são sempre reanalisados para não servir um mapa obsoleto.</p><small>Gerado: {new Date(data.intelligence.generatedAt).toLocaleString('pt-BR')}</small></section>
  {data.intelligence.warnings.length>0&&<section><p className="eyebrow">WARNINGS</p>{data.intelligence.warnings.map(w=><code key={w} className="repo-warning">{w}</code>)}</section>}</aside></div></>}
  </main>;
}
