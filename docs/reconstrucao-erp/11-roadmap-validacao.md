# Roadmap, validação e entrada em produção

## Objetivo da área

Executar a reconstrução em blocos verificáveis, preservando o ERP atual até que o sistema novo prove equivalência operacional.

## Dependências

```text
Descoberta e regras
        |
        +--> UX e design system
        |
        +--> modelo de dados
                 |
                 v
             API base
                 |
        +--------+---------+
        |                  |
     Estoque            Vendas
        |                  |
     Compras --------> Relatórios
        |
    Encomendas
        |
    Catálogo
```

## Bloco 0 — descoberta

Entregas:

- regras atuais documentadas;
- banco real inspecionado;
- divergências do dump resolvidas;
- requisitos de offline, dispositivos e múltiplos usuários decididos;
- métricas financeiras definidas.

Gate: responsável pela loja aprova as regras antes de construir fluxos críticos.

## Bloco 1 — experiência e fundação

Entregas:

- protótipos de Início, PDV, Estoque e Compra;
- teste de usabilidade;
- tokens e componentes essenciais;
- monorepo com web, API e contratos;
- autenticação inicial;
- CI com lint, tipos e testes.

Gate: protótipos aprovados em 1366 × 768 e por teclado.

## Bloco 2 — dados e estoque

Entregas:

- schema PostgreSQL;
- produtos e variantes;
- movimentos de estoque;
- cadastro, entrada e ajuste;
- primeira versão do migrador;
- reconciliação de saldo.

Gate: todo saldo de homologação é explicado por movimentos.

## Bloco 3 — vendas

Entregas:

- PDV;
- venda paga e pendente;
- pagamentos posteriores;
- histórico e detalhe;
- troca auditável;
- testes de concorrência e idempotência.

Gate: cenários de venda não geram estoque negativo nem duplicidade.

## Bloco 4 — compras e encomendas

Entregas:

- fornecedores e compras;
- recebimento parcial e integral;
- atualização de custo e saldo;
- encomendas e timeline de status;
- associação opcional entre encomenda e compra.

Gate: pedido, recebido e pendente conciliam por item.

## Bloco 5 — financeiro, catálogo e operação

Entregas:

- relatórios financeiros e de produtos;
- dashboard;
- imagens e sincronização de catálogo;
- perfis finais e auditoria;
- backup, restauração e monitoramento;
- documentação operacional.

Gate: indicadores conciliam com as entidades de origem.

## Bloco 6 — migração e corte

1. Executar migração completa em homologação.
2. Corrigir rejeições e repetir até obter resultado determinístico.
3. Treinar usuários.
4. Operar os sistemas em paralelo por período definido.
5. Comparar diariamente vendas, saldos, pendências e compras.
6. Congelar escrita no sistema antigo durante a janela final.
7. Executar migração incremental/final.
8. Validar checklist de corte.
9. Liberar o novo sistema.
10. Manter o antigo somente para consulta durante a retenção acordada.

## Checklist de corte

- [ ] Backup final do MySQL testado.
- [ ] Backup inicial do PostgreSQL testado.
- [ ] Contagem de produtos e variantes conciliada.
- [ ] Saldo por SKU conciliado.
- [ ] Vendas e pagamentos pendentes conciliados.
- [ ] Compras e recebimentos pendentes conciliados.
- [ ] Encomendas abertas conciliadas.
- [ ] Usuários e permissões confirmados.
- [ ] Impressão, catálogo ou dispositivos necessários validados.
- [ ] Procedimento de rollback disponível.
- [ ] Responsável da loja aprovou o corte.

## Definição de pronto por funcionalidade

- regra de negócio documentada;
- contrato da API definido;
- validação no servidor;
- autorização aplicada;
- estados de loading, vazio, erro e sucesso;
- acessibilidade básica verificada;
- teste unitário ou de integração proporcional ao risco;
- E2E quando fizer parte de fluxo crítico;
- auditoria quando alterar dinheiro, estoque ou permissão;
- documentação atualizada.

## Rollback

O rollback não mistura escrita entre bases. Se o corte falhar:

1. interromper escrita no sistema novo;
2. exportar e conferir operações realizadas após o corte;
3. restaurar a operação antiga somente após reconciliar essas operações;
4. registrar causa e evidência da falha;
5. repetir o corte apenas após correção e novo ensaio.

## Conclusão do projeto

O projeto termina quando o sistema novo opera sozinho, os dados conciliam, usuários foram treinados, backup/restauração funcionam e o sistema antigo deixou de ser necessário para qualquer fluxo operacional.
