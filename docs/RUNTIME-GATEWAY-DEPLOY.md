# Runtime Gateway — deploy em domínio real (Fase 2 / Etapa 2)

> Runbook operacional para levar o Runtime Gateway (já implementado em código — ver
> `docs/HARDENING-ROADMAP.md` P0-2) a funcionar em produção, num servidor real. Este documento cobre
> exatamente os passos que dependem do seu provedor de DNS e do seu servidor — nenhum deles pode ser
> executado a partir de uma sessão sem acesso SSH à VPS.

## Domínios desta implantação

| Papel | Domínio | Variável |
|---|---|---|
| Painel (control plane) | `app.aifunnelpro.com.br` | `DEV_CLOUD_HOST` |
| Runtime Gateway (IDE/preview) | `runtime.tiremax.shop` | `RUNTIME_BASE_DOMAIN` |

Os dois já estão em domínios registráveis diferentes (`aifunnelpro.com.br` vs `tiremax.shop`) —
pré-requisito de segurança do P0-2, não apenas dois subdomínios do mesmo domínio. Se algum dia esses
nomes mudarem, atualize `.env.production` (ver `.env.production.example`) e refaça os passos abaixo
para o domínio novo.

## Topologia: VPS compartilhada com outro site (Tiremax)

Esta VPS já hospeda outro site (Tiremax) atrás de um nginx do sistema que ocupa as portas 80/443.
Por isso a topologia deste deploy é diferente do modelo "nginx dedicado" mais simples:

- `infra/production/docker-compose.prod.yml` **não** publica 80/443 por padrão e **não** roda nenhum
  serviço nginx próprio nessa configuração — `web` e `api` publicam apenas em
  `127.0.0.1:${DEVCLOUD_WEB_HOST_PORT:-18080}` e `127.0.0.1:${DEVCLOUD_API_HOST_PORT:-18081}`,
  inacessíveis de fora do host.
- Quem termina TLS e roteia por `Host` continua sendo um nginx só — mas é o nginx **já existente no
  host**, o mesmo que serve o Tiremax, não um container deste compose.
- `infra/production/nginx-devcloud.host.conf.example` (config final) e
  `nginx-devcloud.host.bootstrap.conf.example` (config temporária, ver seção 2) trazem os server
  blocks do DevCloud prontos para adicionar ao nginx do host **sem tocar** na configuração existente
  do Tiremax — veja o cabeçalho de cada arquivo para o passo a passo exato de onde colocá-lo.
- Para uma eventual VPS **exclusiva** (sem outro site), o compose também tem um caminho pronto: o
  serviço `nginx` (dockerizado, usa `infra/production/nginx.prod.conf`) existe no compose mas fica
  **off por padrão**, atrás de um profile — só sobe com
  `docker compose --profile standalone-nginx up -d`. Não é o caminho usado nesta implantação
  (compartilhada com o Tiremax); nunca ative esse profile aqui.

## Visão geral do que cada servidor precisa resolver

- `app.aifunnelpro.com.br` → IP do servidor (registro `A`, e `AAAA` se houver IPv6).
- `*.runtime.tiremax.shop` → IP do servidor (registro `A` **wildcard**). Cada workspace recebe seu
  próprio subdomínio de uma palavra só (`ide-<workspaceId>`, `preview-<workspaceId>-<porta>`)
  diretamente sob esse domínio base — é por isso que precisa ser wildcard, não uma lista de nomes
  fixos.
- O nome base `runtime.tiremax.shop` (sem subdomínio) não precisa resolver para nada em especial —
  nenhum server block do nginx casa com ele sozinho, só com `*.` na frente. Registrar também não
  atrapalha.

