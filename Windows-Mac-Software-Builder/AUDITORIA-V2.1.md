# Revisão e correções — v2.1

Esta revisão acompanhou a adição do módulo Software portable. Os problemas abaixo foram identificados no código, reproduzidos com testes e corrigidos. Os testes de transporte HTTP usam ligações reais; os testes de interface e arranque com processos simulados não comprovam compatibilidade de aplicações de terceiros.

| Área | Problema encontrado | Correção |
| --- | --- | --- |
| Gravação | Uma configuração inválida podia ser substituída pelos valores predefinidos no próximo Save | Leitura inválida bloqueia a gravação e conserva o ficheiro original |
| Imagens e ícones | O recurso antigo era apagado antes da cópia e da gravação da configuração | Preparação de novos recursos, gravação atómica e limpeza só depois do sucesso |
| Projetos | Falhas de gravação do índice podiam deixar criação, eliminação e projeto ativo incoerentes | Escrita atómica do índice e ordem de operações que preserva os dados anteriores |
| Ficheiros locais | Validação lexical de caminhos não detetava uma ligação simbólica que saía da pasta de recursos | Verificação de caminho canónico e tipo de ficheiro antes de abrir/copiar |
| Editor | Gravação/reordenação falhada deixava alterações apenas na memória; duplo submit podia enviar duas gravações | Mutações consistentes, recuperação do estado e bloqueio de operações simultâneas |
| Seleção de ficheiros | Um ficheiro escolhido para PDF podia ser enviado depois de mudar para outro tipo; respostas antigas podiam alterar outro editor/projeto | Estado por tipo e verificação da geração do editor/projeto |
| Eliminação de módulos | Confirmação nativa do browser não funcionava corretamente no Electron | Confirmação inline com escolha explícita |
| IPTV | Respostas e temporizadores antigos podiam continuar a reprodução ou o proxy depois de mudar de módulo | Invalidação na mudança de palco e limpeza dos recursos da reprodução |
| Idiomas e palavras-passe | Respostas fora de ordem e reenvio da gate podiam repetir uma ação externa | Seleção de idioma mais recente e execução única por submissão |
| Viewer | Recursos ausentes podiam interromper o arranque; galeria e media permaneciam ativos após navegar | Erros tratados e limpeza de overlays, leitores e listeners |
| HTML local | Trocar um ficheiro/pasta por symlink durante a abertura podia servir dados fora do projeto | Abertura física validada e transmissão através do descriptor verificado |
| PHP local | Extensões de código e cópias de segurança podiam ser devolvidas em claro | Bloqueio desses ficheiros pelo router |
| Importação web | Pastas vazias desapareciam; URLs de pastas sem barra quebravam recursos relativos | Pastas preservadas e redirecionamento que mantém token/query |
| Proxy PHP | Uma resposta interrompida do backend podia deixar o cliente pendurado | Propagação de erro/aborto ao cliente |
| Exportação | Alteração de um ficheiro durante a compressão podia produzir um pacote inconsistente | Verificação final dos metadados antes de concluir o stream e substituição atómica do destino |
| Nomes de projetos | Nomes Unicode podiam ultrapassar o limite do sistema de ficheiros apesar do limite de caracteres | Limite adicional em bytes para os componentes exportados |
| Templates Mac | Capitalização incorreta do executável provocava um erro interno pouco claro | Validação explícita do nome exigido |
| Portable | Symlinks relativos Windows usam separadores diferentes; paths temporários Mac têm aliases | Normalização segura dos links e utilização de caminhos canónicos nos testes |
| Processador | Electron x64 em modo de tradução podia bloquear uma aplicação nativa ARM64 | Deteção da arquitetura efetiva do computador |
| Motor de execução | Electron 32.3.3 estava fora de suporte | Dependência atualizada e fixada em Electron 44.6.0 |

## Verificação

Execute `npm ci` e `npm test`. O workflow nativo executa os testes, cria os dois modelos de exportação, verifica exportações reais no Electron e compila os dois instaladores. O teste de software portable usa um processo nativo do próprio sistema e verifica também a cópia física de `app.asar` e a persistência dos ficheiros de trabalho.

A auditoria npm das dependências de produção não comunicou vulnerabilidades conhecidas na verificação desta revisão. Isso não demonstra ausência de todas as vulnerabilidades. A atualização de Electron exige macOS 13 ou posterior; Windows continua a exigir Windows 10 ou posterior em x64.

## Limites que permanecem

- Wine continua externo, facultativo e dependente de cada aplicação. Não existe conversão geral Mac → Windows. Consulte [PORTABLE.md](PORTABLE.md).
- A interface do programa portable abre numa janela própria. A pasta de trabalho vive nos dados internos da aplicação.
- A análise e cópia de pastas grandes são síncronas e podem tornar a interface temporariamente indisponível; a cópia de trabalho exige espaço adicional.
- O programa portable é código nativo com os privilégios do utilizador. O isolamento das páginas HTML não o transforma num programa isolado do sistema.
- Os instaladores Windows continuam sem assinatura de editor; Mac utiliza assinatura ad-hoc e não tem notarização Apple.
- PHP nativo só é testado quando o runtime está disponível. Os testes com transporte simulado não substituem esse teste.
- As palavras-passe dos módulos e a ofuscação IPTV não impedem extração dos conteúdos. Os produtos anteriormente exportados devem ser novamente exportados para receber estas alterações.

Esta revisão cobre os casos investigados e as regressões documentadas; não afirma que o produto está livre de todos os bugs.
