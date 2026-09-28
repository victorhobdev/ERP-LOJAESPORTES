# Evidência TDD — Bloco 1, fundação

## Fonte

- `docs/reconstrucao-erp/00-plano-mestre.md`
- `docs/reconstrucao-erp/01-produto-ux-navegacao.md`
- `docs/reconstrucao-erp/03-frontend.md`
- `docs/reconstrucao-erp/04-backend-api.md`
- `docs/reconstrucao-erp/10-seguranca-operacao.md`
- `docs/reconstrucao-erp/11-roadmap-validacao.md`

## Jornadas deste ciclo

1. Como cliente da API, quero valores monetários e estados com contrato inequívoco para não aceitar representações ambíguas.
2. Como operador, quero que o shell apresente as áreas operacionais sem ambiguidade e permita iniciar uma venda globalmente.
3. Como usuário de teclado, quero pular diretamente para o conteúdo principal.
4. Como operador do sistema, quero health check identificável e erros sem stack trace.
5. Como usuário autenticado, quero senha armazenada com salt aleatório e verificação segura.

## Mapeamento RED/GREEN

| Garantia | Teste | RED | GREEN |
| --- | --- | --- | --- |
| Dinheiro e estados possuem formato finito | `packages/contracts/src/contracts.test.ts` | 2026-08-30: módulo `./index.js` ausente | 8 testes PASS |
| Health e erro seguro da API | `apps/api/src/app.test.ts` | 2026-08-30: módulo `./app.js` ausente | 2 testes PASS |
| Hash de senha salgado | `apps/api/src/shared/auth/password.test.ts` | 2026-08-30: módulo `./password.js` ausente | 1 teste PASS |
| Shell e landmarks acessíveis | `apps/web/src/app/App.test.tsx` | 2026-08-30: módulo `./App.js` ausente | 2 testes PASS |

## Comandos RED executados

```text
pnpm test
pnpm --filter @erp/api test
pnpm --filter @erp/web test
```

Resultado: todos falharam pelo módulo de produção intencionalmente ausente; nenhum falhou por instalação, sintaxe de teste ou runner indisponível.

## Cobertura e lacunas

Comando: `pnpm test:coverage`.

- Contratos: 100% statements/branches/functions/lines.
- API: 88% statements, 80% branches, 85,71% functions e 91,3% lines.
- Web: 100% statements/branches/functions/lines para os componentes incluídos no ciclo.

Validação final do ciclo: `pnpm check` passou lint, TypeScript, 13 testes e builds de produção. Banco, autenticação por sessão, rotas de domínio e E2E pertencem aos próximos ciclos e ainda não são reivindicados por esta evidência.

## Incidentes do gate e correções

1. O primeiro GREEN candidate da API expirou porque o hook aguardava o objeto `reply`; o hook passou a usar callback síncrono e os mesmos testes ficaram verdes.
2. O primeiro GREEN candidate web acumulou DOM entre testes; o setup passou a executar `cleanup` em `afterEach`.
3. O primeiro gate de lint/tipos detectou emissão indevida de JS pelo `tsc -b`; os scripts passaram a usar `--noEmit`, os artefatos deste ciclo foram removidos e o gate foi repetido.
4. O primeiro build com TypeScript 6 exigiu `rootDir` explícito em contratos; a configuração foi corrigida e o build completo repetido com sucesso.
