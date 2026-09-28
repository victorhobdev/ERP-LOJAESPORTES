# Design visual e componentes

## Objetivo da área

Criar uma identidade visual própria para um ERP de varejo esportivo: profissional, rápida e densa o suficiente para operação diária, sem aparência de template administrativo genérico.

## Direção visual

- Fundo neutro levemente quente.
- Superfícies claras com borda sutil e pouca sombra.
- Azul profundo como cor de marca.
- Verde apenas para sucesso e disponibilidade.
- Âmbar para atenção e pendência.
- Vermelho para erro, risco ou ação destrutiva.
- Tipografia Geist ou Inter.
- Ícones Lucide com tamanho e espessura padronizados.
- Raio de borda entre 10 e 14 px.
- Alta legibilidade de números, datas e valores monetários.

## Tokens iniciais

Os valores finais serão definidos em protótipo, mas devem existir como tokens desde o primeiro componente:

```text
color.background
color.surface
color.surface-muted
color.border
color.text
color.text-muted
color.brand
color.success
color.warning
color.danger

space.1 ... space.8
radius.control
radius.card
shadow.overlay
font.body
font.mono-numeric
```

Não criar temas múltiplos na primeira fase. Tema escuro entra apenas com demanda comprovada.

## Hierarquia de componentes

### Fundação

- Button
- IconButton
- Input, CurrencyInput e QuantityInput
- Select e Combobox
- Checkbox, Radio e Switch
- Badge
- Tooltip
- Dialog e AlertDialog
- Drawer
- Toast
- Skeleton
- EmptyState
- InlineError

### Composição operacional

- PageHeader
- FilterBar
- DataTable
- SummaryCard
- StatusBadge
- ProductSearch
- VariantPicker
- MoneySummary
- Timeline
- StockIndicator
- ConfirmAction

Não criar componentes genéricos sem um segundo uso real.

## Tabelas

- Cabeçalho fixo e paginação no servidor.
- Colunas numéricas alinhadas à direita.
- Primeira coluna fixável somente em tabelas largas.
- Densidade padrão compacta; modo confortável não é prioridade inicial.
- Ações de linha em menu, mantendo visível apenas a ação principal.
- Seleção múltipla somente onde existir ação em lote real.
- Estado vazio dentro da própria tabela.
- Não depender apenas de cor para comunicar status.

## Movimento

- Pressão de botão: 100–160 ms.
- Tooltip e popover: 125–200 ms.
- Dialog e drawer: 180–250 ms.
- Entrada com `opacity` e escala mínima, nunca `scale(0)`.
- Popover se origina do gatilho; modal permanece centralizado.
- Atalhos de teclado não recebem animação.
- Respeitar `prefers-reduced-motion`.
- Animar somente `transform` e `opacity` sempre que possível.

## Layout responsivo

| Faixa | Comportamento |
| --- | --- |
| 1366 px ou maior | Experiência operacional completa |
| 1024–1365 px | Sidebar recolhida e painéis simplificados |
| 768–1023 px | Consulta e gestão leve; PDV adaptado |
| abaixo de 768 px | Consulta e ações simples, sem prometer paridade do PDV |

## Acessibilidade

- Contraste WCAG AA.
- Foco sempre visível.
- Ordem de tabulação coerente.
- Labels associados a todos os campos.
- Erros vinculados ao campo e anunciados por leitor de tela.
- Alvos de toque com pelo menos 44 px em telas sensíveis ao toque.
- Dialogs restauram foco ao gatilho de origem.
- Gráficos possuem resumo textual equivalente.

## Entregáveis

1. Moodboard e direção aprovada.
2. Tokens em CSS.
3. Biblioteca mínima de componentes.
4. Protótipos de Início, PDV, Estoque e Compra.
5. Estados de carregamento, vazio e erro dos protótipos.
6. Teste com usuário real da loja.

## Critérios de aceite

- Todas as telas usam os mesmos tokens.
- Não há cor decorativa usada como se fosse semântica.
- Componentes interativos funcionam com mouse e teclado.
- A interface cabe em 1366 × 768 sem esconder ações críticas.
- O PDV exibe busca, carrinho e total sem rolagem vertical inicial.
- O design não depende do tema padrão de uma biblioteca externa.
