# Oliveira DevCloud

[![CI](https://github.com/RobersonCodes/Oliveira-DevClaud/actions/workflows/ci.yml/badge.svg)](https://github.com/RobersonCodes/Oliveira-DevClaud/actions/workflows/ci.yml)
![version](https://img.shields.io/badge/version-2.5.0-blue)
![status](https://img.shields.io/badge/status-evolving%20baseline-yellow)

Plataforma self-hosted de desenvolvimento remoto: workspaces Docker isolados, terminal persistente
via tmux, Web IDE no navegador, importação GitHub, secrets criptografados (AES-256-GCM), Codex/Claude
em worktrees isolados, orquestração multiagente com DAG, e um pipeline de Review & Merge que só libera
aprovação humana depois de gates de qualidade, contrato de API e análise de regressão — tudo com score
determinístico, sem depender de um LLM para decidir se algo é seguro de mergear.

## Status

Baseline de engenharia em evolução ativa. O que já está verificado com testes reais (não mocks) e CI:

- **69 testes** rodando contra infraestrutura real (Postgres real, Docker real) — ver [Testes](#testes).
- CI (`.github/workflows/ci.yml`) roda em todo push/PR: install → prisma generate → lint → typecheck →
  test → build → `npm audit`. PR precisa estar verde antes de mergear em `main`.
- Migrations consolidadas e validadas do zero contra Postgres real.
- Imagem de workspace (`infra/workspace-images/node`) buildando com sucesso e verificada manualmente.

O que **ainda não** está coberto e deve ser tratado antes de exposição pública: hardening de produção
(revisão de `infra/production/`), teste de carga do isolamento Docker sob concorrência real de agentes,
e auditoria completa de superfície de ataque (ver `docs/V2.5-AUDIT.md` para o histórico de bugs de
baseline já encontrados e corrigidos).

## Arquitetura

```text
apps/
  api/                  # control plane Fastify (apps/api/src/app.ts exporta buildApp() testável)
  web/                  # dashboard Next.js
  worker/               # BullMQ / jobs assíncronos
packages/
  database/              # Prisma schema + client singleton
  workspace-engine/       # lifecycle de containers Docker por workspace
  terminal-engine/        # tmux + Docker exec TTY (WebSocket)
  ide-engine/             # code-server via proxy autenticado
  agent-engine/           # Codex/Claude em sessão tmux isolada
  git-engine/              # Git worktrees por agente, diff real, merge/cleanup
  orchestrator-engine/     # DAG de steps (AGENT/SYSTEM), fila BullMQ
  review-engine/           # worktree de review, merge de branches, quality gates
  secret-manager/          # AES-256-GCM + masking
  setup-engine/ setup-queue/  # provisionamento assíncrono (clone, install, IDE, portas)
  command-center-engine/   # planner determinístico/OpenAI/Anthropic → DAG
  repository-intelligence/ # mapa de arquivos/árvore/manifests (cache por commit SHA)
  code-intelligence/       # símbolos/endpoints/edges locais
  context-engine/          # contexto focado por objetivo
  task-context-router/     # contexto por agente (Codex backend, Claude frontend)
  dependency-router/       # dependsOn automático quando há evidência arquitetural
  contract-intelligence/   # endpoints HTTP produtores/consumidores
  contract-gate/           # baseline × candidato de contratos, bloqueia regressões
  regression-intelligence/ # baseline × candidato de código/testes/migrations, Risk Engine
  shared/                  # constantes compartilhadas entre apps/packages
infra/
  workspace-images/node/   # imagem Docker dos workspaces de usuário
  nginx/, production/       # reverse proxy + Dockerfiles + compose de produção
docs/                       # uma entrada por versão (V0.2 → V2.5) + ARCHITECTURE.md
```

## Fluxo de Review & Merge

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
                            Regression Intelligence
                                      ↓
                          Merge Risk Report (score + bloqueio)
                                      ↓
                               Human Approval
                                      ↓
                                    Merge
```

Regras de bloqueio automático (Contract Gate + Regression Intelligence) são sempre conservadoras:
só bloqueiam com evidência forte (gate de teste/build falho, conflito de merge não resolvido, contrato
quebrado com consumidor conhecido). Heurísticas mais fracas (símbolo removido, módulo sensível tocado)
aparecem no relatório para revisão humana, nunca bloqueiam sozinhas.

## Preparação local

```bash
cp .env.example .env
docker compose up -d postgres redis
docker build -t oliveira-devcloud/workspace-node:1.0 infra/workspace-images/node
npm install
npm run db:generate
npm run db:migrate
npm run dev
```

`npm run dev` sobe `web` (3000), `api` (4000) e `worker` concorrentemente. Depois do `db:migrate`, a
tabela `RepositorySnapshot` (e as demais tabelas de negócio) ficam prontas para uso.

> Se você já tiver um PostgreSQL/Redis nativo ocupando as portas `5432`/`6379` na máquina, suba o
> `docker-compose.yml` em portas alternativas ou aponte `DATABASE_URL`/`REDIS_URL` do `.env` para a
> instância existente.

## Testes

```bash
npm test          # vitest run — toda a suíte, uma vez
npm run test:watch
```

A suíte roda contra **infraestrutura real**, não contra mocks:

| Pacote/App | O que é testado | Infra necessária |
|---|---|---|
| `packages/secret-manager` | Criptografia/decriptografia AES-256-GCM, masking | nenhuma |
| `apps/api` (`lib/auth.ts`) | Hashing de senha, hierarquia de `Role` | nenhuma |
| `packages/database` | Constraints/cascades reais do schema (unique, FK cascade, comportamento de `NULL` em índice composto) | Postgres real (`DATABASE_URL`) |
| `apps/api` (`integration.test.ts`) | `register`/`login`/`logout`/`/me`, RBAC de projects/organizations, rate limit do `/register`, via `app.inject()` real | Postgres real |
| `packages/git-engine` | Worktree completo: create → snapshot → review → diff → merge → cleanup, contra um container Alpine real com git de verdade | Docker real |
| `packages/workspace-engine` | Lifecycle de container (create/start/stop/restart/destroy), enforcement real de CPU/RAM/PIDs/capabilities | Docker real |
| `packages/regression-intelligence` | Os 8 detectores de regressão + Risk Engine (determinístico, sem I/O) | nenhuma |

Sem `DATABASE_URL`/`DOCKER_SOCKET` configurados, os testes que precisam dessa infra falham — não há
skip silencioso. Em CI, o Postgres sobe como serviço do job e o Docker já vem disponível nos runners
hospedados pela GitHub.

## CI/CD

Todo push e PR roda [`CI`](.github/workflows/ci.yml):

```text
npm ci → prisma generate → lint → typecheck → test → build → npm audit --audit-level=high
```

PRs devem ficar verdes antes do merge. O fluxo de trabalho é PRs pequenos e revisáveis por item —
veja o histórico de PRs mergeados para o padrão esperado de descrição/test plan.

## Segurança

- RBAC por organização (`OWNER` > `ADMIN` > `DEVELOPER`) verificado em toda rota sensível via
  `requireOrgRole`, nunca confiando em `organizationId` vindo do cliente.
- Secrets criptografados em repouso (AES-256-GCM) e mascarados em qualquer resposta/log.
- Toda execução de comando em workspace usa `docker exec` com argumentos em array (nunca concatenação
  de shell) e passa por um allow-list de comandos nos quality gates.
- Containers de workspace rodam com `CapDrop: ALL`, `no-new-privileges`, e limites reais de
  CPU/RAM/PIDs aplicados pelo Docker (verificado em teste, não só no código que monta a request).
- Sessões via cookie `httpOnly`/`SameSite`; rate limit dedicado e mais restrito em `/auth/register` e
  `/auth/login` além do limite global da API.

## Documentação

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — visão geral de arquitetura e limites de segurança.
- [`docs/V2.5.md`](docs/V2.5.md) — Regression Intelligence & Merge Risk Report (feature mais recente).
- [`docs/V2.5-AUDIT.md`](docs/V2.5-AUDIT.md) — auditoria completa do baseline antes da v2.5, com todos
  os bugs pré-existentes encontrados e corrigidos.
- `docs/V0.2.md` → `docs/V2.4.md` — uma entrada por versão anterior, na ordem em que cada capacidade
  foi introduzida.

## Evolução do projeto

| Versão | Entrega |
|---|---|
| v0.1–v0.3 | Monorepo, autenticação/RBAC, Workspace Engine Docker |
| v0.4–v0.5 | Terminal persistente, code-server, previews protegidos |
| v0.6–v0.7 | Codex/Claude, logs, Git Worktrees, revisão de diff |
| v0.8–v0.9 | Orquestrador DAG, quality gates, Review & Merge |
| v1.0–v1.4 | Secret Manager, GitHub import, onboarding, provisionamento assíncrono |
| v1.5–v1.6 | AI Command Center, planner OpenAI/Anthropic, fallback determinístico |
| v1.7–v1.8 | Repository Intelligence + Repository Map visual (cache por `workspaceId+commitSha`) |
| v1.9 | Code Intelligence: símbolos, endpoints, dependências locais |
| v2.0 | Focused Context Engine |
| v2.1 | Agent Task Context Router |
| v2.2 | Dependency Router |
| v2.3 | Contract Intelligence |
| v2.4 | Contract Gate |
| v2.5 | **Regression Intelligence & Merge Risk Report** (atual) |

## Contribuindo

1. Branch a partir de `main`, um item ou grupo pequeno de itens por PR.
2. CI precisa ficar verde (`lint`, `typecheck`, `test`, `build`, `npm audit`) antes do merge.
3. Descreva no PR o que foi testado manualmente além do CI — "typecheck passou" não é test plan.
4. Nenhum mock permanente: funcionalidade nova deve ser validada contra infraestrutura real sempre
   que a infra existir localmente/em CI (Postgres, Docker).
