# Runtime Gateway — deploy em domínio real (Fase 2 / Etapa 2)

> Runbook operacional para levar o Runtime Gateway (já implementado em código — ver
> `docs/HARDENING-ROADMAP.md` P0-2) a funcionar em produção, num servidor real. Este documento cobre
> exatamente os passos que dependem do seu provedor de DNS e do seu servidor — nenhum deles pode ser
> executado a partir desta sessão.

## Domínios desta implantação

| Papel | Domínio | Variável |
|---|---|---|
| Painel (control plane) | `app.oliveiradevcloud.com` | `DEV_CLOUD_HOST` |
| Runtime Gateway (IDE/preview) | `runtime.oliveiradevcloud-content.com` | `RUNTIME_BASE_DOMAIN` |

Os dois já estão em domínios registráveis diferentes (`oliveiradevcloud.com` vs
`oliveiradevcloud-content.com`) — pré-requisito de segurança do P0-2, não apenas dois subdomínios do
mesmo domínio. Se algum dia esses nomes mudarem, atualize `.env.production` (ver
`.env.production.example`) e refaça os passos abaixo para o domínio novo.

## Visão geral do que cada servidor precisa resolver

- `app.oliveiradevcloud.com` → IP do servidor (registro `A`, e `AAAA` se houver IPv6).
- `*.runtime.oliveiradevcloud-content.com` → IP do servidor (registro `A` **wildcard**). Cada
  workspace recebe seu próprio subdomínio de uma palavra só (`ide-<workspaceId>`,
  `preview-<workspaceId>-<porta>`) diretamente sob esse domínio base — é por isso que precisa ser
  wildcard, não uma lista de nomes fixos.
- O nome base `runtime.oliveiradevcloud-content.com` (sem subdomínio) não precisa resolver para nada
  em especial — nenhum server block do nginx casa com ele sozinho, só com `*.` na frente. Registrar
  também não atrapalha.

## 1. Registros DNS

No provedor de DNS de cada domínio, crie:

```text
app.oliveiradevcloud.com.                A     <IP do servidor>
runtime.oliveiradevcloud-content.com.    A     <IP do servidor>      ; opcional, ver acima
*.runtime.oliveiradevcloud-content.com.  A     <IP do servidor>      ; obrigatório
```

Adicione `AAAA` equivalentes se o servidor tiver IPv6. Espere a propagação antes de seguir (confirme
com `dig +short app.oliveiradevcloud.com` e `dig +short algo-qualquer.runtime.oliveiradevcloud-content.com`
de uma máquina fora da rede do servidor — os dois devem devolver o IP do servidor).

## 2. Certificados TLS

São **dois certificados independentes**, um por origem — nunca reaproveite um para o outro, cada um
prova posse de um domínio registrável diferente:

- `app.oliveiradevcloud.com` — host único, pode usar o desafio HTTP-01 padrão do certbot.
- `*.runtime.oliveiradevcloud-content.com` — **wildcard**, exige desafio **DNS-01** (Let's Encrypt não
  emite wildcard via HTTP-01).

### 2.1 Painel (HTTP-01, mais simples)

Antes do primeiro `docker compose up` (porta 80 ainda livre):

```bash
sudo certbot certonly --standalone -d app.oliveiradevcloud.com
```

### 2.2 Runtime Gateway (DNS-01, wildcard)

