# Codex Reviewer Implementation Plan

> Implementação inline autorizada pelo usuário; revisão independente somente leitura conforme a skill requesting-code-review, sem worktree adicional.

**Goal:** Instalar a ponte local e revisar a entrega existente sem correção automática inicial.

**Architecture:** Núcleo ESM Node nativo compartilhado pelo comando manual e pelo plugin OpenCode. Estado local ignorado, configuração por sessão/bloco, revisão CLI somente leitura.

**Tech Stack:** Node.js 22, node:test, Git, OpenCode 1.14.48, Codex CLI 0.152.0.

**Spec:** docs/superpowers/specs/2026-09-03-codex-reviewer-design.md

## Global Constraints

Preservar alterações do executor e legado. Sem dependências novas. Primeira rodada report-only. Base fixa, allowlist, lock, timeout e máximo três chamadas.

### Task 1: Núcleo e regressões

Files: scripts/codex-reviewer/core.mjs e core.test.mjs.

- [x] Criar testes de validateReview, snapshot e runReview usando Git temporário e resultados externos controlados.
- [x] Rodar `node --test scripts/codex-reviewer/core.test.mjs` e observar RED por módulo ausente.
- [x] Implementar snapshot(root, config), validateReview(value) e runReview(root, config, adapters).
- [x] Repetir testes, incluindo lock, stale, limite, rejeição JSON e mensagem nova sem alteração de código.

### Task 2: Transportes e instalação

Files: scripts/codex-reviewer/cli.mjs, .opencode/plugins/codex-reviewer.js, .opencode/reviewer.local.json, .opencode/review-task.md.

- [x] Implementar export oficial de sessão e spawn direto do Codex sem shell.
- [x] Plugin valida sessão ativa/idle e usa o cliente injetado pelo OpenCode; chama o mesmo núcleo.
- [x] Configurar explicitamente a sessão identificada e allowlist do Bloco 1; autoFix=false.
- [x] Executar testes do transporte com subprocessos reais controlados e carregar plugin pelo CLI.

### Task 3: Revisão real e entrega

- [x] Executar `node scripts/codex-reviewer/cli.mjs review` com sessão real e Codex Sol.
- [x] Conferir parecer funcional da segunda tentativa (primeira registrou erro de sandbox): changes_required, três achados, nenhuma correção enviada.
- [x] Conferir estado persistido e ausência de mudanças nos 14 arquivos do executor pela impressão digital antes/depois.
- [x] Documentar recarregamento, desligamento, limites e erro de permissão/autenticação sem expor segredos.

## Verificação da implementação

- 15 testes de núcleo/transporte passaram; lint direto pelo entrypoint Node e syntax checks passaram.
- Revisão independente encontrou e confirmou correções de quatro pontos: diff sem pathspec, redaction de campos JSON/Authorization, achado fora do escopo e verificação final de stale antes do feedback.
- Carregamento do plugin confirmado pelo export oficial; ativação na instância desktop já aberta depende de recarregamento pelo usuário.
- Nenhum feedback enviado à sessão real; integração live de correção permanece não exercitada por escolha report-only.
