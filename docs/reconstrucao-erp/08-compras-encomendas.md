# Compras e encomendas

## Objetivo da área

Separar claramente a reposição feita com fornecedores das solicitações feitas por clientes, mantendo ligação entre elas somente quando houver regra explícita.

## Compras a fornecedores

### Rotas

- `/compras`
- `/compras/nova`
- `/compras/:pedidoId`

### Estados

- rascunho;
- realizado;
- recebido parcialmente;
- recebido integralmente;
- cancelado.

A lista oficial precisa ser confirmada antes da migração porque o código atual usa “Cancelado”, mas o enum do dump não o contém.

### Fluxo

1. Identificar fornecedor e data.
2. Adicionar produtos ou criar variantes ainda não cadastradas.
3. Informar quantidade e custo estimado.
4. Revisar e realizar o pedido.
5. Registrar um ou mais recebimentos.
6. Atualizar custo e estoque de forma transacional.
7. Encerrar automaticamente quando tudo for recebido.

### API

- `GET /purchase-orders`
- `POST /purchase-orders`
- `GET /purchase-orders/:id`
- `POST /purchase-orders/:id/receipts`
- `POST /purchase-orders/:id/cancel`

### Regras

- Recebido nunca excede o pedido sem ajuste explícito.
- Recebimento não pode ser editado silenciosamente; correção usa estorno.
- Custo final é calculado pela API.
- Cancelamento não é permitido depois de recebimento sem fluxo de reversão.
- Cada recebimento gera movimentos de estoque rastreáveis.

## Encomendas de clientes

### Rotas

- `/encomendas`
- `/encomendas/:encomendaId`

### Estados

- pendente;
- pedido ao fornecedor feito;
- produto chegou;
- entregue ao cliente;
- cancelada.

### Dados mínimos

- cliente e contato;
- clube, modelo, tipo e tamanho;
- produto/variante associados quando existirem;
- observação;
- datas e timeline de status;
- compra associada quando aplicável;
- operador responsável.

### API

- `GET /customer-orders`
- `POST /customer-orders`
- `GET /customer-orders/:id`
- `PATCH /customer-orders/:id/status`

### Regras

- Encomenda pode começar como descrição livre.
- Associação a produto é opcional até o item ser identificado.
- Mudança de status cria evento de histórico.
- Entrega não baixa estoque novamente se a venda já realizou a baixa.
- Cancelamento exige motivo.
- Criar encomenda não cria automaticamente uma compra.

## UX compartilhada

- Compras usam timeline de pedido e recebimentos.
- Encomendas usam timeline de relacionamento com o cliente.
- Listas destacam pendências, não apenas status concluídos.
- Tela de detalhe concentra ações possíveis para o estado atual.
- Ação impossível explica o motivo em vez de desaparecer sem contexto.

## Critérios de aceite

- Usuário distingue compra de encomenda pelo nome e navegação.
- Recebimento parcial mantém quantidades corretas.
- Recebimento repetido com a mesma chave não duplica estoque.
- Encomenda mantém histórico de todas as mudanças de estado.
- Nenhum fluxo promete chegada ou reserva sem dado que a sustente.
