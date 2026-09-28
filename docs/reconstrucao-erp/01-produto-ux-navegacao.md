# Produto, UX e navegação

## Objetivo da área

Redesenhar o ERP como uma ferramenta operacional previsível, rápida e orientada a tarefas. A prioridade é reduzir cliques, ambiguidades e interrupções no balcão.

## Usuários principais

| Perfil | Necessidade principal |
| --- | --- |
| Operador de venda | Encontrar produto, conferir tamanho e finalizar rapidamente |
| Responsável pelo estoque | Registrar entrada, ajuste e acompanhar disponibilidade |
| Comprador | Criar pedido e registrar recebimentos parciais |
| Gestor | Acompanhar pendências, financeiro e desempenho |

Os perfis não justificam quatro aplicações. O mesmo produto muda ações e visibilidade conforme a permissão.

## Organização proposta

```text
Início
Vendas
Estoque
Compras
Encomendas
Relatórios
Catálogo
Configurações
```

Princípios:

- “Compras” sempre significa pedido a fornecedor.
- “Encomendas” sempre significa solicitação de cliente.
- “Vendas” concentra lista, detalhe, pagamento e troca.
- “Estoque” concentra produto, variante, entrada e ajuste.
- O dashboard não repete o menu; mostra pendências e tendências.

## Mapa final de rotas

| Rota | Função |
| --- | --- |
| `/inicio` | KPIs, alertas e fila de trabalho |
| `/vendas` | Histórico pesquisável de vendas |
| `/vendas/nova` | PDV |
| `/vendas/:vendaId` | Detalhe, pagamento e troca |
| `/estoque` | Produtos, variantes e saldos |
| `/estoque/produtos/:produtoId` | Detalhe do produto e movimentos |
| `/estoque/entrada` | Entrada ou ajuste autorizado |
| `/compras` | Pedidos a fornecedores |
| `/compras/nova` | Criação de pedido |
| `/compras/:pedidoId` | Detalhe e recebimento |
| `/encomendas` | Solicitações de clientes |
| `/encomendas/:encomendaId` | Detalhe e mudança de estado |
| `/relatorios/financeiro` | Indicadores financeiros |
| `/relatorios/produtos` | Vendas e estoque por produto |
| `/catalogo` | Imagens e publicação do catálogo |
| `/configuracoes` | Usuários, permissões e integrações |

## Estrutura do shell

- Sidebar recolhível com as áreas principais.
- Barra superior com busca global, usuário e estado de sincronização.
- Breadcrumb somente em páginas de detalhe.
- Ação primária única no cabeçalho de cada página.
- Filtros persistidos na URL para listas e relatórios.
- Command palette opcional apenas depois de validar atalhos reais.

## Dados mínimos por tela

| Tela | Dados mínimos | Filtros |
| --- | --- | --- |
| Início | KPIs, estoque baixo, pagamentos vencidos, compras pendentes | período |
| Vendas | id, data, cliente, total, pago, status | período, cliente, status |
| Estoque | produto, tipo, tamanho, saldo, preço, custo | busca, clube, tipo, disponibilidade |
| Compras | fornecedor, data, custo, recebido, pendente, status | período, fornecedor, status |
| Encomendas | cliente, item, tamanho, data, status | busca, período, status |
| Financeiro | receita, custo, lucro, margem e ticket | período e comparação |
| Produtos | vendidos, saldo e participação | período, clube, tipo, tamanho |

## Cobertura atual e dependências bloqueadoras

| Área | Cobertura atual | Dependência de API/BFF |
| --- | --- | --- |
| Início | parcial | agregação `GET /dashboard` com tendências e pendências |
| Vendas | boa para o fluxo básico | busca de variantes e transação `POST /sales` |
| Detalhe da venda | parcial | composição de itens, pagamentos, trocas e timeline |
| Estoque | boa para saldo atual | consulta agregada e livro de movimentos novo |
| Compras | boa, com divergência de status | detalhe composto e recebimento idempotente |
| Encomendas | parcial | timeline e associação opcional a produto/compra |
| Financeiro | parcial | fórmulas aprovadas e agregação por período |
| Produtos | boa para indicadores atuais | filtros e drill-down no servidor |
| Catálogo | parcial | mídia persistida e estado de sincronização |
| Configurações | ausente | autenticação, usuários, papéis e integrações |

## Estados obrigatórios

Cada rota deve definir:

- skeleton compatível com a estrutura da tela;
- vazio inicial com explicação e ação possível;
- vazio causado por filtro com ação “limpar filtros”;
- erro de leitura com tentativa novamente;
- erro de gravação preservando o formulário;
- confirmação não bloqueante após sucesso;
- aviso de dados possivelmente desatualizados quando aplicável.

## Critérios de aceite

- Não há rota órfã ou ação que leve a tela sem retorno previsível.
- É possível iniciar nova venda em uma ação a partir de qualquer área.
- Pagamento e troca são encontrados no detalhe da venda.
- Recebimento é encontrado no detalhe da compra.
- Nenhum item principal da sidebar duplica outro conceito.
- Todos os filtros relevantes podem ser compartilhados pela URL.
- Os fluxos críticos funcionam integralmente por teclado.
