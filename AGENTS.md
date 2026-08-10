# Instruções permanentes para agentes

Antes de alterar este repositório, leia `docs/PROJECT-COMPLETION-PLAN.md` e
`docs/HARDENING-ROADMAP.md`.

Ao trabalhar em qualquer fase do plano:

1. Atualize o checkpoint do plano para `EM ANDAMENTO` antes da implementação.
2. Trabalhe apenas no escopo e nos critérios de aceite definidos para a fase ativa. Respeite também
   o responsável definido na tabela: Claude executa as etapas 1–5 e Codex executa as etapas 6–10.
   Revisão não autoriza refazer trabalho do outro agente sem defeito verificável.
3. Não marque uma fase como concluída sem registrar comandos, resultados e evidências verificáveis.
4. Ao concluir ou interromper a sessão, atualize obrigatoriamente no plano:
   - status da fase;
   - tarefas concluídas e pendentes;
   - validações executadas;
   - riscos ou decisões encontrados;
   - próxima ação única;
   - histórico de atualizações.
5. Atualize `docs/HARDENING-ROADMAP.md` quando um risco de segurança mudar de estado.
6. Atualize `docs/ARCHITECTURE.md` quando uma fronteira, serviço ou fluxo arquitetural mudar.
7. Preserve alterações preexistentes do usuário e relate testes impossíveis de executar.

O plano operacional é a fonte de verdade para retomada entre sessões. O roadmap de hardening
continua sendo a fonte detalhada para riscos e evidências de segurança.
