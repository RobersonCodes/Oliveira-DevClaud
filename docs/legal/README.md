# Kit de autoria — Oliveira DevCloud

Este diretório reúne a declaração formal, o registro técnico de proveniência e as evidências
reproduzíveis de uma revisão específica da Oliveira DevCloud.

## Documentos

- `DECLARACAO-DE-AUTORIA-OLIVEIRA-DEVCLOUD.docx` — versão editável para revisão e assinatura;
- `DECLARACAO-DE-AUTORIA-OLIVEIRA-DEVCLOUD.pdf` — versão renderizada para leitura e assinatura;
- `REGISTRO-DE-PROVENIENCIA.md` — vínculo entre autoria declarada, histórico Git e snapshot;
- `GUIA-PARA-REGISTRO-NO-INPI.md` — roteiro de preparação para o procedimento oficial;
- `evidence/SHA256SUMS.txt` — resumo criptográfico e identificadores Git;
- `evidence/oliveira-devcloud-v2.5.0-7b80cfa-source.zip` — snapshot imutável do commit documentado.

## Antes de assinar

Confirme o nome civil, a titularidade, a existência de coautores, vínculos trabalhistas, contratos,
cessões e componentes de terceiros. A declaração organiza evidências privadas; ela não equivale a
certificado do INPI, reconhecimento de firma ou parecer jurídico.

## Integridade

Execute no PowerShell:

```powershell
Get-FileHash -Algorithm SHA256 .\evidence\oliveira-devcloud-v2.5.0-7b80cfa-source.zip
```

O resultado deve ser igual ao valor registrado em `evidence/SHA256SUMS.txt`.
