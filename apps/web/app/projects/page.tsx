'use client';
import { useEffect, useState } from 'react';
import { apiFetch } from '../../lib/apiClient';
export default function Projects(){const [orgs,setOrgs]=useState<any[]>([]);const [projects,setProjects]=useState<any[]>([]);const [status,setStatus]=useState('Carregando...');
 useEffect(()=>{apiFetch('/api/v1/organizations').then(r=>r.json()).then(async o=>{setOrgs(o);if(o?.[0]){const p=await apiFetch(`/api/v1/projects?organizationId=${o[0].id}`);setProjects(await p.json());setStatus('');}}).catch(()=>setStatus('API indisponível'));},[]);
 return <div className="simple-page"><p className="eyebrow">OLIVEIRA DEVCLOUD</p><h1>Projetos</h1><p>{status}</p>{orgs[0]&&<p className="muted">Organização: {orgs[0].name}</p>}<div className="project-list">{projects.map(p=><article key={p.id}><strong>{p.name}</strong><span>{p.repositoryUrl??'Sem repositório conectado'}</span><small>{p.defaultBranch} · {p._count?.workspaces??0} workspaces</small></article>)}{!status&&projects.length===0&&<article><strong>Nenhum projeto ainda</strong><span>A API de criação já está pronta em POST /api/v1/projects.</span></article>}</div><a href="/">← Overview</a></div>}
