'use client';
import { FormEvent, useState } from 'react';
const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
export default function LoginPage(){
 const [mode,setMode]=useState<'login'|'register'>('login'); const [message,setMessage]=useState('');
 async function submit(e:FormEvent<HTMLFormElement>){e.preventDefault();setMessage('Enviando...');const fd=new FormData(e.currentTarget);const payload:any={email:fd.get('email'),password:fd.get('password')};if(mode==='register'){payload.name=fd.get('name');payload.organizationName=fd.get('organizationName')||'Oliveira Systems';}
 const r=await fetch(`${API}/api/v1/auth/${mode}`,{method:'POST',headers:{'content-type':'application/json'},credentials:'include',body:JSON.stringify(payload)});if(r.ok){setMessage('Autenticado.');location.href='/projects';}else{const j=await r.json().catch(()=>({error:'ERRO'}));setMessage(j.error??'Erro');}}
 return <div className="auth-shell"><form className="auth-card" onSubmit={submit}><p className="eyebrow">OLIVEIRA DEVCLOUD</p><h1>{mode==='login'?'Entrar':'Criar conta'}</h1>{mode==='register'&&<><label>Nome<input name="name" required minLength={2}/></label><label>Organização<input name="organizationName" defaultValue="Oliveira Systems" required/></label></>}<label>E-mail<input name="email" type="email" required/></label><label>Senha<input name="password" type="password" minLength={10} required/></label><button type="submit">{mode==='login'?'Entrar':'Registrar'}</button><p className="message">{message}</p><button type="button" className="ghost" onClick={()=>setMode(mode==='login'?'register':'login')}>{mode==='login'?'Criar primeira conta':'Já tenho conta'}</button></form></div>
}
