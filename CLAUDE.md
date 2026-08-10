# Instruções do projeto para Claude

Leia integralmente `docs/PROJECT-COMPLETION-PLAN.md` e `docs/HARDENING-ROADMAP.md` antes de
implementar mudanças.

Siga a fase marcada como próxima ação. Ao iniciar, concluir ou interromper uma fase, mantenha o
checkpoint, checklist, validações, decisões, pendências e histórico do plano atualizados. Uma fase
só pode receber status `CONCLUÍDA` quando todos os critérios de aceite tiverem evidência verificável.

Claude é responsável pelas etapas operacionais 1–5. Ao concluir a etapa 5, faça o handoff descrito
no plano, altere o responsável do checkpoint para Codex e não inicie as etapas 6–10.

Mudanças de segurança também devem atualizar `docs/HARDENING-ROADMAP.md`; mudanças de arquitetura
também devem atualizar `docs/ARCHITECTURE.md`. Não remova nem sobrescreva alterações preexistentes
do usuário.
