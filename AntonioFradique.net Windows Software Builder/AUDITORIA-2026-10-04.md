# Revisão do produto — 4 de outubro de 2026

Base analisada: commit `a35a639810bbca79f7403f56bd70639a5258d93c` do repositório
`Fradiqueland/AntonioFradique-Windows-Software-Builder`, versão 1.5.20.
As referências abaixo apontam a funções e linhas dessa base, anteriores à alteração.
Revisão estática e testes locais controlados; não é um pentest nem certificação
de segurança. Não foi executado um instalador Windows.

## Falhas observadas e estado nesta alteração

| Gravidade | Falha e efeito | Evidência na base | Estado |
| --- | --- | --- | --- |
| Alta | HTML pode declarar um webview com opções privilegiadas; navegação `file:` da janela principal também não é restringida. | `src/viewer/renderer.js:235–241`, `1612–1618`; `main.js:668–674`, `762–778`. | Adicionadas restrições de guest (sem Node/preload, sandbox), bloqueio de navegação da janela, popups no browser e validação da origem IPC. Validação Electron/Windows ainda necessária. |
| Alta | Palavras-passe de módulos estão em texto simples e apenas bloqueiam a interface. Extrair o SFX dá acesso ao JSON e aos conteúdos. | `main.js:1180–1188`; `src/shared/iptv-cipher.js:74–87`; `src/viewer/renderer.js:634–637`, `1548–1557`. | Permanece. Para proteção efetiva, cifrar conteúdos ou usar autorização num serviço remoto. Hashar apenas a senha não protege assets já distribuídos. |
| Alta | Credenciais IPTV podem ser recuperadas pelo destinatário porque a chave e o descodificador são incluídos no produto. | `src/shared/iptv-cipher.js:20–21`, `37–48`; `main.js:961`. | Permanece. É ofuscação; usar tokens revogáveis por destinatário/intermediário autenticado se for necessário guardar segredo. |
| Alta | Substituir um asset pode apagar o antigo antes de a cópia/gravação terminar. Uma falha de disco deixa referências para ficheiros inexistentes. | `main.js:1223–1230`, `1299–1306`; também logos e banners em `1080–1083`, `1125–1160`. | Corrigida a ordem de gravação dos módulos de conteúdo, incluindo o novo importador. Logos, banners e ícones ainda precisam da mesma revisão transacional. |
| Alta | JSON escrito diretamente pode ficar parcial; falhas de leitura fazem aparecer defaults/projetos vazios. | `main.js:296–310`, `437–459`. | Gravação da configuração passou a temporário + rename. O índice de projetos e a recuperação de configurações corrompidas continuam por tratar; não há backup automático. |
| Média | Exportação ignora subpastas e erros de cópia, podendo indicar sucesso com conteúdos incompletos. | `main.js:1709–1715`. | Cópia recursiva passa a incluir subpastas e propagar erros. Módulos web são validados antes de exportar. Uma referência antiga para asset não-web já apagado ainda merece validação adicional. |
| Média | Mudar de projeto durante a compressão pode misturar conteúdos de A com ícone de B. | `main.js:1707–1723`, `1749–1752`; `src/builder/renderer.js:1738–1749`. | Novas operações do Builder que usam `assertBuilder` ficam bloqueadas enquanto decorre a exportação. É uma mitigação; operações assíncronas já iniciadas e o SFX Windows ainda precisam de validação. |
| Média | Captura de leads pode mostrar envio/desbloquear sem confirmar inscrição, incluindo falha de rede. | `src/viewer/renderer.js:1647–1671`: `no-cors`, resposta ignorada e desbloqueio no erro. | Permanece. Distinguir pedido enviado de inscrição confirmada e validar integrações suportadas. |

Os achados de senha legível e recuperação de credenciais IPTV foram verificados
com dados sintéticos. A perda de um asset no fluxo antigo foi reproduzida com
falha de cópia simulada em memória. Não foram usados dados/credenciais reais nem
executados exemplos de exploração de Electron.

## Outros riscos concretos

- `concatFilesToTarget` escreve diretamente sobre o `.exe` final. Se a concatenação
  falhar, pode truncar um executável anterior. Usar destino temporário e substituição
  só após sucesso.
- O projeto declara `electron: ^32.0.0`. Não foi feita uma auditoria de CVEs ou
  compatibilidade de atualização nesta tarefa. Rever/atualizar o runtime antes de
  distribuir; uma mudança de major exige testes do Viewer, PDF, IPTV e exportação.
- `scripts/prune-viewer-template.js` apaga ficheiros de avisos/licenças de terceiros.
  Verificar obrigações de redistribuição e preservar os avisos aplicáveis; esta
  revisão não constitui uma conclusão jurídica.
- A ausência de `ffmpeg.exe`, já documentada no projeto, limita reprodução IPTV.
  Analogamente, o novo suporte PHP requer preparar o runtime portátil antes do build.
- O módulo web usa uma sessão e porta HTTP novas por abertura. Cookies,
  localStorage e IndexedDB não persistem ao sair do módulo e regressar. Aplicações
  que guardam trabalho no browser necessitam de um desenho de persistência próprio.
- PHP importado executa código nativo com permissões do utilizador. O isolamento
  da página Electron não torna scripts PHP desconhecidos seguros. Diretórios
  importados e SFX são extraíveis; não colocar segredos privados nos conteúdos.

## Prioridade sugerida

1. Validar esta alteração em Windows com o runtime PHP preparado e um SFX exportado.
2. Corrigir recuperação/backup do índice, logos/banners/ícones e escrita do `.exe`.
3. Clarificar a proteção por senha/IPTV e rever captura de leads.
4. Atualizar Electron e verificar dependências, licenças e assinatura de código.

Referências técnicas primárias consultadas:
- https://www.electronjs.org/docs/latest/tutorial/security
- https://www.php.net/manual/en/features.commandline.webserver.php

O servidor PHP integrado é usado apenas localmente; não é disponibilizado como
servidor público de produção.

## Validação da alteração

`npm test`: 28 testes, 27 aprovados, 1 ignorado explicitamente porque não há PHP
nativo neste ambiente. Verificações de sintaxe JavaScript, JSON e whitespace
aprovadas. A suite usa ficheiros e HTTP locais reais, com funções IPC/Electron
verificadas através de stubs; não demonstra o comportamento real do Chromium.
A execução PHP, isolamento Electron em Windows e exportação SFX completa continuam
pendentes de validação na plataforma de destino.

## Atualização v2.0.0 — Windows e Mac

- A exportação SFX escreve agora num temporário e só substitui o destino no fim.
- O empacotamento preserva os avisos/licenças do Electron.
- Exportações ZIP validam referências a recursos, caminhos, CRC, colisões de nomes
  e symlinks. A cópia mantém intactos os bytes e permissões do bundle Mac.
- Dados de projetos Mac ficam numa pasta `.data` externa, preservando a assinatura.
- Exportações Mac bloqueiam módulos de execução Windows; PHP é validado no modelo
  da plataforma de destino.
- A pipeline compila em runners nativos, valida ambos os modelos incorporados e
  verifica assinatura ad-hoc e arquiteturas Mac. Certificados de editor e
  notarização não estão configurados.

As limitações de palavras-passe/IPTV, leads, persistência web, backup/recuperação
e alterações de logos/banners continuam por resolver. A versão Electron 32 foi
preservada nesta alteração; atualização e revisão de vulnerabilidades continuam
necessárias antes de distribuição pública. Os testes locais não substituem
validação manual dos quatro percursos de exportação em Windows e macOS.
