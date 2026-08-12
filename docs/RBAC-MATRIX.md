# Matriz de autorização HTTP e WebSocket

Revisada em 2026-08-12 na Fase 6. Esta matriz é a referência para manter rotas equivalentes sob a
mesma política. No teste, **membro** significa uma conta autenticada sem vínculo com a organização
alvo; `HOST_ADMIN` é uma permissão global explícita e não concede acesso implícito a nenhum tenant.

## Políticas

| Política | Anônimo | Membro externo | Developer | Admin | Owner | Host admin sem vínculo |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Pública | sim | sim | sim | sim | sim | sim |
| Autenticada | não | sim | sim | sim | sim | sim |
| `DEVELOPER` | não | não | sim | sim | sim | não |
| `ADMIN` | não | não | não | sim | sim | não |
| `OWNER` | não | não | não | não | sim | não |
| `HOST_ADMIN` | não | não | não | não | não | sim |

`apps/api/src/lib/auth.test.ts` valida todas as células acima sem infraestrutura. O teste de
integração em `apps/api/src/integration.test.ts` repete a matriz contra rotas HTTP reais e
PostgreSQL. Os handshakes reais e a paridade HTTP/WS ficam em `apps/api/src/ws-security.test.ts` e
`apps/api/src/runtimeGateway.test.ts`.

## Inventário rota por rota

| Política | Rotas |
| --- | --- |
| Pública | `GET /health`; `GET /ready`; `POST /api/v1/auth/register`; `POST /api/v1/auth/login`; `POST /api/v1/auth/logout` (idempotente e sem divulgação de estado) |
| Autenticada | `GET /api/v1/auth/me`; `GET /api/v1/auth/sessions`; `DELETE /api/v1/auth/sessions/others`; `DELETE /api/v1/auth/sessions/:sessionId`; `GET /api/v1/organizations` |
| `DEVELOPER` | `GET /api/v1/organizations/:organizationId`; `GET /api/v1/projects`; `GET /api/v1/projects/:projectId`; `GET /api/v1/workspaces`; `GET /api/v1/workspaces/:workspaceId`; `POST /api/v1/workspaces/:workspaceId/start`; `POST /api/v1/workspaces/:workspaceId/stop` |
| `DEVELOPER` | `POST /api/v1/workspaces/:workspaceId/ide/start`; `GET /api/v1/workspaces/:workspaceId/ide/status`; `POST /api/v1/workspaces/:workspaceId/ide/stop`; `GET/POST /api/v1/workspaces/:workspaceId/ports`; `DELETE /api/v1/workspaces/:workspaceId/ports/:port` |
| `DEVELOPER` | `GET/POST /api/v1/terminals`; `DELETE /api/v1/terminals/:terminalId`; `GET+WS /api/v1/terminals/:terminalId/connect` |
| `DEVELOPER` | `GET/POST /api/v1/agents`; `POST /api/v1/agents/:taskId/start`; `GET /api/v1/agents/:taskId/status`; `GET /api/v1/agents/:taskId/logs`; `GET /api/v1/agents/:taskId/changes`; `POST /api/v1/agents/:taskId/cancel` |
| `DEVELOPER` | `GET/POST /api/v1/orchestrations`; `POST /api/v1/orchestrations/:id/start`; `POST /api/v1/orchestrations/:id/cancel`; `GET /api/v1/orchestrations/:id/review`; `GET /api/v1/orchestrations/:id/regression-report`; `POST /api/v1/orchestrations/:id/review/analyze` |
| `DEVELOPER` | `GET /api/v1/activity`; `GET /api/v1/github/status`; `GET /api/v1/github/repositories`; `GET /api/v1/repository-intelligence/:workspaceId`; `GET /api/v1/code-intelligence/:workspaceId`; `GET /api/v1/context-intelligence/:workspaceId`; `GET /api/v1/contract-intelligence/:workspaceId` |
| `DEVELOPER` | `GET /api/v1/setup/jobs/:jobId`; `GET /api/v1/setup/jobs/:jobId/logs`; `GET /api/v1/setup/jobs/:jobId/events`; todas as rotas de `command-center` |
| `DEVELOPER` | `POST /api/v1/runtime-tickets`; HTTP e WS no Runtime Gateway `*.runtime.<domínio>`; HTTP e WS dos proxies legados de IDE/preview (somente desenvolvimento; produção responde `410`) |
| `ADMIN` | `POST /api/v1/projects`; `POST /api/v1/workspaces`; `POST /api/v1/workspaces/:workspaceId/restart`; `DELETE /api/v1/workspaces/:workspaceId` |
| `ADMIN` | `POST /api/v1/agents/:taskId/merge`; `POST /api/v1/agents/:taskId/reject`; `POST /api/v1/orchestrations/:id/review/approve`; `POST /api/v1/orchestrations/:id/review/reject` |
| `ADMIN` | `GET/POST /api/v1/secrets`; `DELETE /api/v1/secrets/:id`; `POST /api/v1/repositories/:workspaceId/bootstrap`; `DELETE /api/v1/repository-intelligence/:workspaceId/cache` |
| `ADMIN` | `GET /api/v1/setup/:workspaceId/detect`; `POST /api/v1/setup/:workspaceId/provision`; `GET /api/v1/setup/:workspaceId/jobs/latest`; `POST /api/v1/setup/jobs/:jobId/cancel`; `POST /api/v1/setup/jobs/:jobId/retry`; `POST /api/v1/setup/quickstart` |
| `OWNER` | `DELETE /api/v1/projects/:projectId` |
| `HOST_ADMIN` | `GET /api/v1/system`; `GET /api/v1/system/metrics-summary` |

## Regras de paridade

- O mesmo `preHandler` autoriza HTTP e WebSocket em terminal, Runtime Gateway e proxies legados;
  nenhuma resposta `101` é enviada antes de Origin, sessão, tenant e papel serem validados.
- Consumir um ticket de runtime não congela a autorização: membership e papel `DEVELOPER` são
  consultados novamente em toda requisição e em todo handshake, portanto revogação é imediata.
- Merge/rejeição direta de uma tarefa e aprovação/rejeição de uma orquestração são ações de revisão
  equivalentes e exigem `ADMIN`.
- `HOST_ADMIN_EMAILS` autoriza somente métricas globais; não eleva papel dentro de organizações.
