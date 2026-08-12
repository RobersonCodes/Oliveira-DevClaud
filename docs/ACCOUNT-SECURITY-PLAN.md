# Plano de recuperação de conta, verificação de e-mail e MFA/passkeys

**Status:** planejado na Fase 6 em 2026-08-12; ainda não implementado.

Este documento transforma a pendência de identidade em incrementos implementáveis sem enfraquecer
as garantias atuais de sessão. A ordem é deliberada: primeiro provar o endereço de e-mail e criar um
canal de recuperação seguro; depois adicionar passkeys/MFA e códigos de recuperação.

## Invariantes

- Respostas de solicitação de verificação/recuperação são indistinguíveis para e-mails existentes e
  inexistentes; o endpoint sempre retorna `202` e executa trabalho de custo comparável.
- Tokens são gerados com pelo menos 32 bytes aleatórios, enviados somente por e-mail e persistidos
  apenas como SHA-256, com finalidade, usuário, expiração, uso único e limite de tentativas.
- Consumo de token é transacional: marcar como usado e alterar o estado da conta acontecem juntos.
- Alteração/recuperação de senha revoga todas as sessões e, por consequência, os tickets/cookies do
  Runtime Gateway vinculados a elas. O usuário precisa autenticar novamente.
- Nenhum segredo MFA, código de recuperação, challenge WebAuthn ou token aparece em logs/auditoria.
- Toda emissão, consumo, falha por expiração, cadastro/remoção de fator e revogação de sessões gera
  evento de auditoria sem dados secretos.
- Rate limits independentes protegem IP, conta/e-mail normalizado e usuário autenticado; uma fila de
  e-mail com idempotency key impede envios duplicados.

## Incremento A — verificação de e-mail

1. Adicionar `User.emailVerifiedAt` e `AccountToken` com `type`, `tokenHash`, `userId`, `expiresAt`,
   `usedAt`, `attempts`, `createdAt` e índices por hash/usuário/expiração.
2. Introduzir uma interface `EmailDelivery` no worker. Produção exige configuração explícita do
   provedor/remetente; desenvolvimento usa caixa local capturável por teste, nunca loga o link.
3. Após cadastro ou troca futura de e-mail, criar token `VERIFY_EMAIL` de 24 horas e enfileirar a
   mensagem. `POST /auth/email-verification/request` sempre responde `202`; `POST
   /auth/email-verification/confirm` consome o token uma vez.
4. Durante rollout, contas existentes recebem `emailVerifiedAt` preenchido pela migração para não
   bloquear usuários atuais. Novas contas não verificadas podem entrar, mas ações sensíveis
   (secrets, merge/review, criação de runtime) passam a exigir e-mail verificado após um período de
   aviso configurado e observado.

## Incremento B — recuperação de conta

1. `POST /auth/password-recovery/request` normaliza o e-mail, aplica rate limit e responde sempre
   `202`. Para conta elegível, cria token `PASSWORD_RESET` de 30 minutos e invalida tokens anteriores
   da mesma finalidade.
2. `POST /auth/password-recovery/confirm` recebe token e nova senha, valida a política existente,
   troca `passwordHash`, zera lockout, marca o token como usado e apaga todas as sessões na mesma
   transação.
3. Contas com MFA exigem, além do link, um segundo fator ou um código de recuperação. Suporte não
   pode contornar esse requisito por edição direta no banco; recuperação administrativa futura exige
   fluxo separado, dupla aprovação e auditoria.

## Incremento C — passkeys e MFA

1. Preferir passkeys/WebAuthn como fator resistente a phishing. Criar `WebAuthnCredential` com
   `credentialId`, `publicKey`, `counter`, `transports`, `deviceType`, `backedUp`, `name`, timestamps e
   vínculo ao usuário. Nunca persistir chave privada.
2. Challenges de cadastro/autenticação ficam no Redis por no máximo cinco minutos, uso único,
   ligados à sessão/usuário e ao fluxo. RP ID deriva de `DEV_CLOUD_HOST`; Origin deve ser exatamente
   `WEB_ORIGIN`, ambos já validados no boot de produção.
3. Cadastro e remoção de passkey exigem sessão recente (por exemplo, autenticação nos últimos dez
   minutos) e confirmação por senha/fator já existente. Remover o último fator forte exige criar
   substituto ou confirmar a senha.
4. TOTP pode existir como compatibilidade, com seed criptografada pela chave mestra e nunca
   retornada após confirmação. SMS não faz parte do plano.
5. Ao ativar o primeiro fator, gerar dez códigos de recuperação aleatórios, exibir uma única vez e
   armazenar somente hashes. Cada código é de uso único; regenerar invalida todos os anteriores.
6. Login passa a um estado intermediário curto (`MFA_PENDING`) que não é uma sessão da aplicação e
   não autoriza rotas de negócio. Só após validar passkey/TOTP/recovery code é criada a `Session`.

## Endpoints previstos

| Método e caminho | Autorização | Resultado |
| --- | --- | --- |
| `POST /auth/email-verification/request` | sessão ou e-mail genérico | agenda envio e retorna `202` |
| `POST /auth/email-verification/confirm` | token | verifica e-mail uma vez |
| `POST /auth/password-recovery/request` | público, limitado | resposta genérica `202` |
| `POST /auth/password-recovery/confirm` | token + fator quando aplicável | troca senha e revoga sessões |
| `POST /auth/passkeys/options` | sessão recente | gera challenge de cadastro |
| `POST /auth/passkeys` | sessão recente + attestation | cadastra credencial |
| `DELETE /auth/passkeys/:id` | sessão recente + confirmação | remove credencial própria |
| `POST /auth/mfa/verify` | estado `MFA_PENDING` | conclui login e cria sessão |
| `POST /auth/recovery-codes/regenerate` | sessão recente + MFA | substitui todos os códigos |

## Entrega e validação

1. Migração aditiva e compatível; backfill explícito para usuários existentes.
2. Implementar tokens/e-mail e testes de enumeração, expiração, concorrência de consumo e reuso.
3. Implementar recuperação e provar revogação imediata de HTTP, WS e Runtime Gateway.
4. Implementar passkeys com browser E2E em Chromium e teste manual Safari/iOS e Chrome/Android.
5. Implementar recovery codes/TOTP, auditoria e alertas de segurança por e-mail.
6. Ativar enforcement gradualmente, com métricas de entrega, falha, abandono e lockout; rollback
   desliga apenas a exigência, nunca remove credenciais ou reabilita tokens usados.

Critério de conclusão futuro: matriz automatizada para conta inexistente/não verificada/verificada,
token válido/expirado/usado/concorrente, sessão revogada, passkey válida/origin errado/counter
inválido, TOTP fora de janela e recovery code reutilizado, mais teste físico nos dois ecossistemas
móveis registrados como dependência da Fase 8.