**Status confirmado em 2026-08-10:** os três (`app.aifunnelpro.com.br`, `runtime.tiremax.shop`,
`*.runtime.tiremax.shop`) já resolvem para o IP real do servidor (propagação confirmada
externamente). HTTP já chega até o nginx do host — uma requisição para `app.aifunnelpro.com.br`
abriu o Tiremax, o que só é possível se a porta 80 estiver alcançável e o nginx estiver processando a
requisição (ela caiu no `default_server`/server block do Tiremax por não existir ainda um
`server_name` dedicado ao DevCloud). A porta 22 aparecer fechada externamente é esperado/intencional
neste servidor, não um sintoma de firewall bloqueando 80/443. **O bloqueio real e único agora é que
os server blocks do DevCloud e os certificados TLS ainda não existem** — não há diagnóstico de rede
pendente, só os passos 1-6 abaixo.

## 1. Registros DNS

Já feito e confirmado propagado (ver "Status confirmado" acima). Para referência futura, os
registros são:

```text
app.aifunnelpro.com.br.        A     <IP do servidor>
runtime.tiremax.shop.          A     <IP do servidor>      ; opcional, ver acima
*.runtime.tiremax.shop.        A     <IP do servidor>      ; obrigatório
```

Confirme propagação com `dig +short app.aifunnelpro.com.br` e
`dig +short algo-qualquer.runtime.tiremax.shop` de uma máquina fora da rede do servidor.

## 2. Bootstrap HTTP-only (resolve o ciclo do certificado)

O certbot HTTP-01 do painel precisa que o nginx já sirva `/.well-known/acme-challenge/` em texto
plano — mas a config final (`nginx-devcloud.host.conf.example`) tem server blocks HTTPS que
referenciam certificados que só existem *depois* da emissão, então `nginx -t` falharia se você
aplicasse a config final primeiro. `nginx-devcloud.host.bootstrap.conf.example` quebra esse ciclo:
é uma config **só HTTP**, sem nenhuma referência a certificado, que existe apenas para o painel
conseguir emitir seu certificado. Siga o cabeçalho desse arquivo — resumo:

```bash
sudo mkdir -p /var/www/certbot
sudo cp infra/production/nginx-devcloud.host.bootstrap.conf.example /etc/nginx/sites-available/devcloud.conf
sudo ln -s /etc/nginx/sites-available/devcloud.conf /etc/nginx/sites-enabled/devcloud.conf
sudo nginx -t       # deve passar limpo — este arquivo não referencia certificado nenhum
sudo systemctl reload nginx
```

`runtime.tiremax.shop` não precisa de nada nesta seção — o certificado wildcard usa DNS-01, que
nunca depende do nginx.

## 3. Certificados TLS

São **dois certificados independentes**, um por origem — nunca reaproveite um para o outro, cada um
prova posse de um domínio registrável diferente.

- `app.aifunnelpro.com.br` — host único, desafio HTTP-01 via webroot (usa o bootstrap da seção 2).
- `*.runtime.tiremax.shop` — **wildcard**, exige desafio **DNS-01** (Let's Encrypt não emite
  wildcard via HTTP-01; independe de porta 80/nginx, pode ser feito antes, depois ou em paralelo ao
  passo do painel).

### 3.1 Painel (HTTP-01 via webroot)

```bash
sudo certbot certonly --webroot -w /var/www/certbot -d app.aifunnelpro.com.br
```

### 3.2 Runtime Gateway (DNS-01, wildcard)