Se o seu provedor de DNS tem um plugin certbot dedicado (Cloudflare, Route53, DigitalOcean etc. — veja
`certbot plugins` ou a lista em https://certbot.eff.org/docs/using.html#dns-plugins), use-o: ele
automatiza a criação/remoção do registro `TXT` de validação e permite que `certbot renew` funcione
sozinho depois. Exemplo genérico (troque `dns-cloudflare` pelo plugin certo e aponte para suas
credenciais de API):

```bash
sudo certbot certonly \
  --dns-cloudflare --dns-cloudflare-credentials /root/.secrets/cloudflare.ini \
  -d "runtime.oliveiradevcloud-content.com" \
  -d "*.runtime.oliveiradevcloud-content.com"
```

Sem plugin disponível, o modo manual funciona mas exige que você crie o registro `TXT` à mão a cada
emissão/renovação:

```bash
sudo certbot certonly --manual --preferred-challenges dns \
  -d "runtime.oliveiradevcloud-content.com" \
  -d "*.runtime.oliveiradevcloud-content.com"
```

O certbot vai pedir para criar um `TXT` em `_acme-challenge.runtime.oliveiradevcloud-content.com` com
um valor específico — crie no seu provedor de DNS, espere propagar (`dig txt
_acme-challenge.runtime.oliveiradevcloud-content.com`) e só então confirme no prompt do certbot.

### 2.3 Copiar os certificados para o layout esperado pelo compose

`infra/production/docker-compose.prod.yml` monta `infra/production/certs/` inteiro em
`/etc/nginx/certs/` dentro do container do nginx; `nginx.prod.conf` espera dois subdiretórios:

```bash
sudo mkdir -p infra/production/certs/panel infra/production/certs/runtime

sudo cp /etc/letsencrypt/live/app.oliveiradevcloud.com/fullchain.pem infra/production/certs/panel/fullchain.pem
sudo cp /etc/letsencrypt/live/app.oliveiradevcloud.com/privkey.pem   infra/production/certs/panel/privkey.pem

sudo cp /etc/letsencrypt/live/runtime.oliveiradevcloud-content.com/fullchain.pem infra/production/certs/runtime/fullchain.pem
sudo cp /etc/letsencrypt/live/runtime.oliveiradevcloud-content.com/privkey.pem   infra/production/certs/runtime/privkey.pem
```

Esse diretório é local ao servidor e nunca deve ser commitado (`.gitignore` já bloqueia
`infra/production/certs/`).

## 3. Renovação

Certificados Let's Encrypt expiram em 90 dias.

- **Com plugin DNS automatizado (2.2, primeira opção):** `certbot renew` já funciona sozinho — só
  falta reiniciar/recarregar o nginx depois, porque ele lê os arquivos de certificado uma vez na
  inicialização e não detecta a troca sozinho. Configure um `--deploy-hook` no certbot:

  ```bash
  sudo certbot renew --deploy-hook "cd /caminho/do/repo && \
    cp /etc/letsencrypt/live/app.oliveiradevcloud.com/fullchain.pem infra/production/certs/panel/fullchain.pem && \
    cp /etc/letsencrypt/live/app.oliveiradevcloud.com/privkey.pem infra/production/certs/panel/privkey.pem && \
    cp /etc/letsencrypt/live/runtime.oliveiradevcloud-content.com/fullchain.pem infra/production/certs/runtime/fullchain.pem && \
    cp /etc/letsencrypt/live/runtime.oliveiradevcloud-content.com/privkey.pem infra/production/certs/runtime/privkey.pem && \
    docker compose -f infra/production/docker-compose.prod.yml exec nginx nginx -s reload"
  ```

  E agende isso num cron/systemd timer diário — `certbot renew` só age nos certificados a ~30 dias do
  vencimento, então rodar todo dia é seguro e é a prática recomendada oficialmente.

- **Sem plugin (modo manual, 2.2 segunda opção):** não tem como automatizar o desafio DNS-01 manual.
  Marque um lembrete para repetir o passo 2.2 + 2.3 + reload do nginx antes dos 90 dias vencerem. Se
  isso for operacionalmente inviável, vale a pena migrar o DNS do domínio de runtime para um provedor
  com plugin certbot suportado só por causa disso.

## 4. Primeiro `docker compose up`

Com os dois pares de certificado já em `infra/production/certs/{panel,runtime}/`:

```bash
docker compose --env-file .env.production -f infra/production/docker-compose.prod.yml up -d
docker compose -f infra/production/docker-compose.prod.yml exec nginx nginx -t   # valida a config renderizada
```

`nginx -t` reporta erro de sintaxe ou de certificado ausente/ilegível antes de servir tráfego real —
rode sempre depois de qualquer mudança em `nginx.prod.conf`, `.env.production` ou nos certificados.

## 5. Validação no domínio real (critérios de aceite da Fase 2)

- [ ] `https://app.oliveiradevcloud.com` carrega o painel, sem aviso de certificado.
- [ ] Login → projeto → workspace → abrir IDE emite um ticket e redireciona para
      `https://ide-<workspaceId>.runtime.oliveiradevcloud-content.com/...`, também sem aviso de
      certificado.
- [ ] A aba de rede do browser confirma: nenhum cookie do painel (`__Host-odc_session`) é enviado nas
      requisições para o domínio de runtime, e vice-versa.
- [ ] Abrir um preview registra um segundo host `preview-<workspaceId>-<porta>.runtime...` funcional.
- [ ] WebSocket do terminal (painel) e do IDE/preview (runtime) conectam e mantêm conexão — confirme
      pela aba Network > WS do browser, não só pela ausência de erro visual.
- [ ] Um ticket de um workspace não abre outro (teste manual: pegue a URL com ticket de um workspace,
      troque o `workspaceId` na URL, confirme 401/403).
- [ ] `GET /api/v1/proxy/*` (proxy legado) devolve `410` — confirma que a app está mesmo em
      `NODE_ENV=production`.

Os testes automatizados que cobrem a lógica desses cenários (ticket, Origin, cookie, RBAC, remoção de
`Domain` em `Set-Cookie`, ataque sibling) já rodam em `apps/api/src/runtimeGateway.test.ts` e
`apps/api/e2e-browser/runtimeGateway.spec.ts` — mas só contra um domínio simulado
(`*.runtime.localhost`/servidor efêmero), nunca contra DNS/TLS/nginx reais. Este runbook é o que fecha
essa lacuna; depois de rodar a checklist acima com sucesso, atualize
`docs/PROJECT-COMPLETION-PLAN.md` (Fase 2) e `docs/HARDENING-ROADMAP.md` com a evidência.

## 6. Recuperação de falha

| Sintoma | Causa provável | Ação |
|---|---|---|
| Aviso de certificado só no painel | Cert de `panel/` expirado/errado | Repita 2.1 + 2.3, `nginx -s reload` |
| Aviso de certificado só ao abrir IDE/preview | Cert de `runtime/` expirado/errado, ou não é wildcard | Repita 2.2 + 2.3, `nginx -s reload` |
| IDE/preview não abre, painel funciona normalmente | DNS wildcard não propagado ou registro `A` errado | `dig +short algo.runtime.oliveiradevcloud-content.com`; deve devolver o IP do servidor |
| `docker compose up` falha ao subir o `nginx` | Certificado ausente no path esperado | Confira `infra/production/certs/{panel,runtime}/{fullchain,privkey}.pem` existem antes do `up` |
| Erro 404 puro em qualquer host do domínio de runtime | Host não bate com o padrão `(ide|preview)-...` esperado pela app (`runtimeHostPattern()` em `runtimeGateway.ts`) — comportamento esperado, não é falha de infra | — |
