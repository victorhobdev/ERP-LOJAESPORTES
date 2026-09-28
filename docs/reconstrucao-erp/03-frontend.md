# Arquitetura de frontend

## Objetivo da área

Construir a aplicação visual em React e TypeScript, consumindo exclusivamente a API e mantendo separação clara entre rotas, funcionalidades e componentes visuais.

## Stack

- React 19.
- TypeScript com modo estrito.
- Vite.
- TanStack Router.
- TanStack Query.
- TanStack Table.
- React Hook Form + Zod.
- Tailwind CSS.
- Radix Primitives.
- Vitest, Testing Library e Playwright.

Redux, SSR, Server Components e microfrontends ficam fora do escopo inicial. O ERP não possui necessidade de SEO e o estado relevante está no servidor ou na URL.

## Estrutura mínima

```text
apps/web/src/
  app/
    router/
    providers/
    shell/
  features/
    dashboard/
    sales/
    inventory/
    purchases/
    customer-orders/
    reports/
    catalog/
    settings/
  components/
    ui/
  lib/
    api/
    formatting/
    validation/
```

Regras:

- uma feature não importa internals de outra;
- componentes de domínio permanecem dentro da feature;
- `components/ui` contém apenas elementos realmente compartilhados;
- chamadas HTTP ficam centralizadas em `lib/api` ou no módulo da feature;
- valores monetários chegam como string decimal ou inteiro em centavos;
- datas trafegam em ISO 8601 e são formatadas na borda da UI.

## Estado

| Tipo | Local correto |
| --- | --- |
| Dados da API | TanStack Query |
| Filtros compartilháveis | URL |
| Formulário | React Hook Form |
| Estado efêmero de componente | `useState` |
| Sessão e permissões | provider de autenticação |
| Carrinho da venda | estado local da rota com proteção de saída |

Não duplicar dados da API em store global.

## Contrato com a API

- Cliente gerado ou tipado a partir do contrato OpenAPI.
- Erro padronizado com `code`, `message`, `fieldErrors` e `requestId`.
- Mutations invalidam apenas queries relacionadas.
- Formulários permanecem preenchidos quando a API rejeitar a operação.
- Respostas de listas incluem paginação e totais necessários à tela.
- Atualizações otimistas não serão usadas em dinheiro ou estoque.

## Proteções de UX

- Aviso ao abandonar venda ou pedido com itens não salvos.
- Botão de submissão bloqueado durante a mesma requisição.
- Idempotency key em finalização de venda e recebimento.
- Busca de produto com debounce curto e cancelamento da requisição anterior.
- Erro de concorrência informa o novo saldo e pede revisão do carrinho.

## Testes

### Unitários

- formatação monetária e de datas;
- validações de formulários;
- cálculos apenas de apresentação;
- reducers locais, se existirem.

### Componentes

- VariantPicker;
- carrinho do PDV;
- filtros e paginação;
- estados vazio, loading e erro;
- permissões de ações.

### E2E

- venda paga;
- venda pendente;
- pagamento posterior;
- troca;
- entrada e ajuste de estoque;
- compra e recebimento parcial;
- encomenda até entrega.

## Critérios de aceite

- Nenhum componente executa SQL ou conhece detalhes do banco.
- Nenhuma regra crítica existe somente no navegador.
- Rotas possuem tratamento de loading, vazio e erro.
- Testes E2E cobrem os fluxos críticos.
- Bundle inicial não carrega módulos de relatório ou catálogo antes do uso.
- Navegação e PDV funcionam por teclado.
- Não há dependência global de estado sem justificativa comprovada.
