# Preparação para registro de programa de computador no INPI

## Finalidade

Este guia reúne os materiais internos necessários para preparar o pedido de registro da Oliveira
DevCloud. O pedido efetivo deve ser realizado no serviço eletrônico oficial do INPI.

## Materiais preparados neste repositório

- `AUTHORS.md` — identificação de autoria e contribuições;
- `COPYRIGHT.md` — aviso de direitos autorais;
- `NOTICE.md` — aviso de titularidade e componentes de terceiros;
- `docs/legal/REGISTRO-DE-PROVENIENCIA.md` — evidências Git e escopo declarado;
- `docs/legal/DECLARACAO-DE-AUTORIA-OLIVEIRA-DEVCLOUD.docx` — declaração formal para assinatura;
- `docs/legal/DECLARACAO-DE-AUTORIA-OLIVEIRA-DEVCLOUD.pdf` — versão renderizada para conferência;
- `docs/legal/evidence/oliveira-devcloud-v2.5.0-7b80cfa-source.zip` — snapshot do código no commit de referência;
- `docs/legal/evidence/SHA256SUMS.txt` — resumo de integridade do snapshot.

## Passos recomendados

1. Revise o nome civil do autor e a titularidade declarada.
2. Confirme se houve trabalho de empregados, prestadores ou colaboradores com direitos contratuais.
3. Guarde o snapshot sem alterações em mídia externa segura.
4. Verifique o SHA-256 antes do depósito.
5. Assine digitalmente a declaração e a documentação exigida pelo INPI.
6. Preencha o pedido no e-Software com as informações funcionais da versão.
7. Guarde certificado, protocolo, comprovantes e o mesmo arquivo-fonte usado para gerar o hash.
8. Repita o processo para versões futuras que ampliem materialmente o software.

## Verificação do snapshot

No PowerShell:

```powershell
Get-FileHash -Algorithm SHA256 .\docs\legal\evidence\oliveira-devcloud-v2.5.0-7b80cfa-source.zip
```

No Linux ou macOS:

```bash
sha256sum docs/legal/evidence/oliveira-devcloud-v2.5.0-7b80cfa-source.zip
```

O resultado deve coincidir com `docs/legal/evidence/SHA256SUMS.txt`.

## Observação jurídica

A proteção autoral do programa de computador independe de registro, conforme a Lei nº 9.609/1998.
O INPI informa que o registro oferece maior segurança jurídica para comprovação de autoria ou
titularidade. Para decisões sobre licenciamento, cessão, sociedade, contratação ou exploração
comercial, consulte profissional especializado em propriedade intelectual.
