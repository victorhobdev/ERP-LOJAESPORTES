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
| Dinheiro e estados possuem formato finito | `packages/contracts/src/contracts.test.ts` | 2026-08-30: módulo `./index.js` ausente | Pendente |
| Health e erro seguro da API | `apps/api/src/app.test.ts` | 2026-08-30: módulo `./app.js` ausente | Pendente |
| Hash de senha salgado | `apps/api/src/shared/auth/password.test.ts` | 2026-08-30: módulo `./password.js` ausente | Pendente |
| Shell e landmarks acessíveis | `apps/web/src/app/App.test.tsx` | 2026-08-30: módulo `./App.js` ausente | Pendente |

## Comandos RED executados

```text
pnpm test
pnpm --filter @erp/api test
pnpm --filter @erp/web test
```

Resultado: todos falharam pelo módulo de produção intencionalmente ausente; nenhum falhou por instalação, sintaxe de teste ou runner indisponível.

## Cobertura e lacunas

Cobertura será medida após o GREEN. Banco, autenticação por sessão, rotas de domínio e E2E pertencem aos próximos ciclos e ainda não são reivindicados por esta evidência.
