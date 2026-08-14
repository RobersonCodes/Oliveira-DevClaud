# Oliveira DevCloud — Arquitetura atual

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

## Filas e política de retry

Redis/BullMQ transporta dois tipos de job com custos distintos. `tick` de orquestração é uma
reconciliação curta e idempotente: tenta até cinco vezes, com backoff exponencial iniciado em um
segundo. `provision` executa clone/instalação e tenta até três vezes, com base de cinco segundos.
Ambos aplicam jitter de 25% para evitar que várias réplicas retomem simultaneamente após uma falha
compartilhada. Erros de infraestrutura como timeout e reset de conexão consomem essa política;
invariantes permanentes conhecidas são convertidas em `UnrecoverableError` pelo worker e falham sem
novas tentativas. Dedupe de ticks e `jobId` estável de setup continuam sendo as fronteiras contra
efeitos concorrentes duplicados.

As chaves são deliberadamente derivadas de identidades persistentes, não de timestamps: cada
orquestração usa `tick-<orchestrationId>` e cada provisionamento usa seu próprio `SetupJob.id`.
Estado no PostgreSQL é a autoridade final. Start, cancelamento, progresso, conclusão, recovery e
reconciliação usam compare-and-swap condicionado ao estado anterior permitido; perder a disputa
significa reler/retornar o estado vencedor, nunca sobrescrevê-lo. Por isso deduplicação no Redis é
uma otimização de coordenação, enquanto o CAS no banco preserva a correção após retry, restart ou
execução concorrente.

Efeitos externos de merge têm uma segunda camada. O commit de merge recebe o trailer
`Oliveira-Idempotency-Key` derivado do ID persistente da tarefa/orquestração; um retry consulta o
histórico e retorna o commit existente. No banco, merge direto de agente passa por `READY → MERGING
→ MERGED`, e merge de orquestração por `READY → APPROVED → MERGED`, garantindo um único proprietário
do efeito externo por vez. Transações que tocam várias entidades mantêm ordem de lock fixa:
`AgentTask → OrchestrationStep → Orchestration`.

### Heartbeats de runtime

`Workspace`, `AgentTask` e `Orchestration` possuem `heartbeatAt` persistente e indexado. O worker
renova a lease de jobs que está executando; para runtime externo, o timestamp só avança depois de o
Runtime Broker confirmar container `running` ou o Agent Engine confirmar processo `RUNNING`.
Indisponibilidade do probe mantém o heartbeat anterior deliberadamente stale, permitindo que a
recuperação diferencie “vivo confirmado” de “não foi possível verificar”. O sweep roda a cada 15s,
sem sobreposição, e é desligado antes do graceful shutdown.

### Dead-letter e revisão manual

Falhas permanentes das filas de setup e orquestração também são projetadas para fora da retenção
limitada do Redis: o worker cria ou atualiza um `DeadLetterJob` no PostgreSQL usando
`(organizationId, queue, sourceId, sourceJobId)` como chave única. O registro pertence à organização e contém apenas IDs do
recurso, código de erro normalizado e número de tentativas; prompts, opções, logs e texto livre da
exceção nunca entram no payload.

A API expõe listagem, resolução e reprocessamento somente a `ADMIN`. A transição manual usa
`OPEN → REQUEUEING → REQUEUED` com compare-and-swap. Para setup, o novo `SetupJob` é persistido e seu
ID gravado na dead-letter antes do enqueue; para orquestração, o ID estável é reutilizado. Assim, uma
falha de Redis ou duas requisições concorrentes retomam o mesmo enqueue em vez de criar trabalho
duplicado. A resolução sem retry usa `OPEN → RESOLVED`; somente a transição vencedora produz evento
de auditoria.

### Quotas de recursos e duração

Cada workspace persiste limites de CPU, memória, PIDs, disco e duração. CPU, memória e PIDs são
aplicados diretamente pelo Runtime Broker nos cgroups do container. Como `/workspace` é um bind
mount real do host, a quota de disco não usa `StorageOpt` do writable layer: o worker mede o
diretório sem seguir links simbólicos a cada 15 segundos e interrompe o runtime quando o limite é
excedido. Falha de leitura também é tratada como violação, para que a fiscalização seja fail-closed.

Workspace, AgentTask, Orchestration e SetupJob mantêm deadlines persistentes. O reconciliador usa
compare-and-swap para preservar estados terminais e propaga a falha de quota na ordem task → step →
orchestration. Comandos do broker são envolvidos pelo `timeout` do próprio container; assim, expirar
uma operação encerra o processo real, e não apenas a Promise no processo Node.js.


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

