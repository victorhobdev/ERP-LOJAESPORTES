# Vendas e clientes

## Objetivo da área

Reconstruir o PDV e o histórico de vendas com foco em velocidade, consistência de estoque e rastreabilidade de pagamento e troca.

## Rotas

- `/vendas/nova`
- `/vendas`
- `/vendas/:vendaId`

Uma área independente de clientes só será criada quando existirem operações além da busca e do histórico contextual.

## Fluxo do PDV

1. Buscar produto por clube, modelo ou SKU.
2. Escolher tipo e tamanho entre variantes disponíveis.
3. Informar quantidade e preço permitido.
4. Adicionar ao carrinho.
5. Identificar cliente ou usar “Consumidor Final”.
6. Aplicar desconto autorizado.
7. Informar pagamento pago ou pendente.
8. Revisar total e finalizar.
9. API recalcula, valida estoque e grava tudo em transação.

## Dados mínimos

### Produto pesquisável

- id do produto e da variante;
- clube, modelo, tipo e tamanho;
- imagem opcional;
- preço atual;
- estoque disponível;
- custo somente para perfil autorizado.

### Venda

- cliente;
- instante da venda;
- itens e quantidades;
- preço histórico de cada item;
- desconto e total;
- pagamentos;
- saldo pendente;
- operador;
- eventos de troca e auditoria.

## Regras

- Quantidade deve ser positiva.
- Desconto não pode exceder o subtotal.
- Permissão define limite ou uso de desconto.
- Venda não é criada se qualquer item ficar sem estoque.
- Preço informado pelo frontend não é autoritativo.
- Venda pendente exige cliente identificado e vencimento.
- Pagamento posterior cria registro; não sobrescreve o histórico.
- Troca cria evento próprio e dois movimentos de estoque.
- Venda concluída não pode ser excluída; correção usa estorno autorizado.

## API necessária

- `GET /products?search&inStock=true`
- `POST /sales`
- `GET /sales`
- `GET /sales/:id`
- `POST /sales/:id/payments`
- `POST /sales/:id/exchanges`

O detalhe da venda deve retornar itens, pagamentos, saldo, troca e timeline em uma resposta agregada.

## UX

- Busca recebe foco ao abrir o PDV.
- Seleção de tamanho usa botões visíveis, não dropdown.
- Variantes sem saldo aparecem indisponíveis, sem desaparecer da compreensão.
- Carrinho e total permanecem visíveis.
- Enter adiciona item quando o formulário estiver válido.
- Finalização exibe resumo antes da confirmação.
- Erro de estoque mantém o carrinho e destaca o item divergente.

## Estados vazios e erros

- Busca sem resultado oferece limpar termo ou abrir encomenda.
- Carrinho vazio explica o primeiro passo.
- Cliente não encontrado permite cadastro mínimo no contexto.
- Falha de rede preserva o carrinho local durante a sessão.
- Conflito de estoque força nova revisão; não usa atualização otimista.

## Critérios de aceite

- Uma venda comum pode ser concluída apenas com teclado.
- Duplo clique ou reenvio não duplica venda.
- Concorrência do mesmo SKU não produz saldo negativo.
- Pagamento parcial e posterior preservam histórico.
- Troca atualiza estoque e cria auditoria sem alterar o item original.
- Totais exibidos e gravados são iguais aos recalculados pela API.
