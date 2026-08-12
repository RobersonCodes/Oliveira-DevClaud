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
| Atualizado em | 2026-08-12 |
| Branch de referência | `feat/security-hardening` |
| Commit de referência | `e365017` (`fix(fase6): align HTTP and websocket RBAC`) |
| Estado conhecido | 15 de 15 P0 corrigidos e sem nenhum aberto; Fases 1, 3 e 4 concluídas; Fase 2 `PARCIAL` aguardando SSH restrito para o deploy real; Fase 5 `PARCIAL` com imagem `1.1.0` publicada no GHCR e ensaio automatizado integral aprovado em `ubuntu-latest` (pull por digest, Compose, migrations, usuário/projeto/workspace/terminal, restart, persistência e restore isolado); execução autenticada de agente ainda depende de credencial do usuário. Na Fase 6, P1-1/P1-2/P1-3, rate limit em camadas e revisão RBAC HTTP/WebSocket estão corrigidos e validados em CI e smoke limpo |
| Etapa ativa | Etapa 6 — identidade, sessão e fronteiras de confiança; pendências externas das Etapas 2 e 5 preservadas |
| Responsável | Codex — pendências das Etapas 2 e 5 reatribuídas pelo usuário em 2026-08-10 |
| Status | `EM ANDAMENTO` |
| Próxima ação única | Adicionar listagem e revogação de sessões/dispositivos, com regressões de sessão atual, expirada e revogada (Fase 6) |
| Bloqueios externos | A aplicação real da Etapa 2 depende de a regra SSH restrita a `186.219.142.107/32` estar ativa e de existir autenticação por chave para a VPS. A conclusão integral da Etapa 5 depende de uma credencial Codex ou Claude configurada diretamente pelo usuário no workspace para o smoke autenticado; nenhum secret de provedor está configurado no repositório. Testes físicos finais da Etapa 8 exigirão Android e iPhone reais. |

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
  [31383975282](https://github.com/RobersonCodes/Oliveira-DevCloud/actions/runs/31383975282)
  (Fase 3): `typecheck`/`lint` verdes; `Test` 163 aprovados / 2 falhas (as mesmas 2 pré-existentes e
  não relacionadas de `ws-security.test.ts`, na época) / 1 ignorado, 166 no total. `Build`/
  `Security audit` não rodaram porque o job encerra no primeiro `Test` vermelho; não avaliados
  nesta run.
- **Fase 4 (2026-08-10):** suíte local `vitest run` — **189 de 189 aprovados, 24 de 24 arquivos**,
  zero falhas (inclusive `ws-security.test.ts` agora corrigido de verdade, não mais pré-existente).
  CI Linux, run
  [31394449630](https://github.com/RobersonCodes/Oliveira-DevCloud/actions/runs/31394449630):
  **job `quality` inteiro verde** — `Lint`, `Typecheck`, `Test`, `Build` e `Security audit` todos
  ✓ — primeira vez neste projeto em que o CI passa 100%, incluindo as suítes Docker
  (`git-engine`/`workspace-engine`/`e2e`) que antes só rodavam de verdade em CI Linux e nunca tinham
  sido confirmadas verdes ali.
- **Fase 5 (2026-08-11):** CI Linux no commit `5bdd7d8`, runs
  [31524472703](https://github.com/RobersonCodes/Oliveira-DevCloud/actions/runs/31524472703) e
  [31524467564](https://github.com/RobersonCodes/Oliveira-DevCloud/actions/runs/31524467564):
  verificação da imagem, lint, typecheck, testes, build e audit todos verdes. O falso negativo que
  usava a primeira linha informativa de `code-server --version` foi corrigido. No commit `20df932`,
  o run [31525879533](https://github.com/RobersonCodes/Oliveira-DevCloud/actions/runs/31525879533)
  aprovou o smoke de produção em Linux limpo, inclusive restore isolado.
- **Fase 6/P1-1 (2026-08-12):** regressão local `trusted-proxy.test.ts` — **10 de 10 aprovada**;
  `npm run typecheck`, `npm run lint` e build da API aprovados. No commit `30e5490`, o CI Linux
  [31528430998](https://github.com/RobersonCodes/Oliveira-DevCloud/actions/runs/31528430998)
  aprovou lint, typecheck, testes, build e audit, e o smoke de produção em host limpo
  [31528431019](https://github.com/RobersonCodes/Oliveira-DevCloud/actions/runs/31528431019)
  aprovou a descoberta do gateway Compose por `/32` e confirmou no `AuditLog` que somente esse
  proxy confiável fornece o IP encaminhado do cliente.
- **Fase 6/P1-2/P1-3 (2026-08-12):** regressões direcionadas de configuração/proxy/cookie — **45 de
  45 aprovadas**; `npm run typecheck`, `npm run lint`, build da API, `git diff --check` e renderização
  do Compose aprovados. A suíte `runtimeGateway.test.ts` não pôde ser executada neste terminal:
  todos os casos interromperam na fixture antes das asserções porque `DATABASE_URL`/PostgreSQL não
  estão disponíveis; Docker Desktop também está parado. Essa limitação foi suprida no commit
  `c593287`: o CI Linux [31620694690](https://github.com/RobersonCodes/Oliveira-DevCloud/actions/runs/31620694690)
  aprovou migrations, lint, typecheck, testes, build e audit, e o smoke de produção em host limpo
  [31620699908](https://github.com/RobersonCodes/Oliveira-DevCloud/actions/runs/31620699908)
  aprovou a stack integral e publicou evidência sanitizada.

Os números acima são apenas o baseline. Substitua-os pelos resultados reais de cada nova execução.

## 4. Divisão de execução e ordem obrigatória

As fases técnicas preservam a numeração do roadmap de hardening. Para dividir o trabalho sem mudar
o significado delas, a execução usa dez **etapas operacionais**:

| Etapa | Responsável | Fase técnica | Entrega | Dependência |
|---|---|---|---|---|
| 1 | Claude | Fase 3 | Isolamento Docker por workspace | Nenhuma |
| 2 | Claude → Codex (reatribuída) | Fase 2 (deploy) | DNS, TLS e nginx reais do Runtime Gateway | Acesso ao domínio/deploy |
| 3 | Claude | Fase 4 | Runtime Broker e retirada do Docker socket | Etapa 1 |
| 4 | Claude | Fase 1 | Cliente HTTP/WebSocket centralizado | Etapa 2 |
| 5 | Codex (reatribuída) | Fase 5 | Infraestrutura reproduzível em host limpo | Etapas 1–4 |
| 6 | Codex | Fase 6 | Identidade, sessão e fronteiras de confiança | Handoff das etapas 1–5 |
| 7 | Codex | Fase 7 | Resiliência, concorrência e ciclo de vida | Etapas 3 e 6 |
| 8 | Codex | Fase 8 | Experiência mobile-first e PWA | Etapas 4–7 |
| 9 | Codex | Fase 9 | Matriz final de testes e regressões | Etapas 1–8 |
| 10 | Codex | Release | Beta fechado e gate de produção | Etapa 9 |

### Contrato de responsabilidade

- Claude é executor exclusivo das etapas 1–5. Não inicia a etapa 6.
- Codex é executor exclusivo das etapas 6–10. Antes da etapa 6, revisa o handoff das etapas 1–5,
  mas não as refaz sem registrar um defeito verificável.
- **Exceção autorizada pelo usuário em 2026-08-10:** após o encerramento dos créditos do Claude,
  as partes ainda pendentes das Etapas 2 e 5 foram reatribuídas ao Codex. As Etapas 1, 3 e 4
  concluídas pelo Claude permanecem preservadas; a reatribuição não autoriza refazê-las sem defeito
  verificável.
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

**Status:** `CONCLUÍDA`

**Execução:** Claude — Etapa 4.

**Objetivo:** remover configuração e tratamento de sessão duplicados no frontend, usando rotas
same-origin e uma única política para HTTP e WebSocket.

**Implementação:**

- [x] Inventariar `fetch`, URLs de API e conexões WebSocket em `apps/web`.
- [x] Criar cliente central para HTTP, erros e sessão expirada.
- [x] Derivar WebSocket de `window.location` e caminhos relativos.
- [x] Migrar login, dashboard, projetos, IDE, terminal e Command Center.
- [x] Remover fallbacks de produção para `localhost:4000`.
- [x] Cobrir 401, sessão expirada, indisponibilidade e reconexão.
- [x] Atualizar documentação e variáveis de ambiente obsoletas.

**Critérios de aceite:**

- [x] Zero `localhost:4000` no bundle servido em produção.
- [x] Nenhuma página implementa isoladamente a política de autenticação/sessão.
- [x] HTTP funciona sob HTTPS e WebSocket sob WSS pelo nginx. (produção: nginx já fazia isso antes da
      Fase 1; validado nesta fase que o client não injeta mais nenhum host próprio que quebraria isso.
      WSS ponta a ponta em domínio real segue dependente da Etapa 2, como já registrado na Fase 2.)
- [x] Sessão expirada leva o usuário ao login sem falha silenciosa.

**Validação mínima:** typecheck, lint, build web, busca no bundle e Playwright do fluxo de sessão.

**Evidências:**

- `apps/web/lib/apiClient.ts` (novo): `apiFetch`/`apiJson` (redirect para `/login` em `401`, exceto
  `/api/v1/auth/*`), `apiWebSocketUrl`/`apiWebSocket` (deriva `ws:`/`wss:` de `window.location.protocol`,
  host relativo), `apiEventSource` (`EventSource` com `withCredentials:true`).
- `apps/web/next.config.js` (novo): `rewrites()` só ativo em dev (`API_PORT`, default `4000`); em
  produção o nginx já roteia `/api/` antes de chegar ao Next — código morto em produção por desenho.
- 14 páginas migradas (`login`, `page.tsx` raiz, `projects`, `ide`, `terminal`, `command-center`,
  `agents`, `orchestrations`, `onboarding`, `import`, `code-intelligence`, `contract-intelligence`,
  `repository-map`, `settings/secrets`): removido `NEXT_PUBLIC_API_URL`/fallback `localhost:4000`,
  toda chamada usa `apiFetch`/`apiJson` com caminho relativo. `ide/page.tsx` mantém comentário
  explícito de que a URL de runtime ticket NÃO deve virar relativa (cross-origin por desenho,
  Fase 2/P0-2). `terminal/page.tsx` usa `apiWebSocket`; `onboarding/page.tsx` usa `apiEventSource`.
- `infra/production/Dockerfile.web`, `infra/production/docker-compose.prod.yml`, `.env.example`,
  `.env.production.example` e `.env.production`: `NEXT_PUBLIC_API_URL`/`ARG`/`ENV`/`build.args`
  removidos, substituídos por comentário explicando o roteamento same-origin.
- `npm run typecheck` e `npm run lint`: aprovados no monorepo após a migração.
- `npm run build -w @oliveira/web`: aprovado; busca por `localhost:4000` no diretório `.next` de
  build de produção retornou zero ocorrências.
- **Validação end-to-end com infraestrutura real** (Postgres/Redis efêmeros via `docker run`, Docker
  Desktop real, `next dev` na porta 3001 fazendo o rewrite para a API real na porta 4000), sessão de
  2026-08-10:
  - HTTP via proxy: `POST /api/v1/auth/register` (201 + `Set-Cookie`), `GET /api/v1/organizations`
    sem cookie (401 real da API, não 404 do Next — prova que o rewrite alcançou o destino) e com
    cookie (200 com dados reais) — todos por `http://localhost:3001` (nunca `:4000`).
  - Pilha completa Fase 1 → Fase 4 (broker) → Docker real: criação de organização, projeto e
    workspace real (`containerId` real, `status: RUNNING`) inteiramente via `http://localhost:3001`.
  - WebSocket de terminal via proxy: sessão de terminal real criada, conectada via
    `ws://localhost:3001/api/v1/terminals/<id>/connect` (upgrade concluído pelo rewrite do
    `next.config.js`), I/O bidirecional real confirmado com um comando `echo` de fato executado
    dentro do tmux do container e ecoado de volta pelo WebSocket.
  - SSE (`EventSource`) via proxy: `setup job` real criado e consumido via
    `GET http://localhost:3001/api/v1/setup/jobs/<id>/events` com `curl -N`, múltiplos eventos
    `event: setup` distintos recebidos em stream (não um único corpo bufferizado), confirmando que o
    rewrite não quebra respostas de streaming HTTP.
  - Achado durante essa validação (não bloqueante para esta fase, registrado como `P1-18` em
    `docs/HARDENING-ROADMAP.md`): o handler WS de terminal no backend (`apps/api/src/routes/terminals.ts`)
    tem um bug pré-existente, não relacionado à mudança same-origin — usa `Buffer.isBuffer(raw)` para
    decidir se o payload é o envelope JSON `{type:'input'|'resize',...}`, mas a lib `ws` sempre entrega
    `data` como `Buffer` (mesmo para frames de texto), então esse branch nunca é `false` e o parse JSON
    nunca roda; cada tecla digitada no terminal real escreve o JSON literal no pty em vez do caractere,
    e `resize` nunca é aplicado. Confirmado isoladamente com um servidor `ws` mínimo e reproduzido fim a
    fim contra um terminal real. Fora do escopo da Fase 1 (o mecanismo de proxy/roteamento em si
    funciona corretamente); fica pendente para correção em fase própria.
- **CI Linux (GitHub Actions)**, commit `6c4cbfe` (inclui todo o trabalho da Fase 1 + `AGENTS.md`/
  `CLAUDE.md`), run
  [31407321460](https://github.com/RobersonCodes/Oliveira-DevCloud/actions/runs/31407321460):
  **job `quality` inteiro verde** — `Lint`, `Typecheck`, `Test`, `Build` e `Security audit` todos ✓.
  A primeira tentativa desse run e a primeira tentativa do run anterior (commit `e96c5ec`,
  [31407205519](https://github.com/RobersonCodes/Oliveira-DevCloud/actions/runs/31407205519)) haviam
  falhado no `Test`, mas em **conjuntos de arquivos diferentes e não relacionados** a cada tentativa
  (`code-intelligence`/`contract-intelligence` na primeira; `git-engine`/`repository-bootstrap`/
  `workspace-engine` na segunda), sempre com a mesma causa raiz —
  `Error: (HTTP code 500) server error` dentro de `docker-modem` — um erro transitório do daemon
  Docker do runner hospedado, não uma regressão de código: nenhum desses pacotes foi tocado pela
  Fase 1. `gh run rerun --failed` no commit `6c4cbfe` resolveu de primeira, confirmando a hipótese de
  flake de infraestrutura.

---

### Fase 2 — Runtime Gateway e deploy de origem isolada

**Status:** `PARCIAL` — código/config prontos, DNS já propagado, HTTP comprovadamente chega ao nginx
do host; aplicar os server blocks, emitir os certificados e validar em domínio real dependem do
usuário (ver `docs/RUNTIME-GATEWAY-DEPLOY.md`)

**Execução:** Claude → Codex — Etapa 2 reatribuída para conclusão das pendências.

**Já validado em código:** ticket HMAC curto, cookie `__Host-`, membership em tempo real, proteção de
Origin/Fetch Metadata, headers autoritativos, bloqueio do proxy legado em produção e relay HTTP/WS.

**Domínios definidos pelo usuário em 2026-08-10:** painel `app.aifunnelpro.com.br`, runtime
`runtime.tiremax.shop` — sites registráveis distintos, conforme exigido. (Substituem os domínios
provisórios `app.oliveiradevcloud.com`/`runtime.oliveiradevcloud-content.com` definidos mais cedo na
mesma data — ver histórico abaixo.)

**Mudança de topologia (2026-08-10):** a VPS de destino já hospeda outro site (Tiremax) atrás de um
nginx do sistema ocupando 80/443 — não é uma VPS exclusiva como o desenho original assumia. Por isso
`infra/production/docker-compose.prod.yml` não roda nginx próprio nem publica 80/443 por padrão;
`web`/`api` publicam só em `127.0.0.1`, e quem termina TLS/roteia é o nginx já existente no host, com
os server blocks em `infra/production/nginx-devcloud.host.conf.example` (config final) e
`nginx-devcloud.host.bootstrap.conf.example` (config HTTP-only temporária, para quebrar o ciclo de
bootstrap do certificado do painel — ver `docs/RUNTIME-GATEWAY-DEPLOY.md` §2/§4), adicionados ao lado
da config do Tiremax, nunca a substituindo. `infra/production/nginx.prod.conf` (nginx dockerizado)
continua executável para uma eventual VPS exclusiva futura — vive no mesmo compose atrás do profile
`docker compose --profile standalone-nginx`, off por padrão, não ativado nesta implantação. Detalhe
completo: `docs/RUNTIME-GATEWAY-DEPLOY.md`.

**Pendente para concluir:**

- [x] Provisionar um domínio registrável separado para conteúdo de runtime — domínios confirmados
      pelo usuário (ver acima).
- [x] Configurar DNS wildcard para os hosts de workspace/runtime — **feito pelo usuário**, propagação
      confirmada externamente em 2026-08-10 para os três nomes (painel, base do runtime, wildcard).
- [x] Confirmar que HTTP chega ao nginx do host — uma requisição para `app.aifunnelpro.com.br` abriu
      o Tiremax (`default_server`), o que só é possível com a porta 80 alcançável e o nginx
      processando a requisição; não há bloqueio de rede/firewall a resolver, só falta o server block
      dedicado do DevCloud.
- [ ] Aplicar o bootstrap HTTP-only e os server blocks finais do DevCloud ao nginx do host, sem tocar
      na config do Tiremax — arquivos prontos em `infra/production/nginx-devcloud.host.bootstrap.conf.example`
      e `nginx-devcloud.host.conf.example`; aplicação e `nginx -t` real **dependem do usuário** (acesso
      SSH à VPS), `docs/RUNTIME-GATEWAY-DEPLOY.md` §2 e §4.
- [ ] Instalar e testar certificado TLS wildcard — **depende do usuário**, via desafio HTTP-01 webroot
      para o painel (usa o bootstrap acima) e DNS-01 para o wildcard — `docs/RUNTIME-GATEWAY-DEPLOY.md`
      §3.
- [x] Criar server blocks nginx do Runtime Gateway — dois caminhos, ambos executáveis:
      `infra/production/nginx.prod.conf` (nginx dockerizado, serviço `nginx` do compose atrás do
      profile `standalone-nginx`, para uma eventual VPS exclusiva) e
      `infra/production/nginx-devcloud.host.conf.example` +
      `nginx-devcloud.host.bootstrap.conf.example` (nginx do host, usado nesta implantação
      compartilhada) — mesma lógica de fundo: redirect HTTP→HTTPS, server block HTTPS dedicado a
      `*.${RUNTIME_BASE_DOMAIN}`, Host preservado sem reescrita, suporte a WebSocket,
      `X-Forwarded-For`, HSTS. Sintaxe do caminho dockerizado validada com Docker real numa sessão
      anterior (`nginx -t` limpo, envsubst confirmado); o novo arquivo do host validado localmente
      nesta sessão com `nginx -t` contra certificados descartáveis (não contra o `nginx -T` real do
      Tiremax, sem acesso SSH à VPS) — validação real **depende do usuário**.
- [ ] Validar redirect, iframe, assets, preview e WebSocket em domínio real — **depende do usuário**
      (checklist pronta em `docs/RUNTIME-GATEWAY-DEPLOY.md` §7).
- [ ] Confirmar que cookies do control plane nunca são enviados ao site de runtime — desenho já
      garante isso (domínios registráveis distintos + cookies `__Host-`); confirmação por captura de
      rede real listada em `docs/RUNTIME-GATEWAY-DEPLOY.md` §7, **depende do usuário**.
- [x] Documentar emissão/renovação de certificado e recuperação de falha — `docs/RUNTIME-GATEWAY-DEPLOY.md`
      (registros DNS exatos, comandos certbot HTTP-01 webroot/DNS-01, deploy-hook de renovação, tabela
      de recuperação de falha, agora cobrindo também a topologia de VPS compartilhada).

**Critérios de aceite:**

- Um ticket não abre outro workspace, outra porta ou outro propósito. *(já coberto por teste automatizado)*
- Usuário removido da organização perde acesso na requisição seguinte. *(já coberto por teste automatizado)*
- Ataque entre dois subdomínios de runtime recebe 403 em HTTP e WebSocket. *(já coberto por teste automatizado)*
- IDE e preview funcionam integralmente em HTTPS/WSS no domínio real. *(pendente — exige servidor real)*
- O proxy legado retorna 410 em produção. *(já coberto por teste automatizado)*

**Validação mínima:** integração, Playwright em Chromium e teste manual em domínio real.

**Bloqueio conhecido:** DNS já propagou e HTTP já comprovadamente chega ao nginx do host (feito pelo
usuário) — não há bloqueio de rede/firewall pendente. O que falta é só execução no servidor real:
aplicar o bootstrap HTTP-only, emitir os dois certificados, trocar para a config final e validar —
nenhum desses passos pode ser feito a partir desta sessão (sem acesso SSH à VPS). Runbook completo
com os comandos exatos: `docs/RUNTIME-GATEWAY-DEPLOY.md`.

**Evidências:** ver `docs/HARDENING-ROADMAP.md`. Validação local de sessão anterior: `docker run` com
`nginx:1.27-alpine`, certificados autoassinados descartáveis e `--add-host api/web` simulando a rede
do compose — `envsubst` renderiza os domínios corretamente nos dois `server_name`, `nginx -t` passa
sem warnings (corrigida também a diretiva `listen ... http2` depreciada); essa validação cobre a
sintaxe do caminho de VPS exclusiva (`nginx.prod.conf`). Validação local desta sessão para o caminho
de host compartilhado: `nginx -t` do arquivo final
(`nginx-devcloud.host.conf.example`) contra certificados autoassinados descartáveis passa limpo
(inclusive o `map` renomeado para não colidir com um `map` de mesmo nome que o Tiremax possa ter).
Diagnóstico externo do usuário: DNS dos três nomes propagado e confirmado; uma requisição para
`app.aifunnelpro.com.br` abriu o Tiremax — confirma que a porta 80 está alcançável e o nginx do host
está processando a requisição normalmente (ela cai no `default_server` do Tiremax só porque ainda não
existe um `server_name` dedicado ao DevCloud). Porta 22 fechada externamente é intencional neste
servidor, não um sintoma de firewall bloqueando 80/443 — não há mais hipótese de firewall em aberto.
Revalidação independente do Codex após a reatribuição: `.env.production` confirmado ignorado por
`.gitignore:14`; `git diff --check` limpo; compose padrão lista somente
`postgres/migrate/redis/runtime-broker/worker/api/web`, enquanto `--profile standalone-nginx`
acrescenta `nginx`; config renderizada publica exclusivamente
`127.0.0.1:18080→3000` e `127.0.0.1:18081→4000`; `nginx -t` do bootstrap sem certificados e da
config final com certificados descartáveis passaram; `npm.cmd run typecheck` e
`npm.cmd run lint` passaram no monorepo.
Evidência de TLS/validação em domínio real completa fica pendente de execução pelo usuário —
acrescentar aqui quando `docs/RUNTIME-GATEWAY-DEPLOY.md` §7 for concluído.

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

**Status:** `CONCLUÍDA`

**Execução:** Claude — Etapa 3.

**Objetivo:** tornar um serviço interno auditável o único detentor do Docker socket.

**Implementação:**

- [x] Especificar contrato interno mínimo do broker — deliberadamente estreito e específico por
      domínio (não é um passthrough genérico do Docker): `POST /v1/workspaces/:workspaceId/container`
      (criar), `GET /v1/containers/:id` (inspect), `POST .../start`, `POST .../stop`,
      `POST .../restart`, `DELETE /v1/containers/:id` (destroy), `POST /v1/containers/:id/exec`
      (um-tiro, genérico), `WS /v1/containers/:id/exec-tty` (interativo, só para o terminal),
      `POST /v1/maintenance/prune-networks`. Nove endpoints cobrem os 14 pontos de uso real de
      `dockerode` levantados no repositório (ver evidência de pesquisa abaixo).
- [x] Implementar autenticação serviço-a-serviço e autorização por operação — bearer token
      compartilhado (`RUNTIME_BROKER_TOKEN`), comparação em tempo constante
      (`crypto.timingSafeEqual`), validado em todo request via hook `onRequest` (inclusive antes do
      upgrade do WebSocket interativo — testado). "Autorização por operação" é o próprio contrato
      estreito: cada endpoint só permite a operação específica que implementa.
- [x] Criar allowlist de imagens, mounts, redes, portas e capabilities — imagem vem só da própria
      env do broker (`WORKSPACE_IMAGE`), nunca do chamador; caminho de bind é sempre derivado
      internamente de `workspaceId` (nunca aceito como string do cliente); nome de rede idem
      (`odc-ws-net-<workspaceId>`); `CapDrop:['ALL']`, `SecurityOpt:['no-new-privileges:true']` e
      `Privileged` (nunca setado, portanto sempre `false`) são fixos no código do broker — nenhum
      desses campos existe no schema de request aceito pela API.
- [x] Rejeitar modo privilegiado, socket Docker e mounts fora das raízes permitidas — estruturalmente
      impossível pedir (não existe campo no contrato), e testado explicitamente: um payload tentando
      injetar `Privileged`/`CapAdd`/`Binds`/`NetworkMode:'host'` é silenciosamente ignorado.
- [x] Migrar API, worker e engines para o broker — os 14 pontos reais de acesso direto a
      `dockerode` (levantamento tinha só 10 catalogados no roadmap; achei mais 2 —
      `apps/api/src/lib/repositoryBootstrap.ts` e a cópia duplicada em `apps/worker` — e consolidei
      as duas em `packages/repository-bootstrap`, então 12 pontos migrados no total):
      `workspace-engine`, `ide-engine`, `terminal-engine` (o único caso genuinamente interativo —
      usa o WS `exec-tty`), `git-engine`, `setup-engine`, `review-engine`,
      `repository-intelligence`, `code-intelligence`, `contract-intelligence`, `agent-engine`,
      `repository-bootstrap` (novo, consolidado). Todos preservam sua interface pública exata —
      nenhuma rota de `apps/api` precisou mudar.
- [x] Remover `docker.sock` da API e do worker no compose — confirmado via
      `docker compose config`: `docker.sock` só aparece no serviço `runtime-broker`; `api` mantém só
      o bind mount de `WORKSPACE_ROOT_HOST` (necessário para `fs.mkdir`/`fs.chown` antes de pedir a
      criação do container); `worker` não tem nenhum volume.
- [x] Manter a porta do broker apenas em rede interna — serviço `runtime-broker` no compose não tem
      `ports:` nenhuma; só alcançável por outros containers da mesma rede do compose.
- [x] Adicionar audit log sem secrets — `apps/runtime-broker/src/audit.ts`: linhas JSON estruturadas
      em stdout com operação, containerId/workspaceId, `cmd0` (só o binário, ex. "git"/"npm"), exit
      code, duração e sucesso/erro — nunca argumentos completos nem output (um deles,
      `repository-bootstrap`, literalmente carrega um token do GitHub dentro do próprio `Cmd`, por
      isso a decisão de nunca logar `Cmd`/output).
- [x] Testar payloads maliciosos — ver acima (Privileged/CapAdd/Binds/NetworkMode ignorados,
      `user` de exec fora da allowlist rejeitado com 400 antes de tocar o Docker).
- [ ] Testar indisponibilidade do broker — **deliberadamente adiado para a Fase 7**, que já lista
      "testar restart de API, worker, Redis e broker durante operações" no próprio checklist; não é
      uma lacuna escondida desta fase.

**Critérios de aceite:**

- [x] Somente o broker possui o socket Docker — `docker compose config` confirma.
- [x] Nenhum cliente consegue escolher parâmetros Docker arbitrários — contrato estreito por
      construção + teste estrutural.
- [x] API pública comprometida não obtém controle direto do daemon — api/worker não têm mais
      `docker.sock`; só falam com o broker via HTTP/WS autenticado, através de um contrato que não
      aceita `Privileged`/mounts arbitrários/rede arbitrária.
- [x] Operações permitidas continuam funcionando ponta a ponta — suíte completa (189 testes, 24
      arquivos) verde contra Postgres, Redis e Docker reais, incluindo o E2E completo (login →
      projeto → workspace real → terminal real via tmux → comando real → parar workspace) e o
      terminal interativo real (tmux attach de verdade sobre o WebSocket do broker).

**Validação mínima:** testes de contrato, integração Docker, inspeção do compose e teste negativo de
rede/porta.

**Evidências:**

- Levantamento completo dos 14 pontos de acesso direto a `dockerode` no repositório (arquivo, método
  usado, uso de streaming/hijack) feito antes de desenhar o contrato — confirmou que o roadmap
  original catalogava só 10 e detectou os outros 2 (`repositoryBootstrap.ts` duplicado).
- `apps/runtime-broker` (novo serviço) e `packages/runtime-broker-client` (novo cliente
  compartilhado) — contrato completo em `packages/runtime-broker-client/src/contract.ts`.
- `apps/runtime-broker/src/app.test.ts` — 13 testes contra Docker real: auth (sem token, token
  errado), ciclo de vida completo do container de workspace (criar/inspecionar/exec/destruir),
  idempotência de criar/destruir, isolamento cross-workspace (repete a garantia da Fase 3 através do
  broker), clamp de limites de recursos, allowlist de exec, payload malicioso ignorado
  estruturalmente, TTY interativo real (WebSocket), rejeição de handshake WS sem token,
  `prune-networks`.
- Todos os 12 pontos migrados têm teste próprio contra broker real + Docker real (a maioria delas
  criada nesta sessão — a maior parte desses pacotes nunca tinha teste direto antes):
  `packages/workspace-engine/src/index.test.ts` (8), `packages/terminal-engine/src/index.test.ts`
  (4, novo — a sessão tmux interativa de verdade), `packages/git-engine/src/index.test.ts` (5),
  `packages/setup-engine/src/index.test.ts` (2, novo), `packages/review-engine/src/index.test.ts`
  (2, novo), `packages/repository-intelligence/src/index.test.ts` (1, novo),
  `packages/code-intelligence/src/index.test.ts` (1, novo),
  `packages/contract-intelligence/src/index.test.ts` (2, novo),
  `packages/agent-engine/src/index.test.ts` (2, novo — tmux real + CLI `codex`/`claude` falsas),
  `packages/repository-bootstrap/src/index.test.ts` (2, novo — clone git real de um repo bare
  local).
- `apps/api/src/e2e.test.ts` passou de ponta a ponta através do broker real: registro → projeto →
  workspace real (imagem `oliveira-devcloud/workspace-node:1.0`) → sessão de terminal real → comando
  real executado e sua saída real lida via WebSocket → parar workspace.
- **Correção genuína de um teste antes marcado como "pré-existente e não relacionado" na Fase 3**:
  `apps/api/src/ws-security.test.ts` — os dois casos que verificavam "passa auth, falha depois
  resolvendo o container" esperavam `500` porque, sem um broker real alcançável, a chamada
  `fetch()` interna falhava de conexão (erro sem `statusCode`, caindo no `?? 500` do handler de
  erro) — um acidente, não uma verificação real de "container não existe". Agora o teste sobe um
  broker real em `beforeAll` e a asserção foi corrigida para `404` (a resposta real e correta do
  broker para um `containerId` inexistente). `docs/HARDENING-ROADMAP.md` atualizado para refletir
  que isso deixou de ser uma pendência.
- Bug real encontrado e corrigido durante o desenvolvimento: `RuntimeBrokerClient.request()` sempre
  mandava `content-type: application/json` mesmo sem body, e o Fastify rejeitava corpo vazio com
  esse header (`DELETE`/`POST` sem payload quebravam) — corrigido para só mandar o header quando há
  body de verdade.
- Suíte completa do monorepo (`npx vitest run`), contra Postgres real (efêmero), Redis real
  (efêmero) e Docker real (Docker Desktop): **189 de 189 testes passaram, 24 de 24 arquivos** — zero
  falhas, incluindo o `ws-security.test.ts` agora corrigido de verdade. `npm run typecheck`,
  `npm run lint` e `npm run build` limpos no monorepo inteiro. Nenhuma rede/container de teste
  ficou órfão (verificado após cada rodada).
- **Confirmado em CI Linux real após push** (commits `5f35dfa`, `ba8f956`, `00f1a7e`): primeira vez
  no histórico deste projeto em que o job `quality` inteiro do GitHub Actions passa 100% verde —
  `Lint`, `Typecheck`, `Test`, `Build` **e** `Security audit`, todos ✓ (runs
  [31393640561](https://github.com/RobersonCodes/Oliveira-DevCloud/actions/runs/31393640561) e,
  após corrigir um teste sensível à contagem de CPU do runner (4 núcleos — o mesmo tipo de
  constraint que `workspace-engine` já tratava, faltava replicar no teste novo do broker),
  [31394449630](https://github.com/RobersonCodes/Oliveira-DevCloud/actions/runs/31394449630)).
  Nenhuma das 3 suítes Docker antes bloqueadas em CI (`git-engine`, `workspace-engine`, `e2e`)
  segue bloqueada — todas rodam de verdade agora.
- `docker compose --env-file <dummy> -f infra/production/docker-compose.prod.yml config` validado:
  `docker.sock` só no `runtime-broker`; `api` só com o bind mount do workspace root; `worker` sem
  nenhum volume.

---

### Fase 5 — infraestrutura reproduzível e operação em host limpo

**Status:** `PARCIAL` — host Linux limpo, imagem por digest, restart e restore aprovados; falta somente
o smoke autenticado de agente com credencial do próprio usuário e a navegação IDE/TLS dependente da Fase 2.

**Execução:** Codex — Etapa 5 reatribuída pelo usuário após o encerramento dos créditos do Claude.

**Implementação:**

- [x] Auditar Dockerfiles: build multi-stage, usuário não-root e healthchecks.
- [x] Usar instalação determinística de dependências.
- [x] Publicar e versionar imagens de workspace em registry confiável.
- [x] Verificar checksum/assinatura de artefatos como code-server.
- [x] Instalar/versionar CLIs Codex e Claude e isolar falhas de inicialização no worker.
- [x] Incluir Postgres, Redis, broker e dependências reais em readiness.
- [x] Revisar timeouts, limites e headers do nginx/API.
- [x] Documentar instalação limpa, upgrade, rollback e disaster recovery.
- [x] Automatizar migrations antes da API.
- [x] Provar persistência de PostgreSQL, Redis/AOF e bind mount após reinício dos serviços, inclusive
      em runner Linux limpo com workspace real e restore isolado de banco e workspace.

**Critério de aceite:** seguindo somente a documentação, um host limpo consegue configurar, migrar,
subir, criar usuário/projeto/workspace, abrir IDE/terminal, rodar agente, reiniciar e recuperar o
ambiente sem perda.

**Validação mínima:** ensaio completo em VM Linux limpa e registro dos comandos/resultados.

**Evidências:** migration one-shot preservada; P1-6/P1-7/P1-8 fechados no roadmap. `npm ci`,
`typecheck`, `lint`, builds de todos os pacotes e dos quatro apps passaram; as quatro imagens Linux
foram construídas com zero vulnerabilidades no audit, sem alerta OpenSSL do Prisma. Inspeção das
imagens confirmou UID/GID `10001:10001`, comandos e healthchecks. Imports dos quatro runtimes
passaram depois de `npm prune --omit=dev`. A suíte real do Runtime Broker passou `14/14` contra o
Docker Desktop (na primeira tentativa o teste não coletou porque usou `/var/run/docker.sock`;
repetido com `DOCKER_SOCKET=//./pipe/docker_engine`, o caminho correto no Windows). A imagem de workspace
`oliveira-devcloud/workspace-node:1.1.0` foi construída de verdade e validada com UID `10001`,
code-server `4.121.0`, pnpm `11.21.0`, Node `22`, Python `3.11` e Java `17`; após instalar as CLIs,
o digest local passou a
`sha256:35468c9c4f2de8536ab1b33a609935a24f0c357e7a004fa9aca88e797a85d53c`. O download do
code-server agora valida SHA-256 por arquitetura e o build falha em divergência. O workflow
`.github/workflows/workspace-image.yml` publicou a tag `workspace-node-v1.1.0` no GHCR com provenance
e SBOM no run `31445506653`. O índice OCI
`sha256:90bacb592d8278bd7ee91f023220428663fa7087497807806e871004b2377a4a` foi inspecionado e puxado
por digest neste Docker host; um container descartável confirmou UID/GID `10001:10001` e todas as
versões da toolchain. Depois, o run Linux limpo `31525879533` repetiu o pull por digest e percorreu
Compose, migrations, readiness, usuário/projeto/workspace/terminal, restart, persistência e restore
isolado, fechando P1-9. Instalação limpa, upgrade,
rollback, backup/restore, persistência e desastre foram consolidados em
`docs/PRODUCTION-OPERATIONS.md`; o ensaio automatizável do runbook agora está coberto por
`.github/workflows/production-smoke.yml`.
Validação documental desta atualização: todos os links locais dos cinco documentos ativos passaram,
`git diff --check` ficou limpo e `docker-compose --env-file .env.production.example -f
infra/production/docker-compose.prod.yml config --quiet` terminou com código zero. O plugin local
`docker compose` não está disponível neste terminal Windows (a primeira tentativa foi rejeitada por
esse motivo); o binário legado `docker-compose` validou o mesmo arquivo. O host de produção continua
exigindo Compose v2, como declarado no runbook.

P1-10 também foi fechado nesta sessão: `infra/workspace-images/node/package.json` e seu lockfile
fixam Codex CLI `0.147.0`, Claude Code `2.1.226` e pnpm `11.21.0`; a imagem real, como UID `10001`,
executou `codex --version`/`claude --version`; `npm audit --omit=dev --audit-level=high` retornou zero
vulnerabilidades. A inspeção do help revelou e evitou um defeito de compatibilidade: `--full-auto`
foi removido do Codex atual e o engine agora usa `workspace-write` + aprovação `never`, combinação
presente na CLI e coberta pelo teste. Typecheck do agent-engine/worker/broker passou, a suíte real
broker+Docker+tmux passou `2/2`, e as imagens de worker e broker foram reconstruídas com audit zero.
Não houve autenticação nem chamada a provedor nesta validação; o smoke autenticado continua
pendente por credencial externa e mantém a Fase 5 `PARCIAL`.

P2-1 e P2-4 foram fechados nesta sessão. A API agora declara `bodyLimit=1 MiB`,
`requestTimeout=30s` e `keepAliveTimeout=72s`; uma regressão confirma as opções efetivas e resposta
413 acima do limite. Os dois nginx de produção alinham o painel em `client_max_body_size 1m`, limitam
recebimento de headers/body, conexão e envio ao upstream, preservam 3600s somente porque `/api/`
transporta WS/SSE, e aplicam uma política autoritativa de CSP/HSTS/Referrer/Permissions/nosniff/
frame/COOP/CORP. O runtime mantém limite nginx de 25 MiB e headers autoritativos da API. Validação:
`apps/api/src/http-boundary.test.ts` 4/4; typecheck completo, build da API, lint e `git diff --check`
limpos; `nginx -t` real passou tanto para a config do host quanto para o template standalone em
`nginx:1.27-alpine`, com envsubst e certificados descartáveis.

O pré-ensaio de persistência também passou no Docker Desktop com projeto Compose isolado
`odc-persistence-test`: builds reais (audit zero), migrations, stack saudável, usuário/organização/
projeto preservados no PostgreSQL depois de reiniciar os seis serviços, chave preservada pelo AOF do
Redis e arquivo do bind mount preservado com SHA-256
`E05D57263E46C692957995484F398C7F05E75C837EA96E129C0D3F6734C2BFEF`. A tentativa inicial de
usar o fluxo autenticado por HTTP loopback foi corretamente bloqueada pelo cookie de produção
`__Host-...; Secure`; a fixture foi então criada/consultada via Prisma dentro da API, sem enfraquecer
o cookie. Ao final, todos os recursos do projeto descartável foram removidos. Limitação registrada:
naquele momento não era VM Linux limpa, o arquivo não vinha de workspace real e backup/restore e
agente autenticado não haviam sido exercitados. O run Linux `31525879533` supriu as três primeiras
lacunas; somente a execução autenticada de agente continua externa.

---

### Fase 6 — identidade, sessão e fronteiras de confiança

**Status:** `EM ANDAMENTO`

**Execução:** Codex — Etapa 6.

**Implementação:**

- [x] Restringir `trustProxy` aos proxies/redes reais.
- [x] Falhar o boot de produção se origins, secrets ou flags seguras estiverem ausentes.
- [x] Aplicar rate limit por usuário/organização e por IP onde fizer sentido.
- [x] Revisar RBAC HTTP e WebSocket rota por rota.
- [ ] Adicionar gerenciamento e revogação de sessões/dispositivos.
- [ ] Planejar recuperação de conta, verificação de e-mail e MFA/passkeys.
- [ ] Revisar logs de auditoria para ações administrativas e de agentes.
- [ ] Executar nova revisão cross-tenant após as mudanças.

**Critérios de aceite:** cabeçalhos de proxy não são confiados de fontes arbitrárias; configuração
insegura não inicia em produção; revogação de acesso tem efeito imediato; rotas equivalentes usam a
mesma autorização.

**Validação mínima:** matriz automatizada anônimo/membro/developer/admin/owner/host-admin e testes de
sessão expirada/revogada/cross-org.

**Evidências:** proteção de métricas, Origin WS e parte do RBAC já registradas no roadmap. P1-1 foi
fechado no commit `30e5490`: `apps/api/src/lib/trustedProxy.ts` transforma
`TRUSTED_PROXY_CIDRS` numa allowlist explícita de endereços/CIDRs IPv4/IPv6 e desabilita confiança
em proxy quando vazia; `buildApp()` permite override somente para testes. A regressão
`apps/api/src/trusted-proxy.test.ts` cobre configuração vazia/inválida, conexão direta com
`X-Forwarded-*` forjado, peer confiável e cadeia com salto intermediário não confiável (**10/10**
localmente em 2026-08-12). O runbook descobre o gateway da rede Compose e fixa somente seu `/32`;
o smoke Linux [31528431019](https://github.com/RobersonCodes/Oliveira-DevCloud/actions/runs/31528431019)
confirmou o IP encaminhado no `AuditLog`. O CI Linux
[31528430998](https://github.com/RobersonCodes/Oliveira-DevCloud/actions/runs/31528430998) aprovou
lint, typecheck, testes, build e audit. Revalidação local: `npm run typecheck`, `npm run lint` e
`npm run build -w @oliveira/api`, todos com exit 0.

P1-2/P1-3 foram fechados em 2026-08-12 por `apps/api/src/lib/productionConfig.ts`, chamado antes da
criação do Fastify. A imagem fixa `SECURE_CONFIG_REQUIRED=true`; nesse modo, o boot rejeita
`NODE_ENV` diferente de produção, origem sem HTTPS ou com path/credenciais, host do painel
divergente, domínio de runtime local/malformado, placeholders, segredos de ticket/broker menores
que 32 bytes, chave mestra que não decodifica em 32 bytes, URLs obrigatórias inválidas, proxy vazio
ou universal e TTL de sessão fora de 1–30 dias. Os erros listam somente nomes de variáveis, nunca os
valores. `productionConfig.test.ts` cobre inclusive a chamada real de `buildApp()` (**32/32**), e
`auth.test.ts` confirma o cookie `__Host-`, `Secure`, `Path=/`, sem `Domain` (**3/3**). Somados aos
10 testes de proxy, foram **45/45** direcionados. Typecheck do monorepo, lint, build da API,
`git diff --check` e `docker-compose ... config --quiet` passaram. Localmente, a suíte completa do
Runtime Gateway não rodou por falta de `DATABASE_URL`/PostgreSQL e Docker Desktop parado; a
validação integral foi suprida pelo CI Linux `31620694690` (migrations, lint, typecheck, testes,
build e audit verdes) e pelo smoke de host limpo `31620699908`, ambos no commit `c593287`.

O rate limit em camadas foi implementado em `apps/api/src/lib/rateLimits.ts`: orçamento global de
`120/min` por IP confiável, `120/min` por usuário autenticado e `600/min` agregado por organização;
cadastro/login preservam `5/min` e `8/min` por IP. `requireUser` e `requireOrgRole` aplicam as duas
camadas de identidade, deduplicadas por requisição, inclusive para preHandlers WebSocket. Produção
usa o Redis já obrigatório à stack; desenvolvimento/testes usam store local. Health/readiness ficam
fora do limite. `rate-limits.test.ts`: **6/6** (IP, probes, auth estrito, usuário cross-IP/org,
organização multiusuário, dedupe e resposta `429`/`Retry-After`); conjunto direcionado com proxy,
boot e cookie: **51/51**. `npm run typecheck`, `npm run lint` e build da API passaram. O CI Linux
`31625939507` tentativa 2 aprovou imagem, lint, typecheck, testes, build e audit; a tentativa 1 havia
parado antes das validações por resposta HTTP 503 transitória do GitHub Releases.

A revisão RBAC inventariou todas as rotas em `docs/RBAC-MATRIX.md` e centralizou a decisão pura em
`canAccess`. A matriz de 30 combinações cobre anônimo, membro externo, developer, admin, owner e
host-admin contra políticas autenticada/developer/admin/owner/host-admin. O Runtime Gateway passou
a consumir também os orçamentos de usuário/organização depois de revalidar membership, e
merge/rejeição direta de agentes foi alinhada à revisão de orquestrações em `ADMIN`. Testes locais
sem infraestrutura: **10/10** (`auth.test.ts` + `rate-limits.test.ts`); typecheck, lint, build API e
`git diff --check`: exit 0. No commit `e365017`, os CIs Linux `31628756365` e `31628759439`
aprovaram migrations, matriz HTTP real em PostgreSQL, regressões WS, lint, typecheck, testes, build e
audit; o smoke de host limpo `31628759486` também passou.

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
| 2026-08-10 | Claude | Fase 4 (Etapa 3) | `CONCLUÍDA` | Runtime Broker implementado do zero: `apps/runtime-broker` (novo serviço, único detentor de `docker.sock`) + `packages/runtime-broker-client` (cliente compartilhado). Levantamento prévio achou 14 pontos reais de acesso a `dockerode` (roadmap catalogava só 10) — os 12 pontos únicos (2 eram duplicatas, consolidadas em `packages/repository-bootstrap`) migrados: `workspace-engine`, `ide-engine`, `terminal-engine` (WS interativo real), `git-engine`, `setup-engine`, `review-engine`, `repository-intelligence`, `code-intelligence`, `contract-intelligence`, `agent-engine`, `repository-bootstrap`. Contrato do broker deliberadamente estreito (não é passthrough genérico do Docker) — imagem/bind/rede sempre derivados internamente, nunca aceitos do chamador; `Privileged`/`CapAdd` nem existem no schema. `docker-compose.prod.yml`: novo serviço `runtime-broker` com `docker.sock`; `docker.sock` removido de `api`/`worker` (confirmado via `docker compose config`). Validação: 13 testes de contrato do broker + teste próprio (novo, contra broker+Docker reais) para cada um dos 12 pontos migrados + `apps/api/src/e2e.test.ts` passando de ponta a ponta pelo broker real + correção genuína de `ws-security.test.ts` (as 2 falhas "pré-existentes" da Fase 3 eram, na real, um broker inalcançável mascarado de 500 — agora sobe um broker real e espera o 404 correto). Suíte completa: **189/189 testes, 24/24 arquivos, zero falhas**; `typecheck`/`lint`/`build` limpos no monorepo inteiro. Bug real encontrado e corrigido: `RuntimeBrokerClient` mandava `content-type` mesmo sem body, quebrando `DELETE`/`POST` vazios. P1-5 do roadmap fechado | Etapa 4: cliente HTTP/WS centralizado do frontend (Fase 1) |
| 2026-08-10 | Claude | Fase 1 (Etapa 4) | `CONCLUÍDA` | `apps/web/lib/apiClient.ts` novo (HTTP/WS/SSE centralizados, redirect automático em `401` exceto rotas de auth); `apps/web/next.config.js` novo (rewrite dev-only para a API); 14 páginas migradas, `NEXT_PUBLIC_API_URL` removido do bundle/Dockerfile/compose/env examples. Validação com Postgres/Redis/Docker reais nesta sessão via `next dev` (porta 3001) proxiando para a API real (porta 4000): HTTP GET/POST/JSON/cookie confirmado; pilha completa Fase 1→Fase 4→Docker real criando organização/projeto/workspace reais; WebSocket de terminal confirmado com I/O bidirecional real (comando `echo` executado no tmux do container e ecoado de volta) através do proxy; SSE de `setup jobs` confirmado com múltiplos eventos reais em stream através do proxy. `typecheck`/`lint`/`build web` limpos; zero `localhost:4000` no build de produção. P1-13 do roadmap fechado. Achado durante a validação (fora do escopo desta fase, não corrigido): bug pré-existente no handler WS de terminal do backend (`apps/api/src/routes/terminals.ts:102-117`) — `Buffer.isBuffer(raw)` é sempre verdadeiro para mensagens da lib `ws` (texto ou binário), então o protocolo JSON `{type:'input'\|'resize'}` nunca é interpretado e cada tecla digitada escreve o envelope JSON literal no pty; registrado como `P1-18` no roadmap; commit `4de57d6` | Etapa 5: infraestrutura reproduzível em host limpo (Fase 5) |
| 2026-08-10 | Claude | Fase 2 (Etapa 2) | `PARCIAL` | Usuário trocou os domínios reais de `app.oliveiradevcloud.com`/`runtime.oliveiradevcloud-content.com` para `app.aifunnelpro.com.br`/`runtime.tiremax.shop` (DNS dos três nomes já propagado e confirmado externamente) e revelou que a VPS de destino é compartilhada com outro site (Tiremax) já ocupando 80/443 com nginx próprio — mudança de topologia da Fase 2. Sem acesso SSH à VPS nesta sessão (tentativa de conexão deu timeout na porta 22, nenhuma chave privada disponível localmente), então nenhuma mudança foi aplicada no servidor; todo o trabalho foi preparação de config/documentação. Revisão do usuário corrigiu 4 achados antes do commit: (1) ciclo de bootstrap TLS — a config final referenciava certificados inexistentes, o que quebraria `nginx -t` antes mesmo do desafio HTTP-01 do painel conseguir rodar; resolvido com um arquivo bootstrap novo, só HTTP, sem nenhuma referência a certificado (`nginx-devcloud.host.bootstrap.conf.example`), aplicado primeiro, trocado pela config final só depois dos dois certificados emitidos, nunca os dois ativos ao mesmo tempo; (2) a hipótese de bloqueio por firewall (Hostinger/hPanel) estava errada e foi removida do plano/roadmap/runbook — Drop é política implícita padrão da Hostinger (não uma regra extra causando conflito), a porta 22 fechada é intencional, e uma requisição para `app.aifunnelpro.com.br` abriu o Tiremax, o que prova que HTTP já chega ao nginx do host; o bloqueio real sempre foi só a ausência dos server blocks/certificados/deploy; (3) `infra/production/nginx.prod.conf` deixou de ser config morta — o serviço `nginx` do compose voltou, agora atrás de um profile (`docker compose --profile standalone-nginx`, off por padrão), preservando um caminho executável para uma eventual VPS exclusiva; (4) `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for` adicionado aos blocos de API e runtime em ambos os arquivos de nginx, com nota ligando à restrição de `trustProxy` já planejada para a Fase 6/Etapa 6 (P1-1). Resultado: `infra/production/docker-compose.prod.yml` não roda nginx próprio nem publica 80/443 por padrão (`web`/`api` só em `127.0.0.1:${DEVCLOUD_WEB_HOST_PORT:-18080}`/`127.0.0.1:${DEVCLOUD_API_HOST_PORT:-18081}`); `docs/RUNTIME-GATEWAY-DEPLOY.md` reescrito (sem a seção de firewall, com o bootstrap em duas fases); `.env.production(.example)`, `docs/ARCHITECTURE.md` e `docs/HARDENING-ROADMAP.md` atualizados. `git diff --check`, `docker compose config` e `nginx -t` (bootstrap sem certificados e config final com certificados descartáveis) todos limpos. Nenhum arquivo commitado ainda nesta entrada | Usuário aplica o bootstrap, emite os dois certificados, troca para a config final no nginx do host (`docs/RUNTIME-GATEWAY-DEPLOY.md` §2-4) e roda a checklist de validação (§7); Claude não aplica nada no servidor sem acesso SSH |
| 2026-08-10 | Codex | Reatribuição das Etapas 2 e 5 | `EM ANDAMENTO` | Usuário autorizou explicitamente o Codex a assumir as partes pendentes das Etapas 2 e 5 após o encerramento dos créditos do Claude, preservando o diff não commitado e todas as entregas anteriores | Revisar e validar o diff da Etapa 2; obter acesso SSH restrito e executar o deploy real sem afetar o Tiremax |
| 2026-08-10 | Codex | Fase 2 (Etapa 2) — revisão local | `PARCIAL` | Diff do Claude preservado e revisado; reatribuição registrada; `.env.production` ignorado; `git diff --check` limpo; compose padrão sem nginx e profile `standalone-nginx` funcional; web/API somente em `127.0.0.1:18080/18081`; `nginx -t` limpo para bootstrap e config final; typecheck e lint limpos; preparação commitada em `875fa15` | Liberar SSH somente para `186.219.142.107/32`, autenticar por chave e executar o runbook no VPS com backup/`nginx -t` antes de cada reload |
| 2026-08-10 | Codex | Fase 5 (Etapa 5) — imagens, agentes e documentação | `EM ANDAMENTO` | Quatro imagens de serviço multi-stage/non-root; readiness real; workspace `1.1.0` com checksum do code-server e toolchain validada; Codex `0.147.0`/Claude `2.1.226` instalados por lockfile, audit zero e versões executadas como UID 10001; flags atuais do Codex corrigidas e cobertas; falha de startup do agente não é mais relançada pelo worker; teste real broker+Docker+tmux `2/2`; worker/broker reconstruídos; README, arquitetura, roadmap e runbook sincronizados; implementação registrada no commit `f4db862`. Publicação GHCR, execução autenticada e ensaio completo em VM Linux ainda não executados | Revisar timeouts, limites de corpo e headers nginx/API (P2-1/P2-4) |
| 2026-08-10 | Codex | Fase 5 (Etapa 5) — fronteira HTTP | `EM ANDAMENTO` | P2-1/P2-4 corrigidos no commit `d0cb2f9`: Fastify com limite explícito de 1 MiB e timeouts de recebimento/keep-alive; nginx do painel alinhado, timeouts cliente/upstream explícitos e headers autoritativos consolidados; Runtime Gateway preserva política separada. Regressão 4/4, typecheck completo, build API, lint, `git diff --check` e `nginx -t` real nos dois caminhos aprovados | Executar ensaio de persistência após reinício da stack, sem remover volumes |
| 2026-08-10 | Codex | Fase 5 (Etapa 5) — pré-ensaio de persistência | `EM ANDAMENTO` | Evidência registrada no commit `af881c3`: projeto Compose isolado reconstruído e saudável; migrations aprovadas; PostgreSQL preservou usuário/organização/projeto após restart dos seis serviços; Redis/AOF preservou chave após restart; bind mount preservou arquivo e SHA-256 `E05D5726…BFEF`; 7 containers, 2 volumes, 1 rede e diretório temporário removidos ao final. Ensaio integral em VM Linux, restore e agente autenticado não executados | Publicar workspace `1.1.0` no GHCR por push/tag aprovado e validar pull por digest em host limpo |
| 2026-08-11 | Codex | Fase 5 (Etapa 5) — publicação GHCR | `EM ANDAMENTO` | Tag remota `workspace-node-v1.1.0` confirmada no commit `59b7711`; workflow `Publish workspace image` run `31445506653` aprovado, com SBOM/proveniência; índice OCI `sha256:90bacb592d8278bd7ee91f023220428663fa7087497807806e871004b2377a4a` publicado para `linux/amd64`; pull por digest aprovado neste Docker host e container descartável confirmou UID/GID `10001:10001`, code-server `4.121.0`, pnpm `11.21.0`, Codex `0.147.0`, Claude `2.1.226`, Node `22.23.2`, Python `3.11.2` e Java `17.0.20`; `git diff --check` e `docker-compose ... config --quiet` aprovados. O host atual não é uma VM Linux limpa; restore e agente autenticado não foram executados | Provisionar VM Linux x86_64 limpa e executar integralmente `docs/PRODUCTION-OPERATIONS.md`, inclusive smoke, restart, backup/restore e agente autenticado |
| 2026-08-11 | Codex | Fase 5 (Etapa 5) — sincronização do README | `EM ANDAMENTO` | README atualizado para registrar a publicação GHCR, o digest imutável e a separação entre build local de desenvolvimento e imagem de produção; `.env.example` alinhado à imagem local `1.1.0`, eliminando a divergência que faria o quickstart construir `1.1.0` e tentar executar `1.0`; `git diff --check` aprovado | Provisionar VM Linux x86_64 limpa e executar integralmente `docs/PRODUCTION-OPERATIONS.md`, inclusive smoke, restart, backup/restore e agente autenticado |
| 2026-08-11 | Codex | Fase 5 (Etapa 5) — smoke Linux limpo | `PARCIAL` | CI recuperado no commit `5bdd7d8`: runs `31524472703`/`31524467564` inteiramente verdes após corrigir falso negativo de `code-server --version`. Workflow/script do commit `20df932` aprovados no run `31525879533` em `ubuntu-latest`: pull GHCR por digest, Compose, migrations, readiness, usuário/projeto/workspace/terminal, UID 10001, restart, PostgreSQL, Redis/AOF e bind persistentes, dump/tar com checksums e restore isolado de banco/workspace; cleanup e artefato sanitizado aprovados. P1-9 fechado. Sem secrets de provedor no repositório, o agente autenticado não foi simulado. Decisão: avançar a Fase 6, independente dos bloqueios externos das Fases 2/5, conforme permitido pelo plano | Restringir `trustProxy` e cobrir proxy confiável versus header direto por regressão |
| 2026-08-12 | Codex | Fase 6 (Etapa 6) — fronteira de proxy confiável | `EM ANDAMENTO` | P1-1 fechado pelo commit `30e5490`: `trustProxy:true` removido; allowlist `TRUSTED_PROXY_CIDRS` validada e vazia por padrão; configuração/runbook/nginx/smoke alinhados ao `/32` exato do gateway Compose. Regressão local `npx vitest run apps/api/src/trusted-proxy.test.ts`: 10/10; `npm run typecheck`, `npm run lint` e `npm run build -w @oliveira/api`: exit 0. CI Linux `31528430998` aprovou lint/typecheck/test/build/audit; smoke Linux limpo `31528431019` aprovou e confirmou o IP encaminhado no `AuditLog`. Sem nova mudança arquitetural nesta retomada: `docs/ARCHITECTURE.md` já foi atualizado no próprio commit | Fazer o boot de produção falhar sem origins, secrets e flags seguras obrigatórias (P1-2/P1-3) |
| 2026-08-12 | Codex | Fase 6 (Etapa 6) — boot seguro de produção | `EM ANDAMENTO` | P1-2/P1-3 corrigidos no commit `c593287`: validação central fail-closed antes do Fastify; `SECURE_CONFIG_REQUIRED=true` fixado na imagem/API e documentado; origins, hosts, domínio de runtime, secrets, endpoints, proxy e TTL validados sem vazar valores. Testes direcionados `productionConfig` + `trusted-proxy` + `auth`: 45/45; typecheck, lint, build API, `git diff --check` e Compose config: exit 0. Localmente, `runtimeGateway.test.ts` não chegou às asserções por ausência de `DATABASE_URL`/PostgreSQL e Docker Desktop parado; CI Linux `31620694690` supriu a limitação (migrations/lint/typecheck/test/build/audit verdes), e smoke limpo `31620699908` aprovou a stack integral e evidência sanitizada | Aplicar rate limit por usuário/organização e por IP, preservando limites estritos de autenticação |
| 2026-08-12 | Codex | Fase 6 (Etapa 6) — rate limit por identidade | `EM ANDAMENTO` | Três camadas implementadas: IP confiável 120/min, usuário 120/min e organização 600/min; cadastro/login preservam 5/min e 8/min; contadores de produção compartilhados no Redis; probes excluídos; verificações repetidas deduplicadas. `rate-limits.test.ts`: 6/6; conjunto direcionado: 51/51; typecheck, lint e build API aprovados. CI Linux/Redis real pendente | Revisar RBAC HTTP/WS rota por rota e automatizar a matriz completa de papéis |
| 2026-08-12 | Codex | Fase 6 (Etapa 6) — evidência CI do rate limit | `EM ANDAMENTO` | Commit `af17d82`; CI Linux `31625939507` tentativa 2 aprovou imagem, lint, typecheck, testes, build e audit. Tentativa 1 classificada como falha externa: quatro respostas HTTP 503 do GitHub Releases ao baixar code-server, antes de lint/testes; rerun sem mudança passou | Concluir a revisão RBAC e validar a matriz real no CI |
| 2026-08-12 | Codex | Fase 6 (Etapa 6) — revisão RBAC HTTP/WS | `EM ANDAMENTO` | Inventário completo criado em `docs/RBAC-MATRIX.md`; decisão central cobre 30 combinações de atores/políticas; HTTP/WS de runtime permanece em `DEVELOPER`; Runtime Gateway agora também cobra rate limit de identidade; merge/rejeição direta de agentes alinhada a orquestrações em `ADMIN`. Local: 10/10 testes sem infraestrutura, typecheck, lint, build API e diff-check verdes. Matriz HTTP real adicionada, pendente de CI/PostgreSQL | Validar no CI Linux/PostgreSQL a matriz RBAC e as regressões WS |
| 2026-08-12 | Codex | Fase 6 (Etapa 6) — evidência CI da revisão RBAC | `EM ANDAMENTO` | Commit `e365017`; CIs Linux `31628756365`/`31628759439` aprovaram migrations, matriz HTTP real em PostgreSQL, regressões WS, lint, typecheck, testes, build e audit. Smoke de host limpo `31628759486` aprovado. P1-4 fechado e checklist RBAC concluído | Adicionar listagem e revogação de sessões/dispositivos com regressões de expiração/revogação |

### Modelo para futuras entradas

```md
| AAAA-MM-DD | Codex/Claude/pessoa | Fase N | PARCIAL/CONCLUÍDA/BLOQUEADA |
`comando`: resultado; arquivos/testes | ação única seguinte |
```

## 10. Prompt de retomada

### Para Claude — etapas 1, 3 e 4 concluídas

> Leia integralmente `CLAUDE.md`, `docs/PROJECT-COMPLETION-PLAN.md` e
> `docs/HARDENING-ROADMAP.md`. Preserve as Etapas 1, 3 e 4 já concluídas. As pendências das Etapas 2
> e 5 foram reatribuídas ao Codex pelo usuário em 2026-08-10; não retome essas pendências sem nova
> autorização explícita e coordenação de worktree.

### Para Codex — pendências das etapas 2 e 5, depois etapas 6–10

> Leia integralmente `AGENTS.md`, `docs/PROJECT-COMPLETION-PLAN.md` e
> `docs/HARDENING-ROADMAP.md`. Preserve o trabalho válido do Claude nas Etapas 1–4. Conclua as
> pendências reatribuídas das Etapas 2 e 5, faça o handoff interno e depois prossiga com as Etapas
> 6–10. Mantenha o plano atualizado, registre todas as validações e não marque uma etapa como
> concluída sem atender integralmente aos critérios de aceite.
