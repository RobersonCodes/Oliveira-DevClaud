const phases = [
  ['CREATE', 'Reserva registro e prepara o ambiente'],
  ['RUN', 'Container isolado com limites de CPU/RAM'],
  ['STOP', 'Interrompe execução preservando os arquivos'],
  ['DESTROY', 'Remove runtime com trilha de auditoria']
];
export default function Workspaces() {
  return <main><aside><div className="brand">OLIVEIRA<br/><span>DEVCLOUD</span></div><nav><a href="/">Overview</a><br/><a href="/projects">Projects</a><br/><b>Workspaces</b><br/>Agents<br/>Terminal<br/>Git<br/>Logs<br/>Settings</nav></aside><section className="content"><header><div><p className="eyebrow">RUNTIME CONTROL PLANE</p><h1>Workspace Engine v0.4</h1></div><span className="button">Docker isolated</span></header><div className="grid">{phases.map(([a,b])=><article key={a}><span>{a}</span><strong>{b}</strong></article>)}</div><div className="panel"><div><p className="eyebrow">SECURITY DEFAULTS</p><h2>Isolamento primeiro</h2><p>Non-root, cap-drop ALL, no-new-privileges, PIDs limitados e cotas de CPU/RAM. A API controla o lifecycle sem expor o Docker socket ao navegador.</p></div><div className="dot">● V0.4</div></div></section></main>;
}
