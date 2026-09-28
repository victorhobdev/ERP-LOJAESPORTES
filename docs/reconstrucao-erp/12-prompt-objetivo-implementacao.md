# Prompt de objetivo — implementar a reconstrução completa

Copie o bloco abaixo e envie em uma nova tarefa aberta na raiz deste repositório.

```text
/goal Reconstrua e implemente completamente este ERP do zero, seguindo todos os documentos de `docs/reconstrucao-erp/`, sem parar até atingir a condição de conclusão verificável definida abaixo ou encontrar um blocker externo real.

FONTES AUTORITATIVAS

Leia integralmente, antes de implementar, nesta ordem:

1. `AGENTS.md` e quaisquer instruções locais aplicáveis.
2. `docs/reconstrucao-erp/00-plano-mestre.md`.
3. Todos os arquivos numerados de `01-` até `11-` em `docs/reconstrucao-erp/`.
4. `ERP_REAL_CONTEXT.md`, `database.sql` e o código legado somente para confirmar regras, dados e comportamento atual.

Os documentos de reconstrução definem o estado desejado. O sistema Java/JavaFX é apenas evidência do legado e não é modelo de arquitetura ou interface.

OBJETIVO TÉCNICO

Criar a nova implementação neste mesmo repositório como monorepo, usando a estrutura mínima:

- `apps/web`: React 19, TypeScript, Vite, TanStack Router, TanStack Query, TanStack Table, React Hook Form, Zod, Tailwind CSS e Radix Primitives;
- `apps/api`: Fastify e TypeScript;
- `packages/contracts`: contratos compartilhados estritamente necessários;
- PostgreSQL como banco do sistema novo;
- Vitest, Testing Library e Playwright para validação;
- PWA como forma inicial de distribuição;
- Tauri somente se um requisito nativo comprovado exigir.

Implemente todas as áreas descritas no plano:

- shell, autenticação, usuários, papéis e auditoria;
- dashboard;
- produtos, variantes, estoque e movimentos;
- PDV, vendas pagas e pendentes, pagamentos posteriores e trocas;
- clientes no contexto necessário aos fluxos;
- fornecedores, compras e recebimentos parciais/integrais;
- encomendas de clientes e timeline de estados;
- catálogo, imagens e estado de sincronização;
- financeiro e relatórios de produtos;
- migração MySQL para PostgreSQL, reconciliação e relatório de rejeições;
- segurança, backup, restauração, observabilidade e documentação operacional.

REGRAS DE EXECUÇÃO

1. Antes de alterar arquivos, inspecione o estado real do repositório, Git, ambiente, banco disponível e documentos. Preserve mudanças preexistentes do usuário.
2. Use o plano de blocos de `11-roadmap-validacao.md` e execute continuamente do Bloco 0 ao Bloco 6. Não pare entre blocos quando o gate anterior estiver verde.
3. Mantenha `docs/reconstrucao-erp/PROGRESSO.md` com checklist, decisões, evidências, testes e estado `COMPLETO`, `PARCIAL` ou `NAO_FEITO` de cada bloco.
4. Não encerre a meta após produzir análise, outro plano, wireframes, scaffolding, mocks isolados ou somente o happy path. Esses itens são intermediários.
5. Não reutilize código Java, JavaFX, FXML, CSS, controllers, consultas ou arquitetura do sistema antigo.
6. Não apague nem modifique o legado para facilitar a implementação. Mantenha-o utilizável até o gate final de migração.
7. Preserve dados e regras reais por migração e reimplementação. Não copie cegamente o schema antigo.
8. Não use microserviços, Redux, GraphQL, SSR, Server Components, Electron ou abstrações genéricas sem necessidade comprovada.
9. Toda regra crítica deve existir e ser validada na API. O frontend nunca acessa o banco.
10. Dinheiro usa decimal/integer em centavos, nunca ponto flutuante. Datas têm contrato explícito. Estoque não pode ficar negativo.
11. Venda, pagamento, troca, ajuste e recebimento devem ser transacionais, idempotentes e auditáveis.
12. Use queries parametrizadas, validação por schema, RBAC na API, cookies seguros, CSRF, CORS restrito, CSP, rate limits, upload validado e logs sem segredos.
13. Não use atualizações otimistas em dinheiro ou estoque.
14. Cada rota deve implementar loading, vazio inicial, vazio por filtro, erro recuperável, sucesso e preservação de formulário após falha.
15. Otimize primeiro para 1366 × 768, teclado, acessibilidade WCAG AA e operação rápida no balcão.
16. Use um design visual próprio conforme `02-design-visual.md`; não entregue o tema padrão de uma biblioteca.
17. Para decisões reversíveis não documentadas, escolha o padrão mais simples e registre a decisão. Pare somente se a escolha mudar dados, segurança, regra financeira ou operação real de modo material.
18. Execute validação proporcional após cada mudança e o conjunto completo no gate de cada bloco.
19. Corrija falhas encontradas e repita a validação. Não declare verde com testes ignorados ou evidência parcial.
20. Não reduza o objetivo para caber em um único turno. Continue pelas retomadas da meta até a conclusão real.

AUTORIZAÇÃO E LIMITES

Você está autorizado a:

- ler o repositório e documentação;
- criar e editar arquivos dentro deste repositório;
- instalar dependências necessárias e justificadas;
- criar banco e dados exclusivamente de desenvolvimento/teste;
- executar builds, linters, testes, migrações de teste, servidores locais e inspeções no navegador;
- criar scripts reprodutíveis de setup, migração, backup e restauração.

Você não está autorizado a, sem confirmação explícita:

- alterar ou apagar o banco de produção;
- usar credenciais reais encontradas no ambiente;
- publicar ou implantar externamente;
- remover o ERP legado;
- apagar backups;
- fazer compras, criar contas ou modificar serviços externos;
- executar migração final com escrita em dados reais.

VALIDAÇÃO OBRIGATÓRIA

Deixe comandos reprodutíveis e execute, quando aplicável:

- instalação limpa pelo lockfile;
- lint e verificação TypeScript;
- testes unitários e de componentes;
- testes de integração da API com PostgreSQL isolado;
- testes de transação, rollback, autorização, concorrência e idempotência;
- Playwright para todos os fluxos críticos descritos no plano;
- build de produção da web e da API;
- validação PWA;
- inspeção visual real no navegador em 1366 × 768 e larguras menores;
- teste de teclado e estados loading/vazio/erro;
- migração de teste repetida para provar idempotência;
- reconciliação de produtos, SKUs, saldos, vendas, pagamentos, compras e encomendas;
- backup e restauração em ambiente de homologação local;
- auditoria de dependências e verificação de segredos.

DADOS E AMBIENTE AUSENTES

Se o banco real, credenciais, aprovação humana ou serviço externo não estiver disponível:

- não invente que a validação ocorreu;
- implemente completamente o código, contratos, testes, fixtures, dry-run e procedimentos que não dependam do recurso externo;
- use dados sintéticos apenas em desenvolvimento/teste e identifique-os;
- registre exatamente a evidência faltante em `PROGRESSO.md`;
- só trate como blocker quando não existir outro trabalho seguro e aderente em nenhum bloco.

CONDIÇÃO DE CONCLUSÃO VERIFICÁVEL

Considere a meta concluída somente quando todas as condições abaixo forem comprovadas:

- todos os documentos `00` a `11` foram implementados ou cada requisito não aplicável possui justificativa objetiva aprovada pelo próprio plano;
- Blocos 0 a 6 estão marcados `COMPLETO` com evidência em `PROGRESSO.md`;
- web, API e banco iniciam por comandos documentados em ambiente limpo;
- todas as rotas e operações planejadas existem e usam dados reais da API;
- os fluxos críticos passam em Playwright;
- lint, tipos, testes, builds e verificações de segurança passam sem ignorar falhas;
- transações, concorrência, idempotência, autorização e auditoria foram testadas;
- migração de homologação é reexecutável e sua reconciliação fecha exatamente;
- backup e restauração foram demonstrados;
- QA visual e de acessibilidade foi executado;
- nenhuma linha do legado foi necessária para executar o novo sistema;
- o legado permanece preservado;
- documentação de instalação, operação, migração, rollback e limitações está atualizada;
- não existe item `PARCIAL` ou `NAO_FEITO` necessário à operação definida no plano.

REPORTE DURANTE A META

- Compartilhe atualizações curtas ao iniciar e concluir cada bloco.
- Informe comandos e evidências, não apenas intenção.
- Ao encontrar uma falha, diga qual gate falhou, corrija e revalide.
- Se houver blocker externo real, preserve tudo que ficou verde e reporte: bloco, evidência, impacto, trabalho restante e ação exata necessária do usuário.

REPORTE FINAL

Entregue:

1. diagnóstico inicial encontrado;
2. tabela dos Blocos 0–6 com status e evidência;
3. funcionalidades implementadas por área;
4. arquivos e arquitetura criados;
5. comandos de execução e operação;
6. resultados completos de testes, build, migração, reconciliação e segurança;
7. pendências e riscos residuais;
8. confirmação explícita de cada item da condição de conclusão.
```

## Como usar

Na tarefa aberta na raiz do projeto, cole o prompt inteiro. O comando `/goal` mantém a execução entre turnos até a condição verificável ou um blocker real. Para consultar, pausar ou retomar a meta, use `/goal`, `/goal pause` e `/goal resume`, respectivamente.
