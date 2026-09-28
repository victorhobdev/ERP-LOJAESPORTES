# Backend e API

## Objetivo da área

Centralizar regras de negócio, transações, autorização e acesso ao PostgreSQL em uma API Fastify escrita em TypeScript.

## Organização mínima

```text
apps/api/src/
  modules/
    auth/
    dashboard/
    products/
    inventory/
    sales/
    purchases/
    customer-orders/
    reports/
    catalog/
  shared/
    db/
    errors/
    auth/
    http/
```

Cada módulo pode conter rota, schema, serviço e consulta. Não criar repository, factory ou interface quando houver apenas uma implementação.

## Endpoints por área

### Dashboard

- `GET /dashboard?from&to`

### Produtos e estoque

- `GET /products`
- `GET /products/:id`
- `POST /products`
- `PATCH /products/:id`
- `GET /inventory`
- `GET /inventory/movements`
- `POST /inventory/movements`

### Vendas

- `GET /sales`
- `POST /sales`
- `GET /sales/:id`
- `POST /sales/:id/payments`
- `POST /sales/:id/exchanges`

### Compras

- `GET /purchase-orders`
- `POST /purchase-orders`
- `GET /purchase-orders/:id`
- `POST /purchase-orders/:id/receipts`
- `POST /purchase-orders/:id/cancel`

### Encomendas de clientes

- `GET /customer-orders`
- `POST /customer-orders`
- `GET /customer-orders/:id`
- `PATCH /customer-orders/:id/status`

### Relatórios e catálogo

- `GET /reports/financial`
- `GET /reports/products`
- `GET /catalog`
- `POST /catalog/images`
- `POST /catalog/sync`

## Agregação para as telas

O endpoint deve entregar a composição necessária para a tela sem obrigar o frontend a fazer várias consultas dependentes. Isso vale especialmente para:

- dashboard;
- detalhe da venda;
- detalhe e recebimento de compra;
- visão agregada do estoque;
- relatórios.

Não criar GraphQL para resolver esse problema. Endpoints REST orientados às operações atuais são suficientes.

## Transações obrigatórias

- Criar venda, itens, pagamentos e movimentos de saída.
- Registrar pagamento posterior e atualizar situação da venda.
- Trocar item, devolver saldo antigo e retirar saldo novo.
- Registrar recebimento, atualizar compra, custo e estoque.
- Registrar ajuste de estoque com motivo e auditoria.
- Migrar cada lote de dados com checkpoint consistente.

## Concorrência

- Bloquear ou atualizar condicionalmente a variante durante baixa de estoque.
- Rejeitar saldo insuficiente sem criar venda parcial.
- Usar versão ou condição para evitar sobrescrita silenciosa.
- Usar idempotency key em operações financeiras e de estoque.
- Nunca confiar no total calculado pelo frontend; recalcular na API.

## Segurança da API

- Toda query SQL é parametrizada; entrada nunca é concatenada ao SQL.
- Schemas usam listas permitidas e limites explícitos.
- Sessões em cookie `HttpOnly`, `Secure` e `SameSite` adequado.
- Requisições mutáveis autenticadas recebem proteção CSRF.
- CORS aceita somente origens conhecidas.
- Rate limit é mais restritivo em login, upload, busca cara e sincronização.
- Upload valida tamanho, MIME, extensão e conteúdo antes de persistir.
- Cabeçalhos de segurança incluem CSP restritiva e bloqueio de framing.

## Resposta de erro

```json
{
  "code": "INSUFFICIENT_STOCK",
  "message": "Estoque insuficiente para concluir a venda.",
  "fieldErrors": null,
  "requestId": "...",
  "details": {
    "variantId": "...",
    "available": 1,
    "requested": 2
  }
}
```

Mensagens internas, SQL e stack trace nunca são enviados ao usuário.

## Testes

- Integração com banco real isolado por teste.
- Testes de transação e rollback.
- Concorrência de baixa do mesmo SKU.
- Idempotência de venda e recebimento.
- Autorização por ação.
- Contrato OpenAPI validado no CI.

## Critérios de aceite

- Interface não acessa PostgreSQL diretamente.
- Toda entrada externa é validada.
- Toda alteração crítica gera auditoria.
- Falha no meio de uma operação não deixa dados parciais.
- Totais de venda e compra são calculados no servidor.
- Endpoints de lista possuem filtros, ordenação e paginação limitados.
- Operações críticas são idempotentes e testadas.
- Queries parametrizadas, CSRF, CORS e rate limits possuem testes de integração.
