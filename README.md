# Oliveira DevCloud

> **v2.4 — Contract Gate para Review & Merge.**

Plataforma self-hosted de desenvolvimento remoto da Oliveira Systems: workspaces Docker isolados, terminal persistente via tmux, Web IDE no navegador, importação GitHub, secrets criptografados, Codex/Claude em worktrees isolados, orquestração multiagente e aprovação humana antes do merge.

> **Status:** baseline de engenharia em evolução. Antes de exposição pública, execute hardening de produção, testes de integração e revisão do isolamento Docker.

## Evolução do projeto

- **v0.1–v0.3** — monorepo, autenticação/RBAC e Workspace Engine Docker.
- **v0.4–v0.5** — terminal persistente, code-server e previews protegidos.
- **v0.6–v0.7** — Codex/Claude, logs, Git Worktrees e revisão de diff.
- **v0.8–v0.9** — orquestrador DAG, quality gates e Review & Merge.
- **v1.0–v1.4** — Secret Manager, GitHub import, onboarding, provisionamento assíncrono e recuperação de jobs.
- **v1.5–v1.6** — AI Command Center, planner OpenAI/Anthropic, Policy Engine e fallback determinístico.
- **v1.7** — Repository Intelligence com mapa estrutural seguro do checkout.
- **v1.8** — Repository Map visual e cache PostgreSQL por `workspaceId + commitSha`.
- **v1.9** — Code Intelligence com símbolos, endpoints e dependências locais.
- **v2.0** — Focused Context Engine: seleciona arquivos, símbolos e endpoints relacionados ao objetivo antes do planejamento.
- **v2.1** — Agent Task Context Router: entrega contexto distinto para Codex e Claude por etapa.
- **v2.2** — Dependency Router: adiciona dependências somente quando há evidência arquitetural forte e preserva paralelismo quando seguro.
- **v2.3** — Contract Intelligence: mapeia produtores/consumidores HTTP e riscos de integração.
- **v2.4** — Contract Gate: compara baseline vs integração e bloqueia regressões de contrato de alta confiança antes do merge.

## Arquitetura

```text
apps/
  api/                  # control plane Fastify
  web/                  # dashboard Next.js
  worker/               # BullMQ / jobs assíncronos
packages/
  database/
  workspace-engine/
  terminal-engine/
  ide-engine/
  agent-engine/
  git-engine/
  orchestrator-engine/
  review-engine/
  secret-manager/
  setup-engine/
  setup-queue/
  command-center-engine/
  repository-intelligence/
  code-intelligence/
  context-engine/
  contract-intelligence/
  contract-gate/
infra/
  workspace-images/node/
  nginx/
  production/
docs/
```

## Fluxo atual

```text
GitHub → Project → Docker Workspace → Stack Detection → Browser IDE
                                      ↓
                              Repository Intelligence
                                      ↓
                                Code Intelligence
                                      ↓
                              Focused Context Engine
                                      ↓
                               AI Command Center
                              ↙                 ↘
                           Codex               Claude
                         worktree A          worktree B
                              ↘                 ↙
                             Quality Gates + Review
                                      ↓
                                  Contract Gate
                                      ↓
                               Human Approval
                                      ↓
                                    Merge
```

## Repository Map v1.8

Abra:

```text
/repository-map?workspaceId=<id>
```

Em repositórios limpos, o backend tenta reutilizar o snapshot do `HEAD`. Se houver mudanças locais, o cache é ignorado automaticamente e uma nova análise é feita.

Endpoints:

```text
GET    /api/v1/repository-intelligence/:workspaceId
GET    /api/v1/repository-intelligence/:workspaceId?refresh=true
DELETE /api/v1/repository-intelligence/:workspaceId/cache
```

Consulte `docs/V1.8.md` para detalhes.

## Preparação local

```bash
cp .env.example .env
docker compose up -d postgres redis
docker build -t oliveira-devcloud/workspace-node:0.9 infra/workspace-images/node
npm install
npm run db:generate
npm run db:migrate
npm run dev
```

Depois do `db:migrate`, o Prisma cria a tabela `RepositorySnapshot` usada pelo cache incremental.


## v1.9 Code Intelligence

Mapa de símbolos, endpoints e dependências locais em `/code-intelligence?workspaceId=...`, com cache por commit SHA. Veja `docs/V1.9.md`.


## v2.0 Focused Context Intelligence

O Command Center cruza o objetivo do usuário com o mapa semântico do código e prioriza somente o contexto mais provável de ser relevante.

```text
GET /api/v1/context-intelligence/:workspaceId?objective=Corrija%20o%20checkout
```

Veja `docs/V2.0.md`.

## v2.1 — Agent Task Context Router

O Command Center agora roteia contexto específico por agente após a validação do DAG. Codex recebe prioridade para backend/API/dados; Claude recebe prioridade para frontend/UI/UX. O contexto é persistido por `OrchestrationStep` para auditoria e aparece no Command Center antes da execução. Consulte `docs/V2.1.md`.

## v2.3 — Dependency-Aware Task Routing

Depois de criar o contexto individual de cada agente, o Command Center passa o DAG pelo `@oliveira/dependency-router`. Ele correlaciona contratos de API, relações entre módulos e domínio das tarefas. Quando existe relação produtor/consumidor suficientemente forte, adiciona `dependsOn` automaticamente; caso contrário, mantém Codex e Claude em paralelo. Toda decisão é explicada no Command Center e o DAG é validado novamente antes da persistência. Consulte `docs/V2.2.md`.


## v2.3 — Contract Intelligence

Mapeia endpoints produtores e consumidores HTTP, detecta incompatibilidades inferidas e adiciona esse contexto ao AI Command Center antes da orquestração multiagente. Consulte `docs/V2.3.md`.


## v2.4 — Contract Gate

O Review & Merge agora compara a baseline de contratos HTTP da branch principal com a worktree integrada de Codex/Claude. Regressões de alta confiança bloqueiam `reviewStatus=READY` e, portanto, impedem o merge até nova correção/análise. Consulte `docs/V2.4.md`.
