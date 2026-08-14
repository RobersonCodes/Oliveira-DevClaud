# Operação de produção — Oliveira DevCloud

> Runbook da Fase 5 para implantação em host Linux único. O deploy real da VPS compartilhada também
> exige o procedimento de DNS, TLS e nginx em `docs/RUNTIME-GATEWAY-DEPLOY.md`.

## 1. Pré-requisitos

- Linux x86_64 com Docker Engine e Docker Compose v2;
- Git e acesso de leitura ao repositório;
- diretório persistente `/var/lib/oliveira-devcloud/workspaces`;
- nginx do host, Certbot e os domínios definidos no runbook do Runtime Gateway;
- espaço para PostgreSQL, imagens Docker, workspaces e backups fora do próprio host.

O nginx existente na VPS continua sendo o único processo público em 80/443. A stack publica web e
API somente em `127.0.0.1:18080` e `127.0.0.1:18081` por padrão.

## 2. Instalação limpa

Na raiz de um clone autenticado e fixado no commit/tag aprovado:

```bash
cp .env.production.example .env.production
chmod 600 .env.production
```

Preencha os placeholders, deixando somente `TRUSTED_PROXY_CIDRS` para o passo de descoberta abaixo.
Gere chaves aleatórias fora do histórico do shell sempre que possível e nunca envie
`.env.production`, certificados ou backups ao Git. Descubra o grupo numérico do socket e prepare o
diretório persistente:

A imagem da API fixa `SECURE_CONFIG_REQUIRED=true`. Antes de abrir a porta, ela aborta o boot se
`NODE_ENV` não for `production`, se `WEB_ORIGIN` não for uma origem HTTPS exata coerente com
`DEV_CLOUD_HOST`, se o domínio de runtime for local/malformado, se as chaves obrigatórias forem
ausentes/fracas, se endpoints/TTL estiverem inválidos ou se a allowlist de proxy estiver vazia ou
confiar em toda a internet. Não desative essa flag para contornar um erro: corrija a variável que o
erro identifica; valores de secrets nunca são impressos.

```bash
stat -c '%g' /var/run/docker.sock
sudo install -d -o 10001 -g 10001 -m 0750 /var/lib/oliveira-devcloud/workspaces
```

Os limites padrão por workspace são 1 CPU, 2 GiB de memória, 512 processos, 10 GiB de disco e 480
minutos por sessão de runtime. A API aceita valores dentro dos intervalos validados pelo contrato;
CPU, memória e PIDs são impostos pelo Docker, enquanto o worker precisa montar
`WORKSPACE_ROOT_HOST` como somente leitura para medir o bind mount real e aplicar quota de disco e
duração. Não remova esse mount do worker: sem leitura do diretório, a fiscalização falha fechada e o
workspace é interrompido.

