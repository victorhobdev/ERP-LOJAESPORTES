# Migração de conferência `gemini_teste` — 2026-09-05

## Escopo

Uma operação dedicada, executada somente em `erp2_homolog_test`, para:

- ajustar os cinco saldos pós-dump com precondição de saldo atual;
- encerrar administrativamente os pedidos legados com pendência, sem recibo ou movimento físico;
- criar os dois novos pedidos Kakaric, reutilizando as variantes correspondentes e criando os cinco modelos novos;
- produzir relatório de dry-run e permitir replay sem duplicação.

## Operação

O runner usa dry-run por padrão. O dry-run é somente leitura e informa estado atual, mapeamentos, conflitos e efeito esperado. O modo `--apply` exige o banco exato `erp2_homolog_test`, valida todos os pré-estados e executa tudo em uma única transação.

Os ajustes de estoque são `manual_adjustment` de reconciliação, auditados e sem alteração de custo. O fechamento legado altera apenas recebido/pendente/status e registra justificativa no `audit_log`; não cria `goods_receipts` nem novos movimentos. Os pedidos Kakaric são criados como `placed`, sem recebimento, para que o estoque só mude pelo fluxo normal de recebimento.

## Idempotência e validação

IDs, SKUs e chaves da operação são determinísticos. Uma execução concluída é registrada em `migration_runs`; uma repetição retorna o relatório reutilizado. O runner aborta se houver saldo diferente do esperado, pedidos legados pendentes fora do escopo ou mapeamento não unívoco.

Mapeamentos aprovados para o primeiro pedido:

- `BRASIL AZUL 2026` → `BRASIL/AZUL`;
- `BRASIL GOLEIRO` → `BRASIL/GOLEIRO`;
- `BRASIL AMARELA 2026` → `BRASIL/AMARELA`.

Datas: primeiro pedido em `2026-08-16`; segundo em `2026-08-28`.

## Verificação

Testes de integração cobrem dry-run sem escrita, precondições, ajustes, encerramento sem recibo, criação/totais dos pedidos, modelos novos e replay idempotente. A execução desta tarefa termina com o dry-run; `--apply` fica disponível somente para aprovação posterior.
