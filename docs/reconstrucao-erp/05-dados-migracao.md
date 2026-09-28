# Dados e migração

## Objetivo da área

Criar um modelo de dados novo e auditável em PostgreSQL, migrando apenas registros conciliados do MySQL atual.

## Modelo-alvo

| Tabela | Responsabilidade |
| --- | --- |
| `products` | Produto lógico: clube e modelo |
| `product_variants` | Tipo, tamanho, SKU, preço e custo atual |
| `inventory_movements` | Entrada, saída, troca, ajuste e estorno |
| `customers` | Identidade e contato do cliente |
| `sales` | Cabeçalho e situação da venda |
| `sale_items` | Produto, quantidade, preço e custo históricos |
| `payments` | Um ou mais pagamentos vinculados à venda |
| `exchanges` | Evento de troca e justificativa |
| `exchange_items` | Itens devolvidos e entregues |
| `suppliers` | Fornecedores normalizados |
| `purchase_orders` | Pedido ao fornecedor |
| `purchase_order_items` | Itens e custos solicitados |
| `goods_receipts` | Recebimento físico |
| `goods_receipt_items` | Quantidades recebidas por item |
| `customer_orders` | Encomendas de clientes |
| `media` | Imagens e metadados |
| `users` | Acesso ao sistema |
| `roles` | Permissões agrupadas |
| `audit_log` | Autor, ação, entidade e instante |

## Invariantes

- Produto lógico é separado de sua variante vendável.
- Variante é única por produto, tipo e tamanho.
- Saldo não é editado sem movimento correspondente.
- Quantidades são inteiros positivos nos itens.
- Dinheiro usa `numeric`, nunca `float`.
- Registros históricos guardam preço e custo do momento.
- Exclusão física de entidade referenciada não é permitida.
- Toda tabela operacional possui `created_at`; mutáveis possuem `updated_at`.
- Datas são armazenadas com fuso definido e exibidas em `America/Sao_Paulo`.

## Mapeamento inicial

| Origem MySQL | Destino |
| --- | --- |
| `produtos` agrupado por clube/modelo | `products` |
| linha de `produtos` | `product_variants` |
| `QuantidadeEstoque` inicial | movimento `opening_balance` |
| `clientes` | `customers` |
| `vendas` | `sales` |
| `itensvenda` | `sale_items` |
| `ValorPago` e `MetodoPagamento` | `payments`, após reconciliação |
| `pedidosfornecedor` | `purchase_orders` |
| `itenspedidofornecedor` | itens e recebimentos reconstruídos |
| `encomendascliente` | `customer_orders` |
| properties e arquivos de imagem | `media` |

## Pendências que bloqueiam a migração final

- Confirmar se a base real é `gemini_erp` ou `gemini_teste`.
- Comparar schema real com `database.sql`.
- Resolver o status `Cancelado` ausente no enum do dump.
- Confirmar valores legados de tipo e tamanho.
- Definir tratamento de venda parcialmente paga.
- Identificar trocas já realizadas sem histórico explícito.
- Confirmar quais caminhos de imagem ainda existem.
- Definir clientes duplicados e o “Consumidor Final” canônico.

## Processo de migração

1. Congelar uma cópia de leitura do MySQL.
2. Gerar relatório de qualidade e contagens.
3. Criar tabelas de staging no PostgreSQL.
4. Importar dados brutos com identificador legado.
5. Normalizar e validar em staging.
6. Inserir no modelo definitivo em ordem de dependência.
7. Gerar movimentos de saldo inicial.
8. Conciliar contagens, valores e saldos.
9. Repetir o processo até ser determinístico.
10. Executar migração final com janela de corte.

## Reconciliação obrigatória

| Controle | Resultado exigido |
| --- | --- |
| Produtos e variantes | todos classificados ou rejeitados com motivo |
| Saldo por SKU | igualdade exata |
| Quantidade vendida histórica | igualdade por venda e produto |
| Total das vendas | igualdade monetária |
| Valores pendentes | igualdade por cliente e venda |
| Compras em aberto | igualdade de pedido, recebido e pendente |
| Encomendas abertas | igualdade por status |
| Imagens | vínculo válido ou pendência explícita |

## Critérios de aceite

- A migração pode ser executada novamente sem duplicar dados.
- Todo registro rejeitado aparece em relatório com causa.
- IDs antigos permanecem rastreáveis em campo de referência.
- Saldos e valores conciliam exatamente.
- Nenhum dado de produção é alterado pelo processo de leitura.
- Backup e restauração do PostgreSQL foram testados.
