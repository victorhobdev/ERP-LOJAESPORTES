# Evidência TDD — produtos e estoque

## Garantias

| Garantia | Teste | RED | GREEN |
| --- | --- | --- | --- |
| Produtos exigem autenticação | `inventory.integration.test.ts` | Rota ausente, HTTP 404 | Pendente |
| Produto lógico cria variantes com saldo zero | `inventory.integration.test.ts` | Rota ausente, HTTP 404 | Pendente |
| Chave de negócio duplicada retorna conflito | `inventory.integration.test.ts` | Rota ausente, HTTP 404 | Pendente |
| Ajuste exige sessão/CSRF/motivo e gera auditoria | `inventory.integration.test.ts` | Rota ausente, HTTP 404 | Pendente |
| Repetição idempotente não duplica movimento | `inventory.integration.test.ts` | Rota ausente, HTTP 404 | Pendente |
| Mesma chave com payload diferente é rejeitada | `inventory.integration.test.ts` | Rota ausente, HTTP 404 | Pendente |
| Saída maior que saldo não altera estoque | `inventory.integration.test.ts` | Rota ausente, HTTP 404 | Pendente |
| Duas saídas concorrentes não deixam saldo negativo | `inventory.integration.test.ts` | Duas respostas HTTP 404 | Pendente |

Todos os dados são fixtures sintéticas dentro de schema PostgreSQL descartável.

Comando RED: suíte de integração com `TEST_DATABASE_URL`; 4 testes do novo módulo falharam exclusivamente por rotas ausentes, enquanto os 7 testes anteriores de banco/autenticação permaneceram verdes.
