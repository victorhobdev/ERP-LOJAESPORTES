# Financeiro e relatórios

## Objetivo da área

Entregar indicadores gerenciais confiáveis sobre vendas, custos, estoque e compras, deixando explícito que o módulo não substitui contabilidade fiscal.

## Rotas

- `/relatorios/financeiro`
- `/relatorios/produtos`

O início apresenta um resumo; análises completas permanecem nestas rotas.

## Definições obrigatórias

| Indicador | Definição |
| --- | --- |
| Faturamento | soma do valor final das vendas conforme regime definido |
| Recebido | soma dos pagamentos confirmados no período |
| Pendente | total da venda menos pagamentos e estornos |
| Custo dos produtos | custo histórico dos itens vendidos |
| Lucro bruto | faturamento reconhecido menos custo dos produtos |
| Margem bruta | lucro bruto dividido pelo faturamento reconhecido |
| Ticket médio | faturamento dividido pelo número de vendas consideradas |
| Valor do estoque a custo | saldo × custo atual da variante |
| Valor potencial do estoque | saldo × preço atual, exibido separadamente |
| Capital em compras | custo pendente de recebimento |

Antes da implementação, deve ser decidido se “faturamento” usa data da venda ou data do recebimento. A interface não pode misturar os dois regimes.

## Relatório financeiro

Dados:

- período atual e anterior comparável;
- receita, recebido e pendente;
- custo e lucro bruto;
- margem e ticket;
- série temporal;
- vendas por método de pagamento;
- contas pendentes e vencidas;
- valor do estoque e compras em aberto.

API:

- `GET /reports/financial?from&to&compare=true`

## Relatório de produtos

Dados:

- quantidade vendida;
- receita e lucro por produto;
- clube, tipo e tamanho mais vendidos;
- saldo por variante;
- produtos sem giro;
- produtos com estoque baixo;
- participação por clube e tipo.

API:

- `GET /reports/products?from&to&club&type&size`

## Visualização

- KPIs mostram valor, comparação e definição acessível.
- Gráficos usam no máximo as séries necessárias.
- Tabela detalhada acompanha todo gráfico importante.
- Cores mantêm o mesmo significado em todas as telas.
- Escalas não truncam valores de forma enganosa.
- Exportação entra somente depois da validação dos relatórios em tela.

## Cobertura e limites

O banco atual sustenta vendas, custos históricos básicos e saldos. Não sustenta com qualidade suficiente:

- fluxo de caixa completo;
- despesas operacionais;
- impostos;
- conciliação bancária;
- demonstrativo contábil;
- histórico completo de pagamentos múltiplos;
- inventário auditável retroativo.

Esses itens não devem aparecer como funcionalidades implícitas da primeira versão.

## Critérios de aceite

- Cada KPI possui fórmula documentada e teste com conjunto conhecido.
- Totais do relatório conciliam com vendas e pagamentos de origem.
- Alterar período atualiza todos os componentes da tela.
- Estado sem dados não exibe gráfico vazio enganoso.
- Usuário consegue chegar do agregado ao registro detalhado.
- Relatório deixa claro data de atualização e regime usado.