O painel (`app.aifunnelpro.com.br`) e o Runtime Gateway (`*.runtime.tiremax.shop`) são dois sites
registráveis distintos por trás do mesmo nginx, cada um com seu próprio certificado TLS. Os dois
`server_name` apontam para o mesmo backend `api:4000`; a app despacha por Host header via
`constraints` do Fastify (`runtimeHostPattern()`/`parseRuntimeHost()` em
`apps/api/src/lib/runtimeGateway.ts`) — nginx nunca reescreve esse header, só termina TLS. Passo a
passo operacional (DNS, certbot, renovação): `docs/RUNTIME-GATEWAY-DEPLOY.md`.

**Topologia de VPS compartilhada:** nesta implantação, a VPS já hospeda outro site (Tiremax) atrás
de um nginx do sistema ocupando 80/443. Por isso `infra/production/docker-compose.prod.yml` não
publica 80/443 nem roda nginx próprio por padrão — `web`/`api` publicam só em `127.0.0.1` (portas
configuráveis via `DEVCLOUD_WEB_HOST_PORT`/`DEVCLOUD_API_HOST_PORT`), e o nginx que termina TLS/roteia
por Host continua sendo um único processo — mas é o nginx **já existente no host**, com os server
blocks do DevCloud descritos em `infra/production/nginx-devcloud.host.conf.example` (config final) e
`nginx-devcloud.host.bootstrap.conf.example` (config HTTP-only temporária, usada só até o certificado
do painel ser emitido) adicionados ao lado da config existente do Tiremax, nunca a substituindo.

Para uma eventual VPS **exclusiva** (sem outro site), o mesmo compose tem um segundo caminho pronto,
não uma referência morta: o serviço `nginx` (dockerizado, `infra/production/nginx.prod.conf`,
publicando 80/443 diretamente) existe no compose atrás de um profile — `docker compose --profile
standalone-nginx up -d` — e fica desligado por padrão. Não é o que está em uso nesta implantação; ver
`docs/RUNTIME-GATEWAY-DEPLOY.md` para os dois caminhos completos.

## Hardening Fase 5 — artefatos e prontidão de produção

API, web, worker e Runtime Broker são construídos por Dockerfiles multi-stage com instalação
determinística (`npm ci`). Os pacotes internos usados no servidor publicam JavaScript compilado em
`dist/`; as imagens finais executam somente esses artefatos como UID/GID `10001:10001`. API e worker
incluem OpenSSL, requisito do engine Prisma na base Debian slim. O Runtime Broker permanece
non-root mesmo sendo o único detentor de `docker.sock`: o Compose adiciona somente o GID numérico do
grupo dono do socket (`DOCKER_GID`) como grupo suplementar.

Liveness e readiness são separadas. A API só responde pronta quando PostgreSQL, Redis e Runtime
Broker estão prontos; o broker só responde pronto depois de `docker.ping()`. O Compose aguarda
PostgreSQL e Redis saudáveis, executa migrations como job one-shot, aguarda broker saudável e apenas
então inicia API/worker; o web aguarda a API saudável. Essa cadeia evita anunciar o painel como
operacional quando banco, filas ou o daemon que hospeda os workspaces estão indisponíveis.

### Fronteira HTTP do painel

Os dois caminhos nginx de produção aplicam a mesma política ao control plane: corpo máximo de
`1 MiB`, recebimento dos headers em até 10 segundos, recebimento do corpo em até 30 segundos e
conexão ao upstream em até 5 segundos. O Fastify repete a fronteira relevante no processo com
`bodyLimit=1 MiB`, `requestTimeout=30s` e `keepAliveTimeout=72s`, de modo que contornar o nginx não
remove o limite de payload nem o prazo de recebimento. `connectionTimeout` permanece desabilitado
por desenho, pois um timeout de inatividade do socket derrubaria terminais e IDEs WebSocket válidos.

O endereço de cliente também cruza uma fronteira explícita: Fastify ignora `X-Forwarded-For`,
`X-Forwarded-Host` e `X-Forwarded-Proto` por padrão e só os aceita quando o peer direto pertence à
allowlist `TRUSTED_PROXY_CIDRS`. Na topologia de host compartilhado, essa allowlist contém apenas o
/32 do gateway da rede Compose pelo qual o nginx do host alcança a API. Outros containers da rede
não podem falsificar o IP usado em rate limit e auditoria.

O controle de abuso usa três orçamentos independentes por minuto. Toda rota comum consome o limite
do IP do cliente (`120/min`), enquanto cadastro (`5/min`) e login (`8/min`) mantêm limites próprios
mais estritos. Depois de uma sessão válida, `requireUser` consome também `120/min` por usuário e
`requireOrgRole` consome `600/min` agregados por organização; múltiplas verificações de autorização
na mesma requisição contam apenas uma vez. Em produção, todos os contadores vivem no Redis e são
compartilhados entre réplicas/restarts. `/health` e `/ready` não consomem orçamento para que o
próprio mecanismo de proteção não derrube observabilidade e orquestração. O Runtime Gateway aplica
as camadas de usuário e organização depois de revalidar o ticket/cookie e a membership, inclusive
no handshake WebSocket.

