# Evidência TDD — relatório financeiro

| Garantia | RED | GREEN |
| --- | --- | --- |
| Relatório exige `reports:read` | HTTP 404 | HTTP 401 sem sessão |
| Venda por data e caixa por recebimento não são misturados | HTTP 404 | 300,00 e 150,00 com bases explícitas |
| Pendência, custo, lucro, margem e ticket conciliam | HTTP 404 | 150,00; 160,00; 140,00; 46,67%; 150,00 |
| Estoque a custo/potencial e compra aberta conciliam | HTTP 404 | 150,00; 300,00; 60,00 |

Fixture conhecida: vendas 300,00; recebimentos 150,00; pendência 150,00; custo histórico 160,00; lucro 140,00; estoque 150,00/300,00; compra aberta 60,00.

Comando RED: `pnpm --filter @erp/api test:integration`; 29 testes anteriores PASS e 2 novos testes retornam HTTP 404.

GREEN: 31 testes de integração PASS; 44 testes da API PASS com 87,57% statements, 80,21% branches, 100% functions e 91,05% lines; `pnpm check` PASS.
