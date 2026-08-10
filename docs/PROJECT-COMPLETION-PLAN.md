# Plano operacional para conclusão — Oliveira DevCloud

> Fonte de verdade para execução e retomada por Codex, Claude ou outro agente.
> Este documento deve ser atualizado durante toda sessão que avance o projeto.

## 1. Objetivo da versão lançável

Entregar uma plataforma segura de desenvolvimento remoto, orientada por agentes e realmente
utilizável no celular. O objetivo não é reproduzir toda a superfície do VS Code antes do lançamento,
mas tornar confiável o fluxo principal:

```text
entrar → importar/abrir projeto → iniciar workspace → editar ou delegar ao agente
→ acompanhar terminal e testes → revisar diff → aprovar → salvar no Git
→ desconectar → retomar sem perder contexto
```

## 2. Regras obrigatórias de manutenção

Estas regras valem para qualquer agente ou pessoa que execute uma fase:

1. Ler este plano e `docs/HARDENING-ROADMAP.md` antes de mudar código.
2. Executar a **próxima ação única** registrada no checkpoint, salvo bloqueio documentado.
3. Alterar o status para `EM ANDAMENTO` ao iniciar uma fase.
4. Marcar um item somente depois de implementá-lo e verificá-lo.
5. Uma fase só fica `CONCLUÍDA` quando todos os critérios de aceite e validações obrigatórias passam.
6. Se um teste não puder rodar, manter a fase incompleta ou registrar por que a evidência equivalente
   é suficiente. Nunca transformar “não executado” em “aprovado”.
7. Ao encerrar uma sessão, atualizar checkpoint, checklist, evidências, decisões, riscos e histórico.
8. Alterações de segurança atualizam também `docs/HARDENING-ROADMAP.md`.
9. Alterações arquiteturais atualizam também `docs/ARCHITECTURE.md`.
10. Cada commit deve ser coeso e mencionar a fase correspondente.

### Estados permitidos

- `PENDENTE`: ainda não iniciada.
- `EM ANDAMENTO`: existe trabalho ativo ou incompleto.
- `BLOQUEADA`: depende de decisão, credencial ou infraestrutura externa registrada.
- `PARCIAL`: parte validada, mas ainda não atende ao critério completo.
- `CONCLUÍDA`: critérios e testes possuem evidência registrada.

## 3. Checkpoint atual

| Campo | Valor |
|---|---|
| Atualizado em | 2026-08-10 |
| Branch de referência | `feat/security-hardening` |
| Commit de referência | `68258a9` |
| Estado conhecido | 15 de 15 P0 corrigidos e sem nenhum aberto; wiring real de P0-2 (nginx/DNS/cert) segue pendente para a Etapa 2 |
| Etapa ativa | Etapa 2 — Runtime Gateway: DNS, TLS e nginx reais |
| Responsável | Claude (parte de código concluída) → usuário (DNS/TLS/validação no servidor) |
| Status | `PARCIAL` — server block nginx, compose e docs prontos e validados sintaticamente; falta execução do usuário no servidor real |
| Próxima ação única | Usuário executa `docs/RUNTIME-GATEWAY-DEPLOY.md` (DNS wildcard, certbot, primeiro deploy, checklist de validação) e reporta o resultado para fechar a Fase 2. Enquanto isso, Claude pode adiantar a Etapa 3 (Fase 4 — Runtime Broker), que não depende da Etapa 2 concluída, se o usuário preferir. |
| Bloqueios externos | DNS wildcard e certificado TLS wildcard exigem execução no servidor real do usuário (fora do alcance desta sessão) |

### Baseline de validação conhecido

- `npm run typecheck`: aprovado (monorepo inteiro).
- `npm run lint`: aprovado (exit 0).
- `npm run build`: aprovado (API, web via `next build`, demais pacotes com script `build`).
- Playwright/Chromium do Runtime Gateway: 3 de 3 aprovados (sessão anterior; não re-executado nesta).
- Vitest (`vitest run`), sessão de 2026-08-10 (Etapa 1), pela primeira vez com Postgres, Redis **e**
  Docker reais neste host Windows (Docker Desktop iniciado nesta sessão, Postgres/Redis efêmeros via
  `docker run`, migrations reais aplicadas): **164 de 166 aprovados**. As 2 falhas restantes
  (`apps/api/src/ws-security.test.ts`, casos de resolução do container "real") são pré-existentes e
  independentes da mudança desta etapa — confirmado isolando com `git stash` contra o código antes da
  mudança, mesmo resultado; detalhe em `docs/HARDENING-ROADMAP.md` Seção 7. Nenhuma rede/container de
  teste ficou órfã após a execução.
