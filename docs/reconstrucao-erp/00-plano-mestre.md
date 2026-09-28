# Plano mestre — reconstrução do ERP

## Objetivo

Reconstruir o ERP do zero, com nova interface, nova arquitetura e nova modelagem técnica, preservando somente os dados válidos e as regras de negócio confirmadas da operação da loja.

## Limites da reconstrução

Não será reaproveitado:

- código Java, JavaFX, FXML ou CSS;
- controllers e consultas SQL existentes;
- componentes visuais, layout ou navegação atual;
- estrutura de pacotes e processo de build atual;
- schema MySQL como desenho definitivo do sistema novo.

Será preservado por migração ou reespecificação:

- cadastro e saldo válido dos produtos;
- clientes, vendas, pedidos e encomendas que forem conciliados;
- imagens que tiverem vínculo confirmado;
- regras operacionais aprovadas pelo responsável da loja;
- histórico necessário para continuidade da operação.

## Diagnóstico resumido

O ERP atual cobre o domínio básico, mas mistura apresentação, regra de negócio e acesso ao banco nos controllers JavaFX. A reconstrução deve separar essas responsabilidades e transformar a navegação em um produto coerente, não apenas trocar a tecnologia visual.

Acertos estruturais que orientam o sistema novo:

- produto vendável identificado por clube, modelo, tipo e tamanho;
- venda e baixa de estoque executadas em uma transação;
- custo histórico registrado nos itens vendidos;
- suporte a recebimento parcial de compras;
- separação conceitual entre compra de fornecedor e encomenda de cliente;
- dashboard e relatórios baseados em dados operacionais reais.

Lacunas que precisam ser resolvidas no sistema novo:

- ausência de API entre interface e banco;
- ausência de usuários, permissões e auditoria;
- ausência de um livro de movimentações de estoque;
- troca de venda sem entidade de histórico própria;
- pagamentos representados de forma limitada;
- status de pedido divergente entre código e schema;
- imagens mantidas fora do cadastro relacional principal;
- telas com conceitos próximos e nomes ambíguos.

## Arquitetura-alvo

```text
PWA React/TypeScript
        |
        v
API REST Fastify/TypeScript
        |
        v
PostgreSQL + armazenamento de imagens
```

O Tauri será considerado somente como embalagem opcional da PWA quando houver requisito comprovado de integração nativa com Windows.

## Stack de referência

| Camada | Escolha |
| --- | --- |
| Interface | React 19 + TypeScript + Vite |
| Rotas | TanStack Router |
| Dados remotos | TanStack Query |
| Tabelas | TanStack Table |
| Formulários | React Hook Form + Zod |
| Visual | Tailwind CSS + Radix Primitives + tokens próprios |
| API | Fastify + TypeScript |
| Banco | PostgreSQL |
| Testes | Vitest + Testing Library + Playwright |
| Distribuição | PWA; Tauri somente se necessário |

## Documentos por área

1. [Produto, UX e navegação](01-produto-ux-navegacao.md)
2. [Design visual e componentes](02-design-visual.md)
3. [Arquitetura de frontend](03-frontend.md)
4. [Backend e API](04-backend-api.md)
5. [Dados e migração](05-dados-migracao.md)
6. [Vendas e clientes](06-vendas-clientes.md)
7. [Estoque e catálogo](07-estoque-catalogo.md)
8. [Compras e encomendas](08-compras-encomendas.md)
9. [Financeiro e relatórios](09-financeiro-relatorios.md)
10. [Segurança, implantação e operação](10-seguranca-operacao.md)
11. [Roadmap, validação e entrada em produção](11-roadmap-validacao.md)

## Regras globais de produto

- Toda alteração financeira ou de estoque deve ser transacional e auditável.
- A interface nunca acessa o banco diretamente.
- Saldo de estoque nunca pode ficar negativo.
- Valores monetários não usam ponto flutuante.
- Todo fluxo deve prever carregamento, vazio, erro recuperável e sucesso.
- Ações destrutivas exigem confirmação e justificativa quando afetam histórico.
- Relatórios não podem prometer informação que o modelo de dados não sustenta.
- O sistema deve ser eficiente em 1366 × 768 e utilizável por teclado.

## Critério global de conclusão

A reconstrução só pode substituir o ERP atual quando:

- todos os fluxos críticos tiverem testes automatizados;
- produtos, saldos, vendas em aberto e pedidos forem conciliados;
- backup e restauração forem executados em ambiente de homologação;
- a operação paralela não apresentar divergência crítica;
- o responsável pela loja aprovar PDV, estoque, recebimento e financeiro;
- houver procedimento documentado de retorno ao sistema antigo durante o corte.

## Próximos refinamentos seguros

Antes de iniciar código, confirmar o banco de produção, observar os fluxos reais no balcão e aprovar os protótipos das quatro telas críticas: PDV, estoque, compra e recebimento. Essas decisões podem alterar detalhes dos documentos de área sem comprometer a arquitetura principal.
