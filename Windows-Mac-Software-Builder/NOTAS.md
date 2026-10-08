# Notas técnicas — Windows & Mac Software Builder v2.5

Documento de manutenção do Builder e do Viewer. Para compilar, instalar ou distribuir, siga [BUILD-V2.md](BUILD-V2.md). A auditoria datada em [AUDITORIA-2026-10-04.md](AUDITORIA-2026-10-04.md) conserva a análise da base antiga e as atualizações v2; não deve ser lida como uma certificação de segurança da versão atual.

## Arquitetura atual

O projeto usa Electron 44.6.0 e electron-builder. `resources/app-mode.json` distingue os modos `builder` e `viewer`, que partilham o processo principal e os módulos em `src/shared/`.

| Componente | Função |
| --- | --- |
| `src/builder/` e `preload.js` | Editor de projetos, conteúdos, aparência e exportação |
| `src/viewer/` e `preload-viewer.js` | Aplicação que apresenta o produto ao destinatário |
| `main.js` | Janelas, IPC autorizado, projetos, runtimes locais e exportação |
| `src/shared/local-web.js` | Importação e serviço local de HTML/PHP |
| `src/shared/project-export.js` | Validação dos modelos e exportação dos pacotes ZIP |
| `src/shared/electron-security.js` | Isolamento das páginas incorporadas e política de navegação |
| `build-configs/` e `scripts/` | Builds nativos, modelos, assinatura ad-hoc Mac e verificações |

O nome público é **Windows & Mac Software Builder**. Identificadores internos como `launchbox-pro`, `LaunchBox Builder` e `LaunchBox Viewer` ainda aparecem em nomes de processos, caminhos e formatos: não os substituir indiscriminadamente, pois alguns mantêm a compatibilidade com projetos e dados existentes.

## Instalação e exportação são operações distintas

| Operação | Windows | Mac |
| --- | --- | --- |
| Instalar o Builder | Setup NSIS `.exe`, x64 | `.dmg`, aplicação universal Intel/Apple Silicon |
| Exportar um projeto no Windows | EXE SFX auto-extraível | ZIP: `Nome.app` + `Nome.data/` |
| Exportar um projeto no Mac | ZIP portátil Windows | ZIP: `Nome.app` + `Nome.data/` |

Ambos os instaladores incluem os modelos Windows e Mac. O produto exportado incorpora o Viewer e os conteúdos, sem depender de uma instalação do Builder no computador do destinatário.

O EXE de projeto não é o instalador NSIS. Usa um stub 7-Zip SFX e extrai uma aplicação temporária antes de a abrir. Na configuração de desenvolvimento sem ferramentas SFX, a exportação Windows pode recorrer ao ZIP; os builds dos instaladores verificam as ferramentas obrigatórias.

No Mac, os dados do projeto ficam **fora** do bundle `.app`, numa pasta `.data` irmã. A exportação preserva os bytes, permissões e ligações simbólicas do modelo, mantendo a assinatura ad-hoc. Alterar ficheiros dentro da `.app` depois de assinar invalida a assinatura. Se os dados não estiverem na localização esperada — incluindo a abertura por App Translocation — o Viewer permite selecionar a pasta `.data`.

O ícone personalizado é aplicado ao EXE SFX no Windows; os ZIPs mantêm o ícone do modelo. A exportação Mac bloqueia módulos de execução que apontam para programas Windows. Um ficheiro desses pode continuar a ser oferecido para download, sem promessa de execução no Mac.

## Fluxo de compilação

Use Node.js 22 e compile cada modelo na plataforma nativa. O workflow na raiz do repositório faz quatro trabalhos principais: modelo Windows, modelo Mac, instalador Windows e instalador Mac.

1. Instalar pelo lockfile e executar os testes.
2. Gerar os modelos com `npm run build:viewer:win` no Windows e `npm run build:viewer:mac` no Mac.
3. Reunir os dois ZIPs e os dois manifestos em `dist/export-templates/`, sempre da mesma versão do código.
4. Executar `npm run check:templates` e criar o instalador com `build:builder:win` ou `build:builder:mac`.
5. Verificar o pacote e gerar os checksums. No Mac, verificar as arquiteturas e a assinatura.
6. Instalar e testar os produtos exportados nos sistemas de destino.

`npm run build:all` gera o modelo da máquina atual e o Builder, mas continua a precisar do modelo do outro sistema. Um Windows não produz nativamente o modelo Mac ou o DMG. Comandos completos e caminhos dos artefactos estão no [guia de build](BUILD-V2.md).

Depois de qualquer alteração no Viewer, reconstrua **os dois modelos**, os instaladores e os produtos que pretende distribuir. Atualizar o Builder não altera os EXEs ou ZIPs anteriormente exportados.

## Projetos, recursos e persistência

O Builder instalado guarda os projetos na sua pasta `userData`, com configuração e recursos separados por projeto. Em desenvolvimento, os caminhos partem da pasta do código. O Viewer lê os conteúdos incluídos na exportação: `resources/data` e `resources/dist-assets` no Windows; a pasta `.data` externa no Mac.

