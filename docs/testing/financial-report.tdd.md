# Evidência TDD — relatório financeiro

| Garantia | RED | GREEN |
| --- | --- | --- |
| Relatório exige `reports:read` | HTTP 404 | Pendente |
| Venda por data e caixa por recebimento não são misturados | HTTP 404 | Pendente |
| Pendência, custo, lucro, margem e ticket conciliam | HTTP 404 | Pendente |
| Estoque a custo/potencial e compra aberta conciliam | HTTP 404 | Pendente |

Fixture conhecida: vendas 300,00; recebimentos 150,00; pendência 150,00; custo histórico 160,00; lucro 140,00; estoque 150,00/300,00; compra aberta 60,00.

Comando RED: `pnpm --filter @erp/api test:integration`; 29 testes anteriores PASS e 2 novos testes retornam HTTP 404.
