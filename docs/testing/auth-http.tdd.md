# Evidência TDD — autenticação HTTP

## Garantias

| Garantia | Teste | RED | GREEN |
| --- | --- | --- | --- |
| CSP não permite `unsafe-eval` e cabeçalhos básicos estão presentes | `apps/api/src/app.test.ts` | Headers ausentes | PASS |
| CORS reflete somente origem configurada | `apps/api/src/app.test.ts` | Header CORS ausente na origem permitida | PASS |
| Credencial inválida retorna erro genérico sem cookie | `auth.integration.test.ts` | Rota ausente, HTTP 404 | PASS |
| Sessão usa cookie HttpOnly/Secure e somente hash no banco | `auth.integration.test.ts` | Rota ausente, HTTP 404 | PASS |
| Sessão retorna papel/permissões e logout exige CSRF | `auth.integration.test.ts` | Rota ausente, HTTP 404 | PASS |
| Logout invalida a sessão persistida | `auth.integration.test.ts` | Rota ausente, HTTP 404 | PASS |
| Login limita tentativas repetidas por IP | `auth.integration.test.ts` | Rate limit configurado não produzia 429 | PASS após corrigir escopo do plugin |

Os testes usam apenas usuário sintético no schema PostgreSQL aleatório e descartável.

RED executado por `pnpm --filter @erp/api test` e pelo comando de integração com `TEST_DATABASE_URL`. O runner unitário inicialmente incluiu o novo teste de integração; a exclusão foi corrigida para os dois caminhos e o RED unitário foi repetido, permanecendo apenas CSP/CORS ausentes. A integração encontrou corretamente HTTP 404 nas rotas de autenticação ainda inexistentes.

## GREEN

- `pnpm --filter @erp/api test`: 13 testes unitários/HTTP PASS.
- `pnpm --filter @erp/api test:integration`: 7 testes PostgreSQL PASS.
- `pnpm --filter @erp/api test:coverage:all`: 20 testes PASS; 93,38% statements, 93,22% branches, 100% functions e 93,75% lines.
- `pnpm check`: lint, tipos, 23 testes unitários totais e builds PASS.

Controles comprovados: CSP restritiva, framing e MIME headers, CORS allowlist, erro genérico, credenciais validadas, comparação de senha com dummy hash para usuário ausente, cookies `HttpOnly`/`Secure`/`SameSite=Strict`, token CSRF double-submit, somente hashes persistidos, RBAC retornado da sessão, auditoria de login/logout e rate limit por IP.

Incidente: o primeiro teste específico de rate limit encontrou zero respostas 429. A causa foi o registro assíncrono do plugin fora do escopo de criação das rotas. O plugin passou a ser aguardado dentro do mesmo escopo Fastify das rotas; o teste foi repetido e passou.
