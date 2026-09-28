# Segurança, implantação e operação

## Objetivo da área

Proteger dinheiro, estoque, dados de clientes e continuidade da loja sem transformar o projeto inicial em uma plataforma de infraestrutura excessiva.

## Autenticação e perfis

Perfis iniciais:

| Perfil | Permissões principais |
| --- | --- |
| Operador | vender, consultar estoque e clientes |
| Estoque | cadastrar, receber e ajustar com justificativa |
| Gestor | relatórios, descontos, pagamentos, trocas e cancelamentos |
| Administrador | usuários, integrações e configurações |

A autorização é validada na API. Ocultar botão no frontend não é controle de acesso.

## Auditoria mínima

Registrar:

- login e falhas relevantes;
- criação, cancelamento e estorno de venda;
- pagamento posterior;
- troca;
- ajuste de estoque;
- criação, recebimento e cancelamento de compra;
- mudança de status de encomenda;
- alteração de preço e custo;
- mudanças de usuários e permissões.

Cada evento contém usuário, instante, entidade, ação e dados mínimos antes/depois quando necessário.

## Segredos e dados sensíveis

- Credenciais nunca ficam no repositório.
- Configuração usa variáveis de ambiente ou cofre do ambiente.
- OAuth do Google Drive é isolado da aplicação cliente.
- Logs removem senha, token e dados desnecessários de cliente.
- Banco aceita conexão apenas da API.
- Cookies de sessão usam `HttpOnly`, `Secure` e política `SameSite` adequada.

## Proteções HTTP e de entrada

- Toda entrada é validada por schema no limite da API.
- Toda consulta usa parâmetros; SQL concatenado é proibido.
- Operações mutáveis com sessão por cookie usam proteção CSRF.
- CORS permite somente as origens efetivamente implantadas.
- CSP começa restritiva, sem `unsafe-eval` e sem `unsafe-inline` por padrão.
- Login e endpoints caros possuem rate limit por IP e por usuário.
- Upload de imagem valida tamanho, MIME, extensão e conteúdo.
- Erros enviados ao cliente não incluem SQL, stack trace ou segredos.
- Dependências usam lockfile e passam por auditoria antes da implantação.

## Implantação recomendada

### Primeira opção: web/PWA

- API e PostgreSQL em servidor controlado.
- PWA instalada nos computadores da loja.
- HTTPS mesmo em acesso remoto restrito.
- Atualização centralizada sem reinstalar clientes.

### Operação local

Se a internet não puder ser dependência, API e banco podem rodar em uma máquina local da loja. Isso exige:

- IP ou nome estável na rede;
- nobreak para o servidor local;
- backup fora da mesma máquina;
- monitoramento do serviço;
- procedimento de recuperação.

### Tauri

Usar somente se a PWA não atender integração com impressora, arquivos ou inicialização nativa. Tauri deve consumir a mesma API; regras de negócio não migram para comandos Rust do cliente.

## Backup e restauração

- Backup diário automatizado do PostgreSQL.
- Cópia externa à máquina principal.
- Retenção definida por política da loja.
- Verificação automática de existência e tamanho.
- Teste periódico de restauração em ambiente separado.
- Imagens incluídas na estratégia ou armazenadas em serviço com versionamento.

Backup sem teste de restauração não conta como proteção concluída.

## Observabilidade

- Log estruturado com `requestId`.
- Health check da API e do banco.
- Registro de duração e erro das operações críticas.
- Alerta para falha de backup e indisponibilidade prolongada.
- Tela de configuração mostra versão e estado das integrações.
- Não introduzir stack distribuída de observabilidade na primeira versão; logs, métricas essenciais e alertas são suficientes.

## Critérios de aceite

- Usuário sem permissão não executa a ação pela API.
- Segredos não aparecem no Git, bundle ou logs.
- Auditoria identifica autor de toda alteração crítica.
- Backup e restauração são comprovados em homologação.
- Queda da integração de catálogo não derruba vendas.
- Procedimentos de iniciar, parar, atualizar e recuperar estão documentados.
- Testes comprovam autenticação, autorização, validação, CSRF e rate limiting.