A localização do cache Electron varia por formato:

- No EXE SFX Windows, fica junto do Viewer extraído em `%TEMP%` e é descartado com essa extração.
- No Windows portátil, fica junto do executável em `.electron-cache`.
- No Mac, fica em dados do utilizador, fora da `.app`, para não modificar o bundle assinado.

Favoritos IPTV e estado de retoma usam IPC (`favs:load/save`, `state:load/save`) e ficheiros próprios nos dados do utilizador. Não devem depender apenas de `localStorage`, pois o cache do SFX é temporário.

O armazenamento de uma **página HTML/PHP importada** é um caso separado: cada abertura usa uma origem e sessão novas. Cookies, `localStorage` e IndexedDB não sobrevivem à reabertura do módulo. Scripts PHP que escrevem em ficheiros também precisam de um desenho de persistência próprio; a pasta temporária do SFX não é armazenamento durável.

A gravação da configuração usa ficheiro temporário e substituição. Na substituição de recursos de módulos, a cópia antiga só é recolhida depois da nova configuração. O índice de projetos, a recuperação de corrupção, os backups e outras operações com recursos continuam a precisar da atenção descrita na auditoria.

## HTML/PHP e isolamento

O importador aceita `.html`, `.htm` e `.php`, com cópia opcional da pasta da página inicial e respetivas subpastas. Valida limites, caminhos e tipos de ficheiro; rejeita ligações simbólicas e ficheiros especiais. Importar cria uma cópia: editar o ficheiro original depois disso não atualiza automaticamente o projeto.

Cada abertura serve o módulo em `127.0.0.1`, numa porta aleatória, com autorização local e sessão separada. A página incorporada não recebe preload, integração Node ou a ponte IPC do Viewer. O isolamento do browser **não** restringe o PHP às permissões de uma página web: o processo PHP executa com as permissões da conta do utilizador.

PHP é opcional e tem de ser incluído no Builder e nos modelos que o utilizam. O PHP instalado no `PATH` não substitui o runtime portátil esperado. O runtime não fornece automaticamente bases de dados, Composer, Apache, extensões ou regras `.htaccess`. Consulte [IMPORTAR-HTML-PHP.md](IMPORTAR-HTML-PHP.md).

## Política de links e navegação

Não existe uma regra de «todos os links saem da aplicação».

| Origem ou conteúdo | Comportamento |
| --- | --- |
| HTML/PHP importado: link HTTP/HTTPS externo | Browser predefinido após clique ou ativação por teclado |
| HTML/PHP importado: página da mesma origem local | Navegação dentro do módulo |
| HTML principal, artigos, banners e módulos de link externo | Links externos encaminhados para o browser |
| Sites incorporados | Navegação permitida dentro do webview |
| PDF, YouTube e streams | Conteúdo apresentado na aplicação |
| Popup externo automático de página importada | Bloqueado; não abre o browser |

A janela principal do Viewer não pode abandonar a sua página. Os webviews não recebem privilégios Node. A política de páginas importadas usa eventos de entrada nativos para autorizar uma única abertura externa por ativação recente, incluindo `target="_blank"` e `window.open` acionados pelo utilizador. Redirecionamentos de servidor não contam como uma nova ativação. Esquemas como `file:` e `javascript:` não são encaminhados para o sistema.

Ao alterar esta área, preserve a navegação interna dos sites e os leitores embutidos. Verifique links normais, teclado, novas janelas, redirecionamentos e popups sem interação; não valide apenas uma chamada isolada a `shell.openExternal`.

## YouTube e IPTV: decisões que devem ser preservadas

O YouTube é apresentado a partir de uma página servida em `127.0.0.1`, com porta aleatória (`ensureYoutubeHost`), e aberta num webview. Isto evita depender de um iframe diretamente em `file://`. O User-Agent usa a versão Chromium sem o identificador Electron. A disponibilidade da reprodução continua dependente do vídeo, do serviço e das regras do fornecedor.

O IPTV tenta os motores definidos em `renderIptv`/`buildAttempts`:

| Motor | Utilização |
| --- | --- |
| HLS (`hls.js`) | Listas HLS e primeira tentativa de vários streams Xtream |
| Proxy ffmpeg local | Alternativa para streams incompatíveis com o leitor MSE |
| TS (`mpegts.js`) | Alternativa de reprodução MPEG-TS |
| Nativo | Formatos diretamente suportados pelo Chromium |

O diagnóstico usa frames apresentados, quando disponíveis, e não apenas o evento `playing`: um stream pode anunciar reprodução e continuar com ecrã preto. A compatibilidade de canais entrelaçados foi uma fonte de falhas nas versões anteriores.

O proxy FFmpeg converte vídeo para H.264 Main progressivo, até 720p/30 fps, e áudio para AAC, servindo MP4 fragmentado. Consulte [IPTV.md](IPTV.md). Preserve o ciclo de vida do pipe: chamar `res.end()` manualmente ao terminar o processo já causou `write after end` ao trocar de canal. O código encerra conexões e processos ao mudar de conteúdo.

