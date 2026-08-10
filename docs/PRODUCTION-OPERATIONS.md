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

Preencha todos os placeholders. Gere chaves aleatórias fora do histórico do shell sempre que
possível e nunca envie `.env.production`, certificados ou backups ao Git. Descubra o grupo numérico
do socket e prepare o diretório persistente:

```bash
stat -c '%g' /var/run/docker.sock
sudo install -d -o 10001 -g 10001 -m 0750 /var/lib/oliveira-devcloud/workspaces
```

Copie o GID retornado para `DOCKER_GID`. Até a imagem versionada existir no GHCR, construa exatamente
a versão configurada no arquivo de ambiente:

```bash
docker build --pull \
  -t oliveira-devcloud/workspace-node:1.1.0 \
  infra/workspace-images/node
```

O Dockerfile baixa o artefato oficial do code-server `4.121.0` e rejeita o build se o SHA-256 não
corresponder ao valor fixado. O mesmo build instala, pelo lockfile, pnpm `11.21.0`, Codex CLI
`0.147.0` e Claude Code `2.1.226`. Depois da primeira publicação aprovada no GHCR, troque
`WORKSPACE_IMAGE` por `ghcr.io/robersoncodes/oliveira-devcloud-workspace-node:1.1.0` e use
`docker pull` em vez do build local.

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

Este ensaio ainda precisa ser executado numa VM Linux limpa antes de concluir a Fase 5:

1. criar usuário, projeto e workspace;
2. criar no workspace um arquivo com conteúdo e checksum conhecidos;
3. registrar o identificador do workspace, sem credenciais;
4. reiniciar PostgreSQL, Redis, API, worker, broker e web com `docker compose restart` — nunca usar
   `down -v`;
5. aguardar `/ready`, reabrir o workspace e comparar o checksum;
6. realizar backup, restaurar em ambiente isolado e repetir a comparação;
7. anexar comandos, saídas sanitizadas e resultado ao plano operacional.

Sem esse ensaio e o smoke test completo, a Fase 5 permanece `EM ANDAMENTO`.

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
