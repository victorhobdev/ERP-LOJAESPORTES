# Bloco 1 — venda paga confiável

Revisar a entrega do executor, não implementar nem ampliar o ERP.

Critérios:
1. Login → seleção de produto → venda paga → persistência em PostgreSQL de teste.
2. Mesma finalização reutiliza chave E payload quando resposta se perde após commit; uma única venda/pagamento/baixa/auditoria por operação. Não reutilizar chave com payload alterado.
3. Carrinho não pode mudar enquanto operação está incerta. Rejeição preserva dados e sucesso confirmado concilia consultas relacionadas.
4. Cálculos de total/subtotal em centavos inteiros, limites compatíveis com API autoritativa.
5. Ausência/expiração de sessão tratada em rotas operacionais; cache do usuário anterior não permanece após logout/troca de sessão. Cookies/CSRF/RBAC preservados.
6. E2E full-stack reprodutível usa web/API reais e PostgreSQL exclusivamente de teste; provoca perda de resposta sem substituir a execução da API; verifica efeitos persistidos. Testes mock existentes continuam categoria distinta.
7. Evidência de pnpm check, integração e E2E, sem ignorar ou enfraquecer testes. Distinguir evidência inspecionada de alegações do executor não confirmadas.

Fora de escopo: catálogo, migração real, novas políticas financeiras, alterações do legado/backups/credenciais/produção, commit/push e a própria integração de revisão.
