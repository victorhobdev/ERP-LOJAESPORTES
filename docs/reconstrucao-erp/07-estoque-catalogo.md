# Estoque e catálogo

## Objetivo da área

Unificar produto, variantes, saldo, movimentações e imagens sem misturar disponibilidade física com publicação de catálogo.

## Rotas

- `/estoque`
- `/estoque/produtos/:produtoId`
- `/estoque/entrada`
- `/catalogo`

## Modelo de apresentação

O produto lógico é `clube + modelo`. Tipo e tamanho formam variantes vendáveis. A tela principal exibe uma linha por produto e permite expandir variantes.

Não haverá tabelas separadas para adulto e infantil. A grade de tamanhos muda conforme o tipo, mas permanece no mesmo modelo de interação.

## Visão de estoque

Dados mínimos:

- produto e imagem;
- variantes;
- saldo por variante;
- saldo total;
- preço atual;
- custo médio;
- última entrada;
- indicador de estoque baixo;
- data do último movimento.

Filtros:

- busca;
- clube;
- tipo;
- tamanho;
- em estoque, zerado ou baixo;
- com ou sem imagem.

## Movimentações

Tipos iniciais:

- `opening_balance`;
- `purchase_receipt`;
- `sale`;
- `exchange_in`;
- `exchange_out`;
- `manual_adjustment`;
- `reversal`.

Ajuste manual exige motivo e permissão. Movimentos originados por venda, troca ou recebimento são criados apenas pelo fluxo de origem.

## API necessária

- `GET /inventory`
- `GET /products/:id`
- `POST /products`
- `PATCH /products/:id`
- `GET /inventory/movements`
- `POST /inventory/movements`
- `GET /catalog`
- `POST /catalog/images`
- `POST /catalog/sync`

## Catálogo e imagens

- Imagem pertence ao produto lógico, não ao tamanho.
- Arquivo deve ter identificador e metadados no banco.
- Caminho absoluto local não é contrato público.
- Upload valida formato, tamanho e integridade.
- Sincronização com Google Drive é integração substituível, não fonte primária do cadastro.
- Produto sem imagem permanece operável e recebe pendência visível.
- A remoção de imagem não remove produto nem histórico.

## Cobertura atual

| Necessidade | Cobertura atual |
| --- | --- |
| Saldo atual por SKU | completa |
| Produto lógico e variantes | implícita, precisa normalização |
| Histórico de movimentos | ausente como entidade única |
| Estoque mínimo | ausente |
| Auditoria de ajuste | ausente |
| Imagem por produto lógico | parcial via properties/Drive |
| Publicação de catálogo | parcial |

## Estados da interface

- Estoque vazio inicial direciona para migração ou primeiro cadastro.
- Filtro sem resultado permite limpar filtros.
- Produto sem imagem usa placeholder neutro.
- Falha de imagem não bloqueia estoque.
- Sincronização mostra em andamento, concluída, parcial ou falha.
- Dados antigos exibem o instante da última atualização.

## Critérios de aceite

- Todo saldo pode ser explicado por movimentos.
- Ajuste manual registra usuário e motivo.
- Produto e variante não podem ser duplicados pela mesma chave de negócio.
- Estoque adulto e infantil são consultados no mesmo fluxo.
- Upload inválido não deixa arquivo órfão.
- Falha na sincronização externa não impede venda ou consulta local.