Se o seu provedor de DNS tem um plugin certbot dedicado (Cloudflare, Route53, DigitalOcean etc. — veja
`certbot plugins` ou a lista em https://certbot.eff.org/docs/using.html#dns-plugins), use-o: ele
automatiza a criação/remoção do registro `TXT` de validação e permite que `certbot renew` funcione
sozinho depois. Exemplo genérico (troque `dns-cloudflare` pelo plugin certo e aponte para suas
credenciais de API):

```bash
sudo certbot certonly \
  --dns-cloudflare --dns-cloudflare-credentials /root/.secrets/cloudflare.ini \
  -d "runtime.tiremax.shop" \
  -d "*.runtime.tiremax.shop"
```

Sem plugin disponível, o modo manual funciona mas exige que você crie o registro `TXT` à mão a cada
emissão/renovação:

```bash
sudo certbot certonly --manual --preferred-challenges dns \
  -d "runtime.tiremax.shop" \
  -d "*.runtime.tiremax.shop"
```

O certbot vai pedir para criar um `TXT` em `_acme-challenge.runtime.tiremax.shop` com um valor
específico — crie no seu provedor de DNS, espere propagar
(`dig txt _acme-challenge.runtime.tiremax.shop`) e só então confirme no prompt do certbot.

### 3.3 Onde os certificados ficam

O nginx do host lê direto de onde o certbot já deixa por padrão — `nginx-devcloud.host.conf.example`
já aponta para:

```text
/etc/letsencrypt/live/app.aifunnelpro.com.br/{fullchain,privkey}.pem
/etc/letsencrypt/live/runtime.tiremax.shop/{fullchain,privkey}.pem
```

Nenhuma cópia manual é necessária.

## 4. Trocar do bootstrap para a config final

Com os dois certificados já emitidos:

```bash
# Remove o bootstrap ANTES de ativar a config final — nunca deixe os dois ao mesmo tempo, ou o
# nginx vê dois server blocks "listen 80; server_name app.aifunnelpro.com.br" conflitantes.
sudo rm -f /etc/nginx/sites-enabled/devcloud.conf

sudo cp infra/production/nginx-devcloud.host.conf.example /etc/nginx/sites-available/devcloud.conf
sudo ln -s /etc/nginx/sites-available/devcloud.conf /etc/nginx/sites-enabled/devcloud.conf

sudo nginx -t       # agora deve passar limpo, referenciando os certificados reais
sudo systemctl reload nginx
```

Depois deste ponto o bootstrap não precisa mais existir no host — a config final já cobre o redirect
HTTP→HTTPS e o próprio ACME webroot, para renovações futuras.

## 5. Renovação

Certificados Let's Encrypt expiram em 90 dias.

- **Com plugin DNS automatizado (3.2, primeira opção):** o desafio HTTP-01 via webroot (painel) e o
  DNS-01 automatizado (runtime) já funcionam sozinhos com `certbot renew` — só falta recarregar o
  nginx do host depois, porque ele lê os arquivos de certificado uma vez e não detecta a troca
  sozinho. Configure um `--deploy-hook`:

  ```bash
  sudo certbot renew --deploy-hook "systemctl reload nginx"
  ```

  E agende isso num cron/systemd timer diário — `certbot renew` só age nos certificados a ~30 dias do
  vencimento, então rodar todo dia é seguro e é a prática recomendada oficialmente.

- **Sem plugin (modo manual, 3.2 segunda opção):** não tem como automatizar o desafio DNS-01 manual.
  Marque um lembrete para repetir o passo 3.2 + reload do nginx antes dos 90 dias vencerem. Se isso
  for operacionalmente inviável, vale a pena migrar o DNS do domínio de runtime para um provedor com
  plugin certbot suportado só por causa disso.

## 6. Primeiro `docker compose up`

```bash
# Confirme antes que DEVCLOUD_WEB_HOST_PORT/DEVCLOUD_API_HOST_PORT (.env.production) estão livres:
sudo ss -lntp | grep -E ':(18080|18081)\s'   # (ou as portas que você tiver escolhido)

docker compose --env-file .env.production -f infra/production/docker-compose.prod.yml up -d
curl -sI -H 'Host: app.aifunnelpro.com.br' http://127.0.0.1:18080   # web respondendo
curl -sI http://127.0.0.1:18081/ready                                # api respondendo
```

Não há `nginx -t` de um container aqui — a config que importa é a do host (seção 4), já validada
antes do reload.

## 7. Validação no domínio real (critérios de aceite da Fase 2)

- [ ] `https://app.aifunnelpro.com.br` carrega o painel, sem aviso de certificado.
- [ ] Login → projeto → workspace → abrir IDE emite um ticket e redireciona para
      `https://ide-<workspaceId>.runtime.tiremax.shop/...`, também sem aviso de certificado.
- [ ] A aba de rede do browser confirma: nenhum cookie do painel (`__Host-odc_session`) é enviado nas
      requisições para o domínio de runtime, e vice-versa.
- [ ] Abrir um preview registra um segundo host `preview-<workspaceId>-<porta>.runtime...` funcional.
- [ ] WebSocket do terminal (painel) e do IDE/preview (runtime) conectam e mantêm conexão — confirme
      pela aba Network > WS do browser, não só pela ausência de erro visual.
- [ ] Um ticket de um workspace não abre outro (teste manual: pegue a URL com ticket de um workspace,
      troque o `workspaceId` na URL, confirme 401/403).
- [ ] `GET /api/v1/proxy/*` (proxy legado) devolve `410` — confirma que a app está mesmo em
      `NODE_ENV=production`.
- [ ] O Tiremax continua funcionando normalmente durante e depois de todo o processo acima (nenhum
      server block, cert ou porta dele foi tocado).

Os testes automatizados que cobrem a lógica desses cenários (ticket, Origin, cookie, RBAC, remoção de
`Domain` em `Set-Cookie`, ataque sibling) já rodam em `apps/api/src/runtimeGateway.test.ts` e
`apps/api/e2e-browser/runtimeGateway.spec.ts` — mas só contra um domínio simulado
(`*.runtime.localhost`/servidor efêmero), nunca contra DNS/TLS/nginx reais. Este runbook é o que fecha
essa lacuna; depois de rodar a checklist acima com sucesso, atualize
`docs/PROJECT-COMPLETION-PLAN.md` (Fase 2) e `docs/HARDENING-ROADMAP.md` com a evidência.

## 8. Recuperação de falha

| Sintoma | Causa provável | Ação |
|---|---|---|
| `app.aifunnelpro.com.br` abre o Tiremax em vez do painel | Falta o server block dedicado (seção 2 ou 4), então cai no `default_server` do Tiremax | Confirme que o bootstrap (seção 2) ou a config final (seção 4) está ativa em `sites-enabled` e `nginx -t` limpo |
| `nginx -t` falha ao aplicar a config final | Certificados ainda não existem, ou bootstrap ainda ativo ao mesmo tempo | Confirme os dois certificados em `/etc/letsencrypt/live/` (seção 3.3) e que `sites-enabled/devcloud.conf` não aponta mais para o bootstrap antes de trocar (seção 4) |
| Aviso de certificado só no painel | Cert de `app.aifunnelpro.com.br` expirado/errado | Repita 3.1, `systemctl reload nginx` |
| Aviso de certificado só ao abrir IDE/preview | Cert de `runtime.tiremax.shop` expirado/errado, ou não é wildcard | Repita 3.2, `systemctl reload nginx` |
| IDE/preview não abre, painel funciona normalmente | DNS wildcard não propagado ou registro `A` errado | `dig +short algo.runtime.tiremax.shop`; deve devolver o IP do servidor |
| `docker compose up` falha ao subir `web`/`api` | `DEVCLOUD_WEB_HOST_PORT`/`DEVCLOUD_API_HOST_PORT` já em uso por outro processo do host | `sudo ss -lntp` para achar o que já ocupa a porta; escolha outra em `.env.production` e atualize `nginx-devcloud.host.conf.example`/`.bootstrap.conf.example` |
| Erro 404 puro em qualquer host do domínio de runtime | Host não bate com o padrão `(ide\|preview)-...` esperado pela app (`runtimeHostPattern()` em `runtimeGateway.ts`) — comportamento esperado, não é falha de infra | — |
| Tiremax parou de responder depois da mudança | Algo nas seções 2/4 sobrescreveu/duplicou config do Tiremax em vez de adicionar ao lado | `sudo nginx -T` para comparar com o backup feito antes da mudança; restaure o backup, reaplique só o necessário |