A autorização de tenant segue a hierarquia `DEVELOPER < ADMIN < OWNER`; administração do host é
uma capacidade ortogonal configurada por `HOST_ADMIN_EMAILS` e nunca eleva o papel em organizações.
Operações de revisão que integram ou descartam mudanças de agentes exigem `ADMIN`, tanto em tarefas
diretas quanto em orquestrações. O inventário completo de rotas e suas políticas está em
`docs/RBAC-MATRIX.md`.

Secrets preservam também a fronteira relacional do tenant: escopo de organização não aceita recurso,
escopo de projeto aceita somente um projeto da mesma organização e escopo de workspace aceita
somente um workspace cujo projeto pertence à mesma organização. Essa cadeia é validada antes da
persistência; IDs inexistentes e IDs de outro tenant retornam a mesma resposta para evitar enumeração.

Cada login cria uma sessão independente armazenada somente como hash do bearer token. O usuário
pode listar sessões ativas, identificar a atual e revogar uma, todas as outras ou a própria sessão;
sessões expiradas são eliminadas da listagem. Tickets/cookies do Runtime Gateway carregam o ID da
sessão de controle que os autorizou, e o gateway revalida sessão, expiração e membership em toda
requisição HTTP e todo handshake WebSocket. Assim, revogar um dispositivo também invalida na
requisição seguinte os runtimes que aquele dispositivo havia aberto, apesar do cookie de runtime
ter TTL próprio.

Antes de registrar rotas ou abrir a porta, a API valida a fronteira de configuração de produção.
`SECURE_CONFIG_REQUIRED=true` vem fixado na imagem e impede que um override acidental de
`NODE_ENV` degrade o cookie `__Host-` para um cookie sem `Secure`. Nesse modo, o boot exige origem
HTTPS exata e coerente com o host do painel, domínio de runtime público válido, chave mestra AES de
32 bytes, segredos de ticket/broker com pelo menos 32 bytes, endpoints explícitos, TTL de sessão
entre 1 e 30 dias e uma allowlist de proxy não universal. Desenvolvimento continua com os
fallbacks locais porque não ativa essa fronteira.

O nginx é a fonte autoritativa dos headers do painel: remove valores equivalentes recebidos de
Next.js/Fastify e aplica HSTS, CSP, `frame-ancestors 'none'`, `X-Frame-Options: DENY`,
`Referrer-Policy: no-referrer`, `Permissions-Policy`, `nosniff`, COOP e CORP. A CSP permite somente o
próprio painel para scripts/conexões e os hosts `*.runtime.tiremax.shop` como frames. O Runtime
Gateway mantém uma política diferente e deliberada: o nginx aplica um teto externo de `25 MiB` ao
tráfego de IDE/preview, preserva conexões HTTP/WS por até uma hora e continua recebendo
CSP/Referrer/Permissions/nosniff autoritativos da própria API, pois o conteúdo proxied é arbitrário
e não pode usar a CSP restrita do control plane.

### Imagem de workspace e cadeia de fornecimento

A imagem de workspace possui versão operacional `1.1.0`. O code-server `4.121.0` é obtido do release
oficial por arquitetura (`amd64`/`arm64`) e seu SHA-256 é verificado antes da extração; pnpm também é
fixado em `11.21.0`. Codex CLI `0.147.0` e Claude Code `2.1.226` são instalados por `npm ci` a partir
de um lockfile próprio da imagem; autoatualização fica desabilitada para evitar drift depois do
build. O usuário de runtime é `devcloud`/UID `10001`. O workflow
`.github/workflows/workspace-image.yml` é a fronteira de publicação planejada: produz a imagem GHCR
com tags por commit/versão, provenance e SBOM. Até existir uma execução remota confirmada, produção
deve usar o build local versionado descrito em `docs/PRODUCTION-OPERATIONS.md`; a existência do
workflow, sozinha, não prova que o artefato está publicado.

Persistência de PostgreSQL e dos diretórios de workspace, instalação limpa, upgrade, rollback e
recuperação de desastre estão definidos em `docs/PRODUCTION-OPERATIONS.md`. A topologia não muda:
PostgreSQL usa volume Docker; workspaces usam diretório real do host porque o Runtime Broker entrega
esse bind ao daemon Docker. `docker compose down -v` não faz parte de nenhum procedimento normal de
operação ou reinício.

O `agent-engine` executa Codex em modo não interativo com sandbox `workspace-write` e sem prompts de
aprovação, e Claude em modo `--print`/`acceptEdits`. A autenticação não faz parte da imagem: é criada
pelo usuário no terminal do workspace. Se uma CLI estiver ausente ou falhar antes de iniciar, o
worker marca tarefa, etapa e orquestração como `FAILED`, registra somente metadados sanitizados e
retorna ao loop BullMQ sem relançar o erro local.
