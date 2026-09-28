# Ponte local OpenCode → Codex

Design aprovado na conversa de 2026-09-03: plugin pequeno + CLI, sem MCP, fila ou serviço externo novo. O usuário pediu implementar/instalar e revisar a sessão já finalizada.

## Escopo

Uma sessão e um bloco explicitamente configurados. A primeira execução é somente revisão, sem reinjetar correções. Núcleo Node.js nativo, plugin OpenCode e comando manual para exportação oficial da sessão existente. Codex Sol executa em read-only, com configuração de usuário ignorada e saída JSON validada. Não representa a conversa do Codex desktop.

## Segurança e consistência

- Base Git fixa inclui alterações já commitadas e não commitadas; arquivos do bloco em allowlist explícita, sem backups/segredos.
- Lock por repositório, estado persistente, máximo de três chamadas por bloco e timeout de cinco minutos por chamada. Custos/tokens reais devem ser acompanhados externamente; não há orçamento monetário garantido pelo CLI.
- Fingerprint de HEAD, conteúdos em escopo e mensagens da sessão é conferido depois da revisão e antes de enviar feedback. Mudança invalida o resultado.
- Estados pass/changes_required/inconclusive/error distintos; pass exige evidências e critérios satisfeitos, nunca resulta de erro ou lista vazia.
- Sem auto-commit, push, produção ou aprovação de permissões. Feedback automático é opt-in e limitado ao bloco.
- Transcript é dado não confiável, redigido e limitado; não transmite raciocínio interno nem saída bruta de ferramentas.
- Relatório e tentativas persistem em diretório ignorado. Resultado já processado não é repetido. Nova justificativa textual muda fingerprint, mesmo sem código novo.
- Falha/ambiguidade no envio de feedback não gera retry automático; fica registrada para reconciliação humana.
- O executor deve permanecer parado durante a revisão. Mudanças concorrentes são detectadas, mas a ponte não congela o editor nem promete snapshot atômico do filesystem.

## Verificação

Testes Node com repositórios Git temporários reais: commits, untracked, escopo, validação, deduplicação, lock, stale, limite de rodadas e erros. Execução real do CLI na sessão informada. Instalação do plugin em .opencode/plugins; sessão desktop existente poderá requerer recarregamento do OpenCode para carregar plugin novo.