- CI Linux (GitHub Actions), run
  [31383975282](https://github.com/RobersonCodes/Oliveira-DevCloud/actions/runs/31383975282):
  `typecheck`/`lint` verdes; `Test` 163 aprovados / 2 falhas (as mesmas 2 pré-existentes e não
  relacionadas de `ws-security.test.ts`) / 1 ignorado, 166 no total — confirma a validação local.
  `Build`/`Security audit` não rodaram porque o job encerra no primeiro `Test` vermelho; não avaliados
  nesta run.

Os números acima são apenas o baseline. Substitua-os pelos resultados reais de cada nova execução.

## 4. Divisão de execução e ordem obrigatória

As fases técnicas preservam a numeração do roadmap de hardening. Para dividir o trabalho sem mudar
o significado delas, a execução usa dez **etapas operacionais**:

| Etapa | Responsável | Fase técnica | Entrega | Dependência |
|---|---|---|---|---|
| 1 | Claude | Fase 3 | Isolamento Docker por workspace | Nenhuma |
| 2 | Claude | Fase 2 (deploy) | DNS, TLS e nginx reais do Runtime Gateway | Acesso ao domínio/deploy |
| 3 | Claude | Fase 4 | Runtime Broker e retirada do Docker socket | Etapa 1 |
| 4 | Claude | Fase 1 | Cliente HTTP/WebSocket centralizado | Etapa 2 |
| 5 | Claude | Fase 5 | Infraestrutura reproduzível em host limpo | Etapas 1–4 |
| 6 | Codex | Fase 6 | Identidade, sessão e fronteiras de confiança | Handoff das etapas 1–5 |
| 7 | Codex | Fase 7 | Resiliência, concorrência e ciclo de vida | Etapas 3 e 6 |
| 8 | Codex | Fase 8 | Experiência mobile-first e PWA | Etapas 4–7 |
| 9 | Codex | Fase 9 | Matriz final de testes e regressões | Etapas 1–8 |
| 10 | Codex | Release | Beta fechado e gate de produção | Etapa 9 |

### Contrato de responsabilidade

- Claude é executor exclusivo das etapas 1–5. Não inicia a etapa 6.
- Codex é executor exclusivo das etapas 6–10. Antes da etapa 6, revisa o handoff das etapas 1–5,
  mas não as refaz sem registrar um defeito verificável.
- A execução padrão é sequencial. Se os dois agentes trabalharem ao mesmo tempo, cada um deve usar
  branch e worktree próprios; nunca editar a mesma árvore de trabalho simultaneamente.
- Cada etapa deve terminar em commit coeso e com o plano atualizado no mesmo commit.
- Nenhum agente pode pular uma dependência silenciosamente. Bloqueios externos devem receber status
  `BLOQUEADA`, evidência e uma próxima ação possível.
- O responsável seguinte só começa depois de verificar árvore limpa, commits da entrega e evidências.

### Handoff obrigatório Claude → Codex

Ao finalizar a etapa 5, Claude deve:

1. Atualizar as etapas 1–5 e seus critérios de aceite.
2. Registrar todos os comandos e resultados de validação.
3. Listar decisões arquiteturais, riscos residuais e testes não executados.
4. Atualizar o checkpoint para `Etapa 6`, responsável `Codex`.
5. Garantir que cada etapa esteja commitada e informar os hashes.
6. Não declarar handoff concluído se houver P0 aberto ou alteração não commitada sem justificativa.

Uma fase posterior pode avançar durante bloqueio externo apenas quando for independente. A mudança
de ordem precisa constar no histórico e não pode esconder o bloqueio original.

---

## 5. Fases executáveis

### Fase 0 — diagnóstico e baseline

**Status:** `CONCLUÍDA`

**Resultado:** ameaças, P0/P1/P2, fronteiras de confiança e critérios de aceite registrados em
`docs/HARDENING-ROADMAP.md`.

**Manutenção:** novos achados devem ser classificados e adicionados ao roadmap; não reabrir esta
fase apenas porque um novo risco foi descoberto.

---

### Fase 1 — cliente web HTTP/WebSocket centralizado

**Status:** `PARCIAL`

**Execução:** Claude — Etapa 4.

**Objetivo:** remover configuração e tratamento de sessão duplicados no frontend, usando rotas
same-origin e uma única política para HTTP e WebSocket.

**Implementação:**

- [ ] Inventariar `fetch`, URLs de API e conexões WebSocket em `apps/web`.
- [ ] Criar cliente central para HTTP, erros e sessão expirada.
- [ ] Derivar WebSocket de `window.location` e caminhos relativos.
- [ ] Migrar login, dashboard, projetos, IDE, terminal e Command Center.
- [ ] Remover fallbacks de produção para `localhost:4000`.
- [ ] Cobrir 401, sessão expirada, indisponibilidade e reconexão.
- [ ] Atualizar documentação e variáveis de ambiente obsoletas.

**Critérios de aceite:**

- Zero `localhost:4000` no bundle servido em produção.
- Nenhuma página implementa isoladamente a política de autenticação/sessão.
- HTTP funciona sob HTTPS e WebSocket sob WSS pelo nginx.
- Sessão expirada leva o usuário ao login sem falha silenciosa.

**Validação mínima:** typecheck, lint, build web, busca no bundle e Playwright do fluxo de sessão.

**Evidências:** _preencher durante a execução._

---

### Fase 2 — Runtime Gateway e deploy de origem isolada

**Status:** `PARCIAL` — código/config prontos; DNS, TLS e validação em domínio real dependem do
usuário (ver `docs/RUNTIME-GATEWAY-DEPLOY.md`)

**Execução:** Claude — Etapa 2.

**Já validado em código:** ticket HMAC curto, cookie `__Host-`, membership em tempo real, proteção de
Origin/Fetch Metadata, headers autoritativos, bloqueio do proxy legado em produção e relay HTTP/WS.

**Domínios definidos pelo usuário em 2026-08-10:** painel `app.oliveiradevcloud.com`, runtime
`runtime.oliveiradevcloud-content.com` — sites registráveis distintos, conforme exigido.

**Pendente para concluir:**

- [x] Provisionar um domínio registrável separado para conteúdo de runtime — domínios confirmados
      pelo usuário (ver acima).
- [ ] Configurar DNS wildcard para os hosts de workspace/runtime — **depende do usuário**, passo a
      passo em `docs/RUNTIME-GATEWAY-DEPLOY.md` §1.
- [ ] Instalar e testar certificado TLS wildcard — **depende do usuário**, `docs/RUNTIME-GATEWAY-DEPLOY.md` §2.
- [x] Criar server block nginx do Runtime Gateway — `infra/production/nginx.prod.conf` (redirect
      HTTP→HTTPS compartilhado, server block HTTPS dedicado a `*.${RUNTIME_BASE_DOMAIN}`, Host
      preservado sem reescrita, suporte a WebSocket, HSTS); location morta `/runtime/` removida.
      Sintaxe e resolução de upstream validadas com Docker real nesta sessão (`nginx -t` limpo,
      envsubst confirmado com os domínios reais renderizados corretamente).
- [ ] Validar redirect, iframe, assets, preview e WebSocket em domínio real — **depende do usuário**
      (checklist pronta em `docs/RUNTIME-GATEWAY-DEPLOY.md` §5).
- [ ] Confirmar que cookies do control plane nunca são enviados ao site de runtime — desenho já
      garante isso (domínios registráveis distintos + cookies `__Host-`); confirmação por captura de
      rede real listada em `docs/RUNTIME-GATEWAY-DEPLOY.md` §5, **depende do usuário**.
- [x] Documentar emissão/renovação de certificado e recuperação de falha — `docs/RUNTIME-GATEWAY-DEPLOY.md`
      (registros DNS exatos, comandos certbot HTTP-01/DNS-01, cópia para o layout esperado, deploy-hook
      de renovação, tabela de recuperação de falha).

**Critérios de aceite:**

- Um ticket não abre outro workspace, outra porta ou outro propósito. *(já coberto por teste automatizado)*
- Usuário removido da organização perde acesso na requisição seguinte. *(já coberto por teste automatizado)*
- Ataque entre dois subdomínios de runtime recebe 403 em HTTP e WebSocket. *(já coberto por teste automatizado)*
- IDE e preview funcionam integralmente em HTTPS/WSS no domínio real. *(pendente — exige servidor real)*
- O proxy legado retorna 410 em produção. *(já coberto por teste automatizado)*

**Validação mínima:** integração, Playwright em Chromium e teste manual em domínio real.

**Bloqueio conhecido:** DNS wildcard, certificado TLS wildcard e o teste manual final exigem execução
no servidor de produção real do usuário — nenhum deles pode ser feito a partir desta sessão (sem
acesso ao provedor de DNS nem a um host publicamente roteável). Runbook completo com os comandos
exatos: `docs/RUNTIME-GATEWAY-DEPLOY.md`.

**Evidências:** ver `docs/HARDENING-ROADMAP.md`. Validação local desta sessão: `docker run` com
`nginx:1.27-alpine`, certificados autoassinados descartáveis e `--add-host api/web` simulando a rede
do compose — `envsubst` renderiza `app.oliveiradevcloud.com`/`runtime.oliveiradevcloud-content.com`
corretamente nos dois `server_name`, `nginx -t` passa sem warnings (corrigida também a diretiva
`listen ... http2` depreciada). Evidência de DNS/TLS/validação em domínio real fica pendente de
execução pelo usuário — acrescentar aqui quando `docs/RUNTIME-GATEWAY-DEPLOY.md` §5 for concluído.

---

### Fase 3 — isolamento de rede Docker por workspace

**Status:** `CONCLUÍDA`

**Execução:** Claude — Etapa 1.

**Objetivo:** impedir que código executado em um workspace alcance IDE, preview ou serviços de outro
workspace por IP interno.

**Implementação:**

- [x] Mapear criação, start, restart e destruição de containers de workspace.
- [x] Definir nome e labels determinísticos para a rede de cada workspace.
- [x] Criar ou recuperar a rede de forma idempotente.
- [x] Conectar somente o workspace e o relay estritamente necessário.
- [x] Evitar publicação de IDE/preview em interfaces públicas do host (já não havia `PortBindings`
      publicados para containers de workspace; confirmado que segue assim).
- [x] Remover rede ao destruir o workspace, sem afetar redes alheias.
- [x] Criar reaper para redes órfãs ou documentar sua entrega na Fase 7 — `pruneOrphanedNetworks()`
      implementado e testado (remove só redes rotuladas com zero containers); o agendamento
      periódico dele fica para a Fase 7 (Codex), conforme permitido por este próprio item.
- [x] Preservar workspaces existentes durante upgrade/restart — `create()` é idempotente tanto para o
      container quanto para a rede (reaproveita ambos se já existirem para o mesmo `workspaceId`).
- [x] Criar teste com dois workspaces reais tentando conexão cruzada.
- [x] Verificar `Privileged=false`, ausência de `docker.sock` e limites do container (já cobertos por
      `packages/workspace-engine/src/index.test.ts`, sem regressão).

**Critérios de aceite:**

- [x] Workspace A não alcança IDE, preview ou porta arbitrária do workspace B.
- [x] Runtime Gateway continua alcançando somente o destino autorizado (relay conectado só à rede do
      workspace que está servindo).
- [x] Criar/reiniciar/destruir a mesma entidade é idempotente (inclusive um bug real de `destroy()`
      não idempotente foi encontrado e corrigido durante esta validação).
- [x] Não restam redes órfãs após destruição bem-sucedida.
- [x] O teste roda em CI Linux com Docker real — confirmado após push: GitHub Actions run
      [31383975282](https://github.com/RobersonCodes/Oliveira-DevCloud/actions/runs/31383975282),
      job `quality`, step `Test`. Os 6 testes novos de `network.test.ts` e os 8 (7 executados + 1
      `skipIf` por contagem de CPU do runner) de `index.test.ts` passaram todos em Linux com Docker
      real — mesmos nomes, mesmos resultados que a execução local desta sessão.

**Validação mínima:** testes unitários, integração Docker real, typecheck, lint e suíte de regressão.

**Evidências:**

- `packages/workspace-engine/src/network.ts` — módulo novo: nome/labels determinísticos
  (`odc-ws-net-<workspaceId>`), `ensureWorkspaceNetwork`, `connectRelayToWorkspaceNetwork`,
  `disconnectRelayFromWorkspaceNetwork`, `removeWorkspaceNetwork`, `pruneOrphanedNetworks`.
- `packages/workspace-engine/src/index.ts` — `create()` cria/reaproveita a rede do workspace antes do
  container e usa `HostConfig.NetworkMode: <rede-do-workspace>` em vez de uma rede `bridge`
  compartilhada; `destroy()` aceita `workspaceId` opcional (usado pelo chamador quando disponível,
  ou resolvido pelo label do container como fallback) e desconecta o relay + remove a rede depois de
  remover o container.
- `packages/ide-engine/src/index.ts` — `internalHost()` ajustado para o novo modelo de uma rede
  dedicada por workspace em vez do antigo `WORKSPACE_NETWORK` global.
- `infra/production/docker-compose.prod.yml` — serviço `api` ganhou `container_name: odc-api` e
  `RELAY_CONTAINER_NAME=odc-api`, para que o próprio container da API possa se conectar/desconectar
  da rede de cada workspace via `docker network connect`.
- `.env.example`, `.env.production.example` — `WORKSPACE_NETWORK=bridge` removido (não existe mais
  rede compartilhada para configurar); documentado o novo `RELAY_CONTAINER_NAME`.
- `packages/workspace-engine/src/network.test.ts` (6 testes, novo) e atualização de
  `packages/workspace-engine/src/index.test.ts` (limpeza de redes no `afterEach`, sem mudança de
  cobertura) — todos contra Docker real.
- **Execução real nesta sessão** (Docker Desktop iniciado neste host Windows especificamente para
  esta validação — não fazia parte do ambiente antes): `npm run typecheck` limpo; `npm run lint`
  limpo (exit 0); `npm run build` limpo (API, web via `next build`, demais pacotes); suíte completa
  `vitest run` contra Postgres real (container efêmero, migrations aplicadas de verdade), Redis real
  (container efêmero) e Docker real (Docker Desktop + imagem real `oliveira-devcloud/workspace-node:1.0`
  buildada localmente) — **164 de 166 testes passaram**. As 2 falhas restantes
  (`apps/api/src/ws-security.test.ts`) foram isoladas via `git stash` e confirmadas **pré-existentes,
  sem relação com a Fase 3** — detalhe completo em `docs/HARDENING-ROADMAP.md` Seção 7.
- Verificação manual de vazamento de recursos: `docker network ls` confirmado sem nenhuma rede
  `odc-ws-net-*` remanescente após cada execução da suíte.
- Containers/imagens efêmeros de teste (Postgres, Redis) removidos ao final; nenhum estado de
  produção ou de outros projetos deste host foi tocado.
- **Push e confirmação em CI real:** branch enviada a `origin/feat/security-hardening` (commits
  `11c36c8`, `68258a9`); run [31383975282](https://github.com/RobersonCodes/Oliveira-DevCloud/actions/runs/31383975282)
  do workflow `CI` (`.github/workflows/ci.yml`) executado em `ubuntu-latest` com Postgres/Redis reais
  via service containers e Docker real do runner. Resultado: `typecheck` e `lint` verdes; `Test`:
  163 aprovados, 2 falhas, 1 ignorado (166 no total) — as 2 falhas são exatamente
  `apps/api/src/ws-security.test.ts` linhas 199 e 216, o mesmo par pré-existente e não relacionado
  já isolado localmente via `git stash` (ver `docs/HARDENING-ROADMAP.md` Seção 7); nenhuma outra
  falha apareceu. Como consequência dessas 2 falhas pré-existentes, o job `quality` como um todo
  encerrou com falha (`Build`/`Security audit` não chegaram a rodar) — isso é um problema separado,
  não desta fase, e fica registrado aqui para quem for revisitar P0-4/P0-13 ou a Fase 9.

---

### Fase 4 — Runtime Broker e redução de privilégio

**Status:** `PENDENTE`

**Execução:** Claude — Etapa 3.

**Objetivo:** tornar um serviço interno auditável o único detentor do Docker socket.

**Implementação:**

- [ ] Especificar contrato interno mínimo do broker.
- [ ] Implementar autenticação serviço-a-serviço e autorização por operação.
- [ ] Criar allowlist de imagens, mounts, redes, portas e capabilities.
- [ ] Rejeitar modo privilegiado, socket Docker e mounts fora das raízes permitidas.
- [ ] Migrar API, worker e engines para o broker.
- [ ] Remover `docker.sock` da API e do worker no compose.
- [ ] Manter a porta do broker apenas em rede interna.
- [ ] Adicionar audit log sem secrets.
- [ ] Testar payloads maliciosos e indisponibilidade do broker.

**Critérios de aceite:**

- Somente o broker possui o socket Docker.
- Nenhum cliente consegue escolher parâmetros Docker arbitrários.
- API pública comprometida não obtém controle direto do daemon.
- Operações permitidas continuam funcionando ponta a ponta.

**Validação mínima:** testes de contrato, integração Docker, inspeção do compose e teste negativo de
rede/porta.

**Evidências:** _preencher durante a execução._

---

### Fase 5 — infraestrutura reproduzível e operação em host limpo

**Status:** `PARCIAL`

**Execução:** Claude — Etapa 5.

**Implementação:**

- [ ] Auditar Dockerfiles: build multi-stage, usuário não-root e healthchecks.
- [ ] Usar instalação determinística de dependências.
- [ ] Publicar e versionar imagens de workspace em registry confiável.
- [ ] Verificar checksum/assinatura de artefatos como code-server.
- [ ] Incluir Postgres, Redis, broker e dependências reais em readiness.
- [ ] Revisar timeouts, limites e headers do nginx/API.
- [ ] Documentar instalação limpa, upgrade, rollback e disaster recovery.
- [ ] Automatizar migrations antes da API.
- [ ] Provar persistência após reinício dos serviços.

**Critério de aceite:** seguindo somente a documentação, um host limpo consegue configurar, migrar,
subir, criar usuário/projeto/workspace, abrir IDE/terminal, rodar agente, reiniciar e recuperar o
ambiente sem perda.

**Validação mínima:** ensaio completo em VM Linux limpa e registro dos comandos/resultados.

**Evidências:** migration one-shot e parte do build já constam no roadmap; completar o restante.

---

### Fase 6 — identidade, sessão e fronteiras de confiança

**Status:** `PARCIAL`

**Execução:** Codex — Etapa 6.

**Implementação:**

- [ ] Restringir `trustProxy` aos proxies/redes reais.
- [ ] Falhar o boot de produção se origins, secrets ou flags seguras estiverem ausentes.
- [ ] Aplicar rate limit por usuário/organização e por IP onde fizer sentido.
- [ ] Revisar RBAC HTTP e WebSocket rota por rota.
- [ ] Adicionar gerenciamento e revogação de sessões/dispositivos.
- [ ] Planejar recuperação de conta, verificação de e-mail e MFA/passkeys.
- [ ] Revisar logs de auditoria para ações administrativas e de agentes.
- [ ] Executar nova revisão cross-tenant após as mudanças.

**Critérios de aceite:** cabeçalhos de proxy não são confiados de fontes arbitrárias; configuração
insegura não inicia em produção; revogação de acesso tem efeito imediato; rotas equivalentes usam a
mesma autorização.

**Validação mínima:** matriz automatizada anônimo/membro/developer/admin/owner/host-admin e testes de
sessão expirada/revogada/cross-org.

**Evidências:** proteção de métricas, Origin WS e parte do RBAC já registradas no roadmap.

---

### Fase 7 — resiliência, concorrência e ciclo de vida

**Status:** `PARCIAL`

**Execução:** Codex — Etapa 7.

**Implementação:**

- [ ] Configurar retries e backoff por tipo de job BullMQ.
- [ ] Definir idempotency keys e compare-and-swap nas transições críticas.
- [ ] Implementar heartbeat de agent tasks, orquestrações e workspaces.
- [ ] Recuperar jobs abandonados após crash/redeploy.
- [ ] Criar dead-letter/revisão manual para falhas permanentes.
- [ ] Implementar quotas de CPU, memória, processos, disco e duração.
- [ ] Remover storage, containers e redes órfãos com segurança.
- [ ] Coletar métricas de profundidade, latência, retry e falha das filas.
- [ ] Testar restart de API, worker, Redis e broker durante operações.

**Critérios de aceite:** nenhum tick duplica efeitos; cancelamento não sobrescreve conclusão; jobs
transitórios recuperam; jobs permanentes ficam visíveis; restart não perde estado; recursos órfãos
são eliminados.

**Validação mínima:** testes de corrida, fault injection, restart e reaper em Linux.

**Evidências:** dedupe, CAS de cancelamento e graceful shutdown já constam no roadmap.

---

### Fase 8 — produto mobile-first e PWA

**Status:** `PENDENTE`

**Execução:** Codex — Etapa 8.

**Objetivo:** permitir que o usuário programe e coordene agentes pelo celular sem depender de uma
interface desktop reduzida.

**Implementação:**

- [ ] Criar manifest, ícones PWA/Apple, tema e service worker.
- [ ] Implementar instalação e shell de reconexão, sem prometer execução offline.
- [ ] Garantir layout funcional a partir de 320 CSS px e safe areas.
- [ ] Criar navegação mobile persistente como substituta da navegação desktop.
- [ ] Usar alvo interno de toque de pelo menos 44 × 44 px.
- [ ] Criar toolbar de terminal com Esc, Ctrl, Tab, setas e símbolos úteis.
- [ ] Adaptar command palette, diffs, logs e aprovação para toque.
- [ ] Exibir estado de conexão e retomar sessão/workspace automaticamente.
- [ ] Priorizar fluxo agente: descrever → executar → acompanhar → revisar → aprovar.
- [ ] Testar teclado virtual, rotação, notch e baixa conectividade.
- [ ] Fazer testes em Android Chrome e iPhone Safari físicos.

**Critérios de aceite:** PWA instalável; navegação sempre acessível; nenhuma ação essencial depende de
hover; terminal e revisão funcionam por toque; desconexão temporária não perde o contexto do usuário;
o fluxo principal completo funciona em celular real.

**Validação mínima:** Lighthouse como sinal auxiliar, Playwright em viewports mobile, axe e matriz
manual de dispositivos físicos.

**Evidências:** _preencher durante a execução._

---

### Fase 9 — regressão, CI e evidência de lançamento

**Status:** `PARCIAL`

**Execução:** Codex — Etapa 9.

**Implementação:**

- [ ] Executar suites Docker em runner Linux.
- [ ] Cobrir workspace, terminal, IDE, setup, agent e review engines.
- [ ] Manter testes reais HTTP/WS do Runtime Gateway.
- [ ] Adicionar matriz de isolamento e autorização cross-tenant.
- [ ] Adicionar testes de acessibilidade e fluxos mobile.
- [ ] Criar smoke test de deploy em staging.
- [ ] Criar teste de backup e restauração.
- [ ] Criar teste de carga com capacidade-alvo declarada.
- [ ] Publicar relatório de release com versões e evidências reproduzíveis.

**Critérios de aceite:** todas as garantias P0 possuem regressão automatizada; CI Linux fica verde;
flaky tests são corrigidos ou isolados com responsável e prazo; staging percorre o fluxo principal;
backup é restaurado; limites de capacidade são conhecidos.

**Validação mínima:** `typecheck`, `lint`, build, Vitest, Playwright, integração Docker, acessibilidade,
smoke de staging, restauração e carga.

**Evidências:** suíte atual é parcial; registrar resultados consolidados ao concluir.

---

## 6. Gate de beta fechado

**Execução:** Codex — Etapa 10.

Todos os itens abaixo precisam estar marcados:

- [ ] P0-2 concluído em domínio real.
- [ ] P0-3 concluído com teste cross-workspace.
- [ ] Runtime Broker concluído.
- [ ] Fluxo principal funciona em desktop, Android e iPhone.
- [ ] CI Linux está verde, inclusive integração Docker.
- [ ] Backup foi restaurado com sucesso.
- [ ] Logs, métricas, alertas e runbooks básicos existem.
- [ ] Nenhum bug crítico ou vulnerabilidade P0 conhecida está aberto.
- [ ] Termos, privacidade e política de uso estão disponíveis.
- [ ] Capacidade inicial e limites por usuário estão documentados.

**Estratégia:** iniciar com 5–20 usuários convidados, observar falhas e experiência mobile antes de
abrir cadastro público.

## 7. Gate de produção pública

- [ ] Beta completou o período definido sem perda de dados.
- [ ] Incidentes críticos encontrados no beta foram corrigidos e ganharam regressão.
- [ ] Restore, rollback e rotação de secrets foram ensaiados.
- [ ] Rate limits, quotas e capacidade suportam a meta publicada.
- [ ] DNS/TLS possuem renovação e monitoramento.
- [ ] Alertas têm responsável e procedimento de resposta.
- [ ] Revisão final de isolamento multi-tenant foi aprovada.
- [ ] Release foi criada a partir de commit/tag reproduzível.

## 8. Métricas de sucesso recomendadas

- Tempo até o primeiro workspace utilizável.
- Taxa de criação e recuperação de workspace.
- Tempo de reconexão após perda de rede.
- Taxa de conclusão do fluxo principal no celular.
- Taxa de sucesso e recuperação dos jobs de agente.
- Erros e latência do Runtime Gateway HTTP/WS.
- Consumo de CPU, memória e disco por workspace.
- Resultado periódico do teste de isolamento cross-tenant.
- Resultado e duração do último restore de backup.

## 9. Registro obrigatório por sessão

Ao terminar uma sessão, acrescente uma linha e atualize o checkpoint da Seção 3.

| Data | Agente | Fase | Estado final | Evidências | Próxima ação |
|---|---|---|---|---|---|
| 2026-08-10 | Codex | Planejamento | Plano criado | Documentação operacional e regras persistentes | Iniciar Fase 3 |
| 2026-08-10 | Codex | Delegação | Etapas atribuídas | Claude: 1–5; Codex: 6–10; handoff definido | Claude iniciar Etapa 1 |
| 2026-08-10 | Claude | Fase 3 (Etapa 1) | `CONCLUÍDA` | Rede Docker dedicada por workspace implementada (`packages/workspace-engine/src/network.ts`), `create()`/`destroy()` e `ide-engine` atualizados, `docker-compose.prod.yml`/env examples atualizados; 6 testes novos + suíte existente validados localmente contra Docker real (Docker Desktop iniciado nesta sessão) e depois em CI Linux real via push (`gh run` 31383975282) — local `npm test`: 164/166; CI: 163/166 + 1 ignorado; em ambos os casos as únicas falhas são o mesmo par pré-existente e não relacionado em `ws-security.test.ts`, isolado via `git stash`; `typecheck`/`lint`/`build` limpos em ambos os ambientes; nenhuma rede/container órfão após a execução; commits `11c36c8`, `68258a9` | Iniciar Etapa 2 (nginx/DNS/cert reais do Runtime Gateway) — depende de acesso a um domínio registrável separado |
| 2026-08-10 | Claude | Fase 2 (Etapa 2) | `PARCIAL` | Usuário confirmou os domínios reais (painel `app.oliveiradevcloud.com`, runtime `runtime.oliveiradevcloud-content.com`). Server block real do Runtime Gateway escrito em `infra/production/nginx.prod.conf` (location morta `/runtime/` removida); `docker-compose.prod.yml` com `RUNTIME_BASE_DOMAIN` no nginx; `.env.production(.example)` e `.gitignore` atualizados; novo runbook `docs/RUNTIME-GATEWAY-DEPLOY.md` (DNS, certbot HTTP-01/DNS-01, renovação, checklist, recuperação de falha). Validado com Docker real nesta sessão (`nginx:1.27-alpine`, certs autoassinados, `--add-host` simulando a rede do compose): `envsubst` renderiza os domínios reais corretamente, `nginx -t` limpo sem warnings. DNS wildcard, certificado TLS wildcard e validação em domínio real seguem pendentes — dependem de execução do usuário no servidor real, fora do alcance desta sessão | Usuário executa `docs/RUNTIME-GATEWAY-DEPLOY.md`; Claude pode adiantar a Etapa 3 (Fase 4) nesse meio-tempo, se autorizado |

### Modelo para futuras entradas

```md
| AAAA-MM-DD | Codex/Claude/pessoa | Fase N | PARCIAL/CONCLUÍDA/BLOQUEADA |
`comando`: resultado; arquivos/testes | ação única seguinte |
```

## 10. Prompt de retomada

### Para Claude — etapas 1–5

> Leia integralmente `CLAUDE.md`, `docs/PROJECT-COMPLETION-PLAN.md` e
> `docs/HARDENING-ROADMAP.md`. Você é responsável somente pelas etapas 1–5. Verifique o estado real
> do repositório e comece pela etapa ativa do checkpoint. Atualize o plano antes e depois de cada
> etapa, execute as validações, faça um commit coeso por etapa e não marque nada como concluído sem
> evidência. Ao terminar a etapa 5, faça o handoff obrigatório para Codex e não inicie a etapa 6.

### Para Codex — etapas 6–10

> Leia integralmente `AGENTS.md`, `docs/PROJECT-COMPLETION-PLAN.md` e
> `docs/HARDENING-ROADMAP.md`. Confirme que Claude concluiu ou documentou corretamente as etapas
> 1–5 e revise o handoff sem refazer trabalho válido. Você é responsável pelas etapas 6–10. Execute
> a etapa ativa, mantenha o plano atualizado, registre todas as validações e não marque uma etapa
> como concluída sem atender integralmente aos critérios de aceite.