As alterações IPTV de cabeçalhos e CORS têm âmbito restrito. Não as aplicar indiscriminadamente aos webviews ou aos serviços Google: isso já interferiu com pedidos autenticados do YouTube. `stageGeneration` impede renderers assíncronos de substituírem um módulo aberto entretanto.

## Runtimes opcionais e distribuição

Os binários PHP e FFmpeg não estão incluídos no Git. O workflow compila FFmpeg a partir de fontes fixadas e verificadas e inclui-o no Builder. PHP precisa de preparação própria. Os caminhos preferidos são específicos da plataforma:

| Plataforma | PHP | ffmpeg |
| --- | --- | --- |
| Windows x64 | `vendor/php/windows-x64/php.exe` | `vendor/ffmpeg/windows-x64/ffmpeg.exe` |
| Mac universal | `vendor/php/mac-universal/php` | `vendor/ffmpeg/mac-universal/ffmpeg` |

O caminho antigo `vendor/php/php.exe` continua aceite no Windows. No Mac, os binários principais devem incluir Intel e Apple Silicon, com dependências relocáveis. Na v2.5, os produtos exportados incluem FFmpeg apenas com IPTV e PHP apenas com páginas que o exijam. Os runtimes Mac ficam na pasta `.data`, fora do bundle assinado; os modelos antigos mantêm os runtimes internos. As fontes FFmpeg/x264 são partilhadas dentro do Builder e repostas por inteiro nas exportações IPTV. Consulte [PACKAGING-V2.5.md](PACKAGING-V2.5.md) para o layout e as verificações. Inclua as licenças e avisos aplicáveis e teste numa máquina sem esses runtimes instalados.

O instalador Windows não tem assinatura de editor. As aplicações Mac usam assinatura ad-hoc, sem identidade Developer ID nem notarização Apple. Esta assinatura permite verificar a integridade do bundle, mas não identifica o editor perante a Apple. Não é necessário desativar globalmente as proteções do sistema para seguir o procedimento individual do guia.

## Limites e manutenção

- O bloqueio de módulos por palavra-passe não cifra os recursos; o destinatário pode extrair os conteúdos e a configuração.
- A ofuscação das credenciais IPTV não garante segredo, porque o produto inclui os meios de descodificação.
- O formulário de contactos pode enviar um pedido sem confirmar uma inscrição no fornecedor; não o tratar como prova de subscrição.
- A atualização do Electron e a revisão de vulnerabilidades continuam necessárias; esta versão utiliza Electron 44.6.0.
- APK continua indisponível: o cartão experimental apresenta informação, sem importar ou executar aplicações Android. Consulte [ANDROID-APK.md](ANDROID-APK.md).
- Não há exportação iOS, atualização automática dos produtos nem backup/recuperação completos dos projetos.
- A versão de distribuição vem de `package.json`; mantenha o lockfile, os textos de fallback da interface e a documentação coerentes.
- Novas chaves de interface devem existir nos 10 ficheiros `locales/*.json`. As novas mensagens v2 têm PT/EN; as restantes línguas usam inglês nessas mensagens.

`npm test` verifica o código e os fluxos locais. Existem smoke tests Electron (`npm run test:electron` e `npm run test:electron:packaged`) para exercitar o motor com modelos reais. Os testes que exigem PHP podem ser ignorados quando o runtime está ausente; isso não demonstra que PHP funciona. A execução dos testes e o build não substituem instalar e abrir os produtos em Windows e Mac.

## Histórico de referência

- **v1.5.6–v1.5.7:** favoritos persistentes, YouTube em origem HTTP local, opt-in, links e M3U.
- **v1.5.8–v1.5.10:** separadores Projetos/Conteúdo/Aparência/Publicar, cartões de módulos, secções recolhíveis, redes sociais e retoma do Viewer.
- **v1.5.11–v1.5.18:** âmbito do CORS, motores IPTV e diagnóstico.
- **v1.5.19–v1.5.20:** proxy ffmpeg e correção do encerramento do pipe.
- **Importação HTML/PHP:** cópia de recursos, serviço local isolado, validação de ficheiros e melhorias na gravação/exportação.
- **v2.0.0:** nome Windows & Mac Software Builder, Builder para os dois sistemas, seleção do destino, modelos portáteis e bundle Mac universal com dados externos.
- **v2.0.1:** escrita física de `app.asar` com `original-fs`, tratamento das entradas de diretório nos ZIPs Mac e abertura autorizada de links externos de páginas importadas. Produtos antigos precisam de ser reexportados para incorporar estas correções.
- **v2.1:** módulo portable e correções de gravação e navegação. **v2.1.1:** FFmpeg incorporado e conversão real IPTV.
- **v2.5:** compressão sem perdas, seleção dos runtimes nas exportações, deduplicação verificada de fontes no Builder e informação experimental sobre Android/APK. Os instaladores são publicados numa Release depois das verificações nativas.
