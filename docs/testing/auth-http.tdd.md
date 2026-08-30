# Evidência TDD — autenticação HTTP

## Garantias

| Garantia | Teste | RED | GREEN |
| --- | --- | --- | --- |
| CSP não permite `unsafe-eval` e cabeçalhos básicos estão presentes | `apps/api/src/app.test.ts` | Headers ausentes | Pendente |
| CORS reflete somente origem configurada | `apps/api/src/app.test.ts` | Header CORS ausente na origem permitida | Pendente |
| Credencial inválida retorna erro genérico sem cookie | `auth.integration.test.ts` | Rota ausente, HTTP 404 | Pendente |
| Sessão usa cookie HttpOnly e somente hash no banco | `auth.integration.test.ts` | Rota ausente, HTTP 404 | Pendente |
| Sessão retorna papel/permissões e logout exige CSRF | `auth.integration.test.ts` | Rota ausente, HTTP 404 | Pendente |
| Logout invalida a sessão persistida | `auth.integration.test.ts` | Rota ausente, HTTP 404 | Pendente |

Os testes usam apenas usuário sintético no schema PostgreSQL aleatório e descartável.

RED executado por `pnpm --filter @erp/api test` e pelo comando de integração com `TEST_DATABASE_URL`. O runner unitário inicialmente incluiu o novo teste de integração; a exclusão foi corrigida para os dois caminhos e o RED unitário foi repetido, permanecendo apenas CSP/CORS ausentes. A integração encontrou corretamente HTTP 404 nas rotas de autenticação ainda inexistentes.