Copie o GID retornado para `DOCKER_GID`. A imagem `workspace-node-v1.1.0` foi publicada no GHCR pelo
workflow [31445506653](https://github.com/RobersonCodes/Oliveira-DevCloud/actions/runs/31445506653).
Produção deve usar o digest imutável já configurado em `.env.production.example`:

```bash
docker pull \
  ghcr.io/robersoncodes/oliveira-devcloud-workspace-node@sha256:90bacb592d8278bd7ee91f023220428663fa7087497807806e871004b2377a4a
```

Antes do primeiro `up`, materialize somente a rede privada e descubra o endereço exato pelo qual o
nginx do host chegará à API. Substitua `replace-with-compose-network-gateway/32` em
`TRUSTED_PROXY_CIDRS` pelo resultado final abaixo; não use uma faixa privada ampla:

```bash
docker compose --env-file .env.production \
  -f infra/production/docker-compose.prod.yml create postgres redis
postgres_id="$(docker compose --env-file .env.production \
  -f infra/production/docker-compose.prod.yml ps -q postgres)"
compose_project="$(docker inspect "$postgres_id" \
  --format '{{ index .Config.Labels "com.docker.compose.project" }}')"
network_id="$(docker network ls \
  --filter "label=com.docker.compose.project=$compose_project" \
  --filter 'label=com.docker.compose.network=default' -q)"
docker network inspect "$network_id" \
  --format '{{(index .IPAM.Config 0).Gateway}}/32'
```

Com essa allowlist, `X-Forwarded-For`, host e protocolo encaminhados só são aceitos do gateway real.
Conexões diretas de outros containers ignoram esses headers, mesmo que tentem falsificá-los.

O Dockerfile baixa o artefato oficial do code-server `4.121.0` e rejeita o build se o SHA-256 não
corresponder ao valor fixado. O mesmo build instala, pelo lockfile, pnpm `11.21.0`, Codex CLI
`0.147.0` e Claude Code `2.1.226`. A tag legível
`ghcr.io/robersoncodes/oliveira-devcloud-workspace-node:1.1.0` aponta para esse mesmo índice OCI,
mas não deve substituir o digest no ambiente de produção. O build local abaixo fica reservado para
desenvolvimento ou recuperação quando o registry estiver indisponível:

```bash
docker build --pull \
  -t oliveira-devcloud/workspace-node:1.1.0 \
  infra/workspace-images/node
```

Valide a configuração antes de iniciar:

```bash
docker compose --env-file .env.production \
  -f infra/production/docker-compose.prod.yml config

docker compose --env-file .env.production \
  -f infra/production/docker-compose.prod.yml build
```

Inicie a stack. O job `migrate` espera o PostgreSQL ficar saudável, aplica
`prisma migrate deploy` uma única vez e precisa terminar com código zero antes de API e worker
subirem:

```bash
docker compose --env-file .env.production \
  -f infra/production/docker-compose.prod.yml up -d

docker compose --env-file .env.production \
  -f infra/production/docker-compose.prod.yml ps

docker compose --env-file .env.production \
  -f infra/production/docker-compose.prod.yml logs migrate api runtime-broker
```

Confirme que web/API estão apenas em loopback, que o broker está saudável e que somente ele possui
o socket:

```bash
sudo ss -lntp | grep -E ':(18080|18081)\b'
curl --fail http://127.0.0.1:18081/health
curl --fail http://127.0.0.1:18081/ready
docker inspect "$(docker compose --env-file .env.production \
  -f infra/production/docker-compose.prod.yml ps -q api)" --format '{{json .Mounts}}'
docker inspect "$(docker compose --env-file .env.production \
  -f infra/production/docker-compose.prod.yml ps -q runtime-broker)" --format '{{json .Mounts}}'
```

Finalize o nginx/TLS pelo runbook do Runtime Gateway e só então execute o smoke test público.

## 3. Autenticação das CLIs de agente

Nenhuma credencial é gravada na imagem. Abra o terminal do workspace como o usuário `devcloud` e
faça login antes da primeira execução:

```bash
codex login
claude auth login
```

O Codex também oferece login no primeiro `codex`; Claude permite escolher a conta/provedor no fluxo
de autenticação. Consulte a [documentação oficial do Codex CLI](https://learn.chatgpt.com/docs/codex/cli)
e a [documentação oficial do Claude Code](https://code.claude.com/docs/en/getting-started).

Não copie tokens entre organizações, não os inclua em `.env.production` e não salve saídas de login
nas evidências. Um workspace novo pode exigir nova autenticação; isso é preferível a compartilhar
credenciais globalmente entre tenants.

## 4. Smoke test funcional

No painel HTTPS, valide nesta ordem:

1. criar o primeiro usuário e uma organização;
2. importar ou criar um projeto;
3. iniciar um workspace e confirmar o container como non-root;
4. abrir IDE e terminal pelo domínio de runtime;
5. criar um arquivo persistente no workspace;
6. executar um agente somente depois de configurar a credencial do provedor;
7. revisar o diff e encerrar o workspace.

Não registre tokens, cookies, chaves ou conteúdo de `.env.production` nas evidências.

## 5. Upgrade

1. Faça backup e valide o arquivo gerado conforme a Seção 7.
2. Registre o commit/tag e as imagens atualmente em execução.
3. Obtenha a nova versão sem alterar `.env.production`.
4. Leia migrations e notas de release antes de subir.
5. Construa ou baixe as imagens com tags imutáveis; nunca dependa apenas de `latest`.
6. Execute `docker compose config`, `build`/`pull` e depois `up -d`.
7. Confirme o job `migrate`, readiness, logs e o smoke test.

```bash
git rev-parse HEAD
docker compose --env-file .env.production \
  -f infra/production/docker-compose.prod.yml images
docker compose --env-file .env.production \
  -f infra/production/docker-compose.prod.yml up -d --build
```

Migrations devem ser compatíveis com rollback da aplicação. Mudanças destrutivas de schema exigem
estratégia expand/contract e backup restaurável antes do deploy.

## 6. Rollback

Se o schema continuar compatível, retorne ao commit/tag anterior, restaure as tags de imagem
registradas e reaplique o Compose:

```bash
git switch --detach <commit-ou-tag-anterior>
docker compose --env-file .env.production \
  -f infra/production/docker-compose.prod.yml up -d --build
```

Depois, valide `/ready`, logs e o fluxo principal. Se a migration não for retrocompatível, não tente
reverter tabelas manualmente: interrompa a escrita, restaure PostgreSQL e workspaces juntos a partir
do mesmo ponto de backup e documente a perda máxima de dados aceita.

O rollback do nginx consiste em restaurar o arquivo previamente copiado, executar `sudo nginx -t`
e somente então recarregar o serviço. Nunca substitua a configuração do Tiremax.

## 7. Backup e restauração

Crie um diretório datado fora do repositório e, idealmente, copie o resultado para armazenamento
externo criptografado. O banco e os workspaces precisam representar o mesmo ponto lógico.

```bash
mkdir -p backups
docker compose --env-file .env.production \
  -f infra/production/docker-compose.prod.yml exec -T postgres \
  pg_dump -U oliveira -d devcloud -Fc > backups/devcloud.dump
sudo tar -C /var/lib/oliveira-devcloud \
  -czf backups/workspaces.tar.gz workspaces
sha256sum backups/devcloud.dump backups/workspaces.tar.gz
```

Os nomes padrão acima devem acompanhar `POSTGRES_USER` e `POSTGRES_DB` se forem alterados. Teste a
restauração primeiro em ambiente isolado. Uma restauração de produção é destrutiva e exige janela de
manutenção, confirmação do alvo e backup do estado atual:

```bash
docker compose --env-file .env.production \
  -f infra/production/docker-compose.prod.yml stop web api worker runtime-broker
docker compose --env-file .env.production \
  -f infra/production/docker-compose.prod.yml exec -T postgres \
  pg_restore -U oliveira -d devcloud --clean --if-exists --no-owner --no-privileges \
  < backups/devcloud.dump
sudo tar -C /var/lib/oliveira-devcloud -xzf backups/workspaces.tar.gz
docker compose --env-file .env.production \
  -f infra/production/docker-compose.prod.yml up -d
```

Após restaurar, confira proprietário `10001:10001`, migrations, readiness e o arquivo persistente do
smoke test. Registre data, checksum, duração, ponto restaurado e resultado.

## 8. Ensaio obrigatório de persistência

Este ensaio precisa permanecer reproduzível numa VM Linux limpa:

1. criar usuário, projeto e workspace;
2. criar no workspace um arquivo com conteúdo e checksum conhecidos;
3. registrar o identificador do workspace, sem credenciais;
4. reiniciar PostgreSQL, Redis, API, worker, broker e web com `docker compose restart` — nunca usar
   `down -v`;
5. injetar restart durante operações: API sob leituras autenticadas, Redis com job enfileirado,
   Runtime Broker durante exec e worker sob `SIGKILL` com recovery de lease stale;
6. aguardar `/ready`, reabrir o workspace e comparar o checksum;
7. realizar backup, restaurar em ambiente isolado e repetir a comparação;
8. anexar comandos, saídas sanitizadas e resultado ao plano operacional.

O workflow `.github/workflows/production-smoke.yml` automatiza os itens 1–7 em um runner
`ubuntu-latest`; o smoke autenticado de agente e a navegação IDE pelo domínio TLS real permanecem
validações externas, respectivamente por credencial do usuário e pela Fase 2.

### Evidência de fault injection — 2026-08-14

O run [31815417716](https://github.com/RobersonCodes/Oliveira-DevCloud/actions/runs/31815417716)
aprovou os quatro cenários durante operações e publicou evidência sanitizada
`api_restart_during_authenticated_reads=passed`, `redis_restart_with_queued_setup=passed`,
`runtime_broker_restart_during_setup=passed` e `worker_sigkill_setup_recovery=passed`. A mesma
jornada concluiu o backup/restore isolado e o cleanup da stack descartável.

### Evidência Linux limpa — 2026-08-11

O run [31525879533](https://github.com/RobersonCodes/Oliveira-DevCloud/actions/runs/31525879533)
executou `scripts/production-clean-host-smoke.sh` com sucesso em `ubuntu-latest`. A imagem foi puxada
pelo digest OCI fixado; Compose, migrations e readiness passaram; usuário, organização, projeto,
workspace real non-root e terminal foram criados; PostgreSQL, Redis/AOF, broker, API, worker e web
foram reiniciados; o arquivo do workspace preservou o SHA-256
`259bcc9fe6b8c7befcf46858d1dad73b3fdcf9daa575d413012a23e0552278f3`. O dump PostgreSQL e o tar dos
workspaces foram restaurados em banco e diretório isolados, preservando projeto e checksum. O
workflow publicou somente evidência sanitizada e removeu stack/volumes descartáveis ao final.

### Evidência local preliminar — 2026-08-10

Antes da VM Linux, o procedimento de reinício foi exercitado no Docker Desktop com projeto Compose
isolado `odc-persistence-test`, portas `127.0.0.1:28080/28081`, volumes próprios e bind mount dentro
do diretório temporário do repositório. As imagens de API, web, worker e broker foram reconstruídas;
migrations terminaram com código zero e `/ready` confirmou PostgreSQL, Redis e Runtime Broker.

Foram criados um usuário/organização e um projeto descartáveis no PostgreSQL, além de um
arquivo-prova no bind mount com SHA-256
`E05D57263E46C692957995484F398C7F05E75C837EA96E129C0D3F6734C2BFEF`. Depois de
`docker-compose restart postgres redis runtime-broker api worker web`, `/ready` voltou a `ready`, os
três registros continuaram consultáveis e o checksum permaneceu idêntico. Uma chave descartável do
Redis também sobreviveu a um reinício próprio, confirmando o AOF. Ao final, 7 containers, 2 volumes,
1 rede e o diretório temporário do projeto de teste foram removidos.

Essa evidência confirma as três fronteiras de persistência após `restart` (volume PostgreSQL, volume
Redis/AOF e bind mount de workspace), mas **não conclui** o ensaio obrigatório acima: o ambiente era
Docker Desktop/Windows, o arquivo não foi criado por um workspace real via fluxo público e não houve
backup/restore isolado nem execução autenticada de agente. Esses passos permanecem obrigatórios na
VM Linux limpa.

## 9. Recuperação de desastre

Em perda total do host:

1. provisionar outro Linux compatível e instalar Docker/Compose;
2. recuperar o mesmo commit/tag e as mesmas tags ou digests de imagem;
3. recriar `.env.production` a partir do cofre de secrets, não de conversas ou Git;
4. restaurar PostgreSQL e workspaces do mesmo backup verificado;
5. reaplicar certificados e server blocks sem alterar o Tiremax;
6. validar readiness, isolamento do socket, DNS/TLS e o smoke test funcional;
7. só então redirecionar tráfego e registrar o incidente.

Metas de RPO/RTO, retenção, criptografia e responsável pelo backup devem ser definidas antes do beta.
