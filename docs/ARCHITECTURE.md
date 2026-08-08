# Oliveira DevCloud — Architecture v0.1

## Goal
Remote, browser-accessible development control plane with persistent workspaces, Git integration, web terminals and AI agents.

## Core services
- **web**: Next.js control plane UI.
- **api**: authentication, projects, workspaces, Git, terminals, secrets and audit APIs.
- **worker**: long-running jobs and AI-agent orchestration.
- **postgres**: source of truth.
- **redis**: queues, ephemeral state and realtime coordination.
- **workspace runtime**: Docker-managed isolated project containers (phase 2).

## Security boundaries
1. Browser never receives host Docker socket access.
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
