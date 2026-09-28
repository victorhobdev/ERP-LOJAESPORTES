# Evidência TDD — relatório financeiro

| Garantia | RED | GREEN |
| --- | --- | --- |
| Relatório exige `reports:read` | HTTP 404 | HTTP 401 sem sessão |
| Venda por data e caixa por recebimento não são misturados | HTTP 404 | 300,00 e 150,00 com bases explícitas |
| Pendência, custo, lucro, margem e ticket conciliam | HTTP 404 | 150,00; 160,00; 140,00; 46,67%; 150,00 |
| Estoque a custo/potencial e compra aberta conciliam | HTTP 404 | 150,00; 300,00; 60,00 |
| Ranking de produtos usa snapshot histórico da venda | HTTP 404 | 3 unidades, 300,00 em vendas e 140,00 de lucro |
| Dashboard separa eventos e estado atual | HTTP 404 | venda/caixa por datas explícitas e filas atuais |

Fixture conhecida: vendas 300,00; recebimentos 150,00; pendência 150,00; custo histórico 160,00; lucro 140,00; estoque 150,00/300,00; compra aberta 60,00.

Comando RED: `pnpm --filter @erp/api test:integration`; 29 testes anteriores PASS e 2 novos testes retornam HTTP 404.

GREEN final: 33 testes de integração PASS; 46 testes da API PASS com 87,62% statements, 80% branches, 100% functions e 91,4% lines; `pnpm check` PASS.
