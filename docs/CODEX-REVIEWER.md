# Revisor local OpenCode → Codex

Instalação por projeto, sem novas dependências. O plugin está em `.opencode/plugins/codex-reviewer.js`; o núcleo e o comando manual estão em `scripts/codex-reviewer/`.

## Estado inicial

- Sessão vinculada: `ses_f9751ab10ffeFDe60RJk6cAOK4` — **Bloco 1 venda paga confiável ERP**.
- Bloco: `erp-paid-sale-block-1`; base fixa: `0fc6e9e9f526095dc977242e8ac12cc17c3e5419`.
- Configuração local: `.opencode/reviewer.local.json` (ignorada pelo Git).
- `enabled: true`, `autoFix: false`, máximo de três tentativas, timeout de cinco minutos por revisão.
- O CLI manual sempre força report-only, mesmo se `autoFix` estiver ligado no plugin.
- O revisor é um processo separado do Codex CLI, modelo `gpt-5.6-sol`, esforço `high`. Não é esta conversa e suas respostas não aparecem automaticamente aqui.

O carregamento do plugin foi confirmado pelo comando oficial `opencode export` **sem** `--pure`. Isso não confirma carregamento na instância desktop que já estava aberta: reabra o projeto/reinicie o OpenCode para carregar o plugin nessa instância. O arquivo ignorado `.opencode/reviewer-state/plugin-loaded.json` informa PID e horário do último carregamento.

## Usar

Na raiz do projeto:

```powershell
node scripts/codex-reviewer/cli.mjs review
node scripts/codex-reviewer/cli.mjs status
```

A revisão lê a sessão diretamente pelo export oficial, sem copiar/colar. No desktop, o plugin reage a `session.idle` somente da sessão configurada. Uma sessão já encerrada antes do carregamento não gera novo evento; use o comando manual nesse caso.

Relatórios: `.opencode/reviewer-state/review-N.json`; último resultado: `latest.json`. `pass` exige evidência e ausência de critérios pendentes; `changes_required` contém achados; `inconclusive` significa evidência insuficiente; `error` é falha de revisão, **nunca aprovação**. Resultados `stale` não autorizam correção. Testes alegados pelo executor não equivalem a testes reexecutados pelo revisor: a revisão é somente leitura.

## Estado visível da orquestração

O arquivo `.opencode/reviewer-state/orchestrator.json` é a fonte de verdade do ciclo. Ele deve sempre distinguir:

- `executorStatus`: `EXECUTING` somente durante um processo `opencode run`; `WAITING_FOR_REVIEW` quando o executor terminou e há entrega nova; `IDLE` quando não há execução;
- `reviewerStatus`: `REVIEWING` somente enquanto o Codex estiver relendo diff/evidências e executando os gates; `IDLE` fora desse intervalo.

Uma janela Electron `OpenCode.exe` aberta não prova que o executor está trabalhando. Para conferir no Windows sem tocar em dados:

```powershell
Get-CimInstance Win32_Process -Filter "Name = 'opencode.exe'" |
  Select-Object ProcessId,ParentProcessId,CommandLine
Get-Content .opencode/reviewer-state/orchestrator.json
```

O protocolo do orquestrador é: (1) registrar `EXECUTING` e o comando antes do despacho; (2) deixar o executor trabalhar sem iniciar revisão paralela; (3) registrar `WAITING_FOR_REVIEW` ao terminar; (4) só então o Codex entra em `REVIEWING`; (5) ao aceitar ou enviar correção, voltar a `IDLE`/`EXECUTING` explicitamente. Se uma mensagem interromper o despacho antes do processo nascer, o estado volta para `IDLE` e nenhum trabalho é presumido.

O heartbeat pode acordar a conversa para verificar mudança, mas deve permanecer silencioso quando o estado não mudou. Isso não equivale a um Codex permanentemente ativo nem substitui a indicação acima.

Para desligar, edite `enabled` para `false`. Para habilitar futuramente correções automáticas, confirme primeiro o escopo e altere `autoFix` para `true`: apenas novos resultados estáveis com achados dentro da lista autorizada serão enviados. Ligar a opção não reenvia um relatório já deduplicado. Nenhuma correção foi habilitada na instalação inicial.

## Limites e segurança

- Escopo é uma lista explícita de arquivos, não todos os arquivos alterados. A base fixa inclui também alterações que o executor tenha commitado depois dela.
- O sandbox do Codex permanece `read-only`, com `approval_policy=never`. No Windows o transporte seleciona explicitamente `windows.sandbox="elevated"`. Não existe fallback para acesso total. Consulte a [documentação oficial do sandbox](https://learn.chatgpt.com/docs/windows/windows-sandbox).
- Login salvo do Codex é usado pelo próprio CLI. A ponte não abre arquivos de autenticação, não armazena chaves e não inclui variáveis de credenciais no ambiente do revisor.
- Texto da sessão é dado não confiável e passa por remoção de padrões comuns de credenciais; isso não é garantia de detecção de qualquer segredo arbitrário. Não cole segredos na conversa. O controle de escopo orienta o revisor e valida achados; não equivale a uma ACL de leitura por arquivo.
- Arquivos de apoio podem ser lidos para entendimento, mas achados enviados para correção precisam apontar um arquivo do escopo autorizado.
- Lock por repositório, impressões digitais de código/sessão antes e depois, checagem adicional imediatamente antes do envio, histórico persistente e limite de três tentativas. A API não fornece transação atômica entre filesystem e envio: evite trabalhar simultaneamente no mesmo checkout durante revisões.
- A identidade do executor (provedor, modelo, agente e variante) é preservada no feedback. Falha de envio ambígua não é reenviada automaticamente.
- Timeout encerra o processo direto do revisor; não constitui um supervisor de todos os possíveis subprocessos descendentes. Nenhum comando de teste/escrita deve ser iniciado por esse revisor.

## Recuperação

Erros também consomem tentativas. Uma falha do revisor pode ser repetida dentro do limite; um resultado estável já visto é deduplicado. Ao atingir o limite, pare para avaliação humana.

Não apague `state.json` para obter um loop ilimitado. Para um novo bloco, desligue o plugin, confirme ausência de revisão em andamento e arquive o diretório de estado antes de configurar sessão/base/escopo e critérios novos. Preserve os relatórios anteriores. Isso é uma operação manual deliberada, não feita automaticamente pela ponte.

Se houver `lock` abandonado, inspecione seu `owner.json` e confirme que o PID não está executando a revisão antes de remover somente aquele lock. Não remova um lock ativo. Não publique o diretório de estado: ele pode conter detalhes internos do projeto.

## Verificar a ponte

```powershell
node --test scripts/codex-reviewer/*.test.mjs
node node_modules/eslint/bin/eslint.js scripts/codex-reviewer .opencode/plugins/codex-reviewer.js
```

Os testes usam repositórios temporários e subprocessos controlados. O caminho opcional de envio de correções é testado com adaptador controlado; não foi disparado contra a sessão real durante a instalação.
