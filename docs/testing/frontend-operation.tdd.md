# Evidência TDD — frontend, E2E e operação

| Garantia | RED | GREEN |
| --- | --- | --- |
| Dashboard renderiza bases reconciliadas | módulo ausente | componente com loading/erro/dados e teste |
| PDV mantém carrinho até confirmação | módulo ausente | POST único com idempotência e limpeza após 201 |
| Navegação por teclado | `nav` sem nome acessível no E2E | skip link focável e `nav` nomeado |
| Rotas operacionais não são placeholders | placeholders explícitos | estoque, compras, encomendas e relatórios renderizados |
| CI reproduz banco e navegador | workflow ausente | PostgreSQL 16, check, integração, cobertura e Chromium |
| Backup/restore têm guardas | scripts ausentes | checksum e restauração limitada a `_restore_test` |

GREEN: 4 testes de componentes web, 3 testes Playwright e build Vite PASS. O primeiro E2E falhou antes de iniciar por Chromium ausente; após instalar somente Chromium, revelou o nome ARIA no contêiner incorreto. O `nav` foi corrigido e os 3 cenários passaram.
