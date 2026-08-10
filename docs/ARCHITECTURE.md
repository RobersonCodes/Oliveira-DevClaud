# Oliveira DevCloud — Architecture v0.1

## Goal
Remote, browser-accessible development control plane with persistent workspaces, Git integration, web terminals and AI agents.

## Core services
- **web**: Next.js control plane UI.
- **api**: authentication, projects, workspaces, Git, terminals, secrets and audit APIs.
- **worker**: long-running jobs and AI-agent orchestration.
- **runtime-broker**: the only service holding the Docker socket (Fase 4); api/worker and every
  `*-engine` package reach Docker exclusively through its narrow, allowlisted HTTP/WS contract.
- **postgres**: source of truth.
- **redis**: queues, ephemeral state and realtime coordination.
- **workspace runtime**: Docker-managed isolated project containers (phase 2).

## Security boundaries
1. Browser never receives host Docker socket access — nor, as of Fase 4, do api/worker themselves;
   only `runtime-broker` holds it.
2. API validates organization membership and role for every sensitive operation.
3. Shell execution is centralized in a CommandRunner abstraction.
4. Workspaces run non-root with CPU/RAM/process limits.
5. Secrets are encrypted at rest and redacted from logs.
6. Agent branches should use Git worktrees to reduce concurrent-edit conflicts.

## Milestones
### M0 — Foundation
Monorepo, UI shell, API health, PostgreSQL schema, Redis/Postgres compose.

### M1 — Identity & Projects
Auth, sessions, organization RBAC, GitHub repository import.

### M2 — Workspace Engine
Docker lifecycle, resource limits, volumes, runtime templates.

### M3 — Terminal & IDE
node-pty + xterm.js + tmux, OpenVSCode/code-server reverse proxy.

### M4 — AI Agents
Codex/Claude terminal adapters, task model, logs, stop/restart, worktrees.

### M5 — Orchestrator
Dependencies between tasks, tests/build gates, merge review and notifications.


## Terminal Plane (v0.4)

O terminal usa xterm.js no browser, WebSocket autenticado no control plane e Docker Exec TTY para anexar a uma sessão tmux persistente no container. Desconectar o browser não encerra o processo. O Docker socket permanece fora do alcance do cliente e dos workspaces.


## v0.7 — Isolamento multiagente

`AgentTask -> git-engine -> Git Worktree -> tmux -> Codex/Claude`. O checkout principal é preservado até revisão explícita.

## v0.9 Review & Merge boundary

Orchestrated agent branches are never merged directly into the main checkout. The API snapshots completed agent worktrees, creates an ephemeral `review/<orchestrationId>` branch, merges agent branches there, detects conflicts, and runs allow-listed integration gates in that combined codebase. Human approval by `ADMIN`/`OWNER` is required for the final merge. Approval uses optimistic concurrency: the main `HEAD` must still equal the commit captured when review began.

## Hardening Fase 3 — rede Docker dedicada por workspace (P0-3)

Cada workspace passou a receber sua própria rede Docker (`odc-ws-net-<workspaceId>`, driver `bridge`,
labels `dev.oliveira.devcloud=workspace-network` + `dev.oliveira.workspace-id`), criada/reaproveitada
de forma idempotente e conectada ao container do workspace via `HostConfig.NetworkMode` na criação —
não existe mais uma rede `bridge`/`WORKSPACE_NETWORK` compartilhada entre todos os workspaces. Como o
Docker não roteia entre redes bridge distintas por padrão, isso é o que efetivamente impede que o
workspace A alcance o workspace B por IP. **Desde a Fase 4, essa lógica mora em
`apps/runtime-broker/src/network.ts`** (movida de `packages/workspace-engine`, já que só o broker
ainda toca `docker.sock`) — `workspace-engine` virou um cliente HTTP fino do broker.

O Runtime Gateway (`apps/api`) continua precisando alcançar o container de cada workspace por IP para
retransmitir IDE/preview (`ide-engine`'s `internalHost()`, hoje também um cliente do broker), então o
próprio broker — identificado internamente por `RELAY_CONTAINER_NAME` — conecta o container `api` (em
produção, `container_name: odc-api` em `infra/production/docker-compose.prod.yml`) à rede do
workspace via `docker network connect` no momento da criação, e o desconecta em `destroy()`. Em
dev/CI, onde o broker roda direto no host (não containerizado), essa conexão é desnecessária e não
acontece — o host já enxerga qualquer rede bridge do Docker sem precisar se juntar a ela
explicitamente.

`destroy()` remove o container e, em seguida, desconecta o relay e remove a rede — nunca por nome
adivinhado, sempre pelo nome derivado deterministicamente do `workspaceId`, então jamais afeta a rede
de outro workspace. Se a rede ainda tiver algum endpoint preso (ex.: uma falha de desconexão), a
remoção é deixada para `pruneOrphanedNetworks()` (mesmo módulo, exposta via
`POST /v1/maintenance/prune-networks`), que remove apenas redes com o label acima e zero containers
conectados; hoje é invocável sob demanda e pensada para ser agendada periodicamente pelo reaper da
Fase 7 (ainda não implementada como job agendado — ver `docs/HARDENING-ROADMAP.md`).

## Hardening Fase 4 — Runtime Broker (P1-5)

`apps/runtime-broker` é hoje o único serviço com `docker.sock` montado — `api` e `worker` perderam o
acesso direto ao daemon e falam com o broker via `@oliveira/runtime-broker-client`
(`packages/runtime-broker-client`), um cliente HTTP/WS autenticado por bearer token
(`RUNTIME_BROKER_TOKEN`, comparado em tempo constante). O contrato é deliberadamente estreito e
específico por domínio, não um passthrough genérico do Docker: criar/inspecionar/iniciar/parar/
reiniciar/destruir o container de um workspace, um `exec` genérico de um-tiro (usado por
`git-engine`, `setup-engine`, `review-engine`, `repository-intelligence`, `code-intelligence`,
`contract-intelligence`, `agent-engine`, `repository-bootstrap` e `ide-engine`), um `exec` TTY
interativo via WebSocket (só para `terminal-engine` — o único caso genuinamente bidirecional/
streaming) e uma rota de manutenção para varrer redes órfãs. A imagem do container, o caminho de
bind e o nome da rede nunca vêm do chamador — são sempre derivados internamente pelo próprio broker a
partir do `workspaceId`; `Privileged`, `CapAdd` e mounts arbitrários não têm campo nenhum no schema
de request, então não podem ser pedidos, nem por um chamador comprometido. O broker nunca publica
porta no host — só alcançável por outros containers da mesma rede do compose
(`infra/production/docker-compose.prod.yml`).

## Hardening Fase 2 — Runtime Gateway em domínio real (P0-2)

O painel (`app.oliveiradevcloud.com`) e o Runtime Gateway (`*.runtime.oliveiradevcloud-content.com`)
são dois sites registráveis distintos por trás do mesmo `nginx`, cada um com seu próprio certificado
TLS (`infra/production/nginx.prod.conf`). Os dois `server_name` apontam para o mesmo backend
`api:4000`; a app despacha por Host header via `constraints` do Fastify
(`runtimeHostPattern()`/`parseRuntimeHost()` em `apps/api/src/lib/runtimeGateway.ts`) — nginx nunca
reescreve esse header, só termina TLS. Passo a passo operacional (DNS, certbot, renovação):
`docs/RUNTIME-GATEWAY-DEPLOY.md`.
