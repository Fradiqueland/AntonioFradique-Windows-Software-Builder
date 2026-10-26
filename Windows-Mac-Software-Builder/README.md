# Windows & Mac Software Builder — v2.6.6

Editor Electron para criar aplicações de conteúdos em Windows e macOS. O Builder permite gerir projetos, personalizar a apresentação e exportar produtos independentes para os dois sistemas.

A v2.6.6 inclui créditos com fotografia e link no menu e uma barra de progresso com percentagem nas exportações Windows e Mac.

Consulte [as alterações da v2.6.6](V2.6.6.md) e [da v2.6](V2.6.md). **A importação e execução APK ainda não estão disponíveis**; o cartão experimental apresenta o estado e os requisitos.

## Builder e produtos exportados

| Elemento | Windows | Mac |
| --- | --- | --- |
| Instalação do Builder | Setup `.exe` para Windows x64 | `.dmg` universal para Intel e Apple Silicon (macOS 13+) |
| Produto exportado no Builder Windows | EXE único auto-extraível | ZIP com `.app` universal e pasta `.data` |
| Produto exportado no Builder Mac | ZIP portátil com EXE e dependências | ZIP com `.app` universal e pasta `.data` |

Os dois instaladores incluem os dois modelos de exportação. O destinatário de um produto não precisa de instalar o Builder. Num ZIP Windows, deve extrair e manter todos os ficheiros; num ZIP Mac, deve manter a aplicação e a pasta `.data` juntas.

O ícone personalizado aplica-se ao EXE auto-extraível gerado no Windows. Os ZIPs mantêm o ícone do modelo. O novo módulo **Software portable** permite incluir a pasta completa e selecionar entradas Windows e Mac. Pode autorizar Wine externo para tentar programas Windows no Mac. A exportação Mac rejeita programas Windows do módulo antigo **Lançar ficheiro**; esses ficheiros podem continuar a ser disponibilizados em módulos de Downloads.

Os [instaladores v2.6.6](https://github.com/Fradiqueland/AntonioFradique-Windows-Software-Builder/releases/tag/v2.6.6) são publicados em **Releases → Assets**, acompanhados por `SHA256SUMS.txt` e relatórios dos tamanhos medidos. A publicação exige sucesso das [compilações e verificações nativas](https://github.com/Fradiqueland/AntonioFradique-Windows-Software-Builder/actions/workflows/build-v2-installers.yml) dos dois instaladores. O repositório privado exige acesso autorizado para descarregar.

## Transferir projetos editáveis

Em **Projetos → Exportar projeto**, guarde o arquivo `.wsmb` com definições, módulos e recursos. Use **Importar projeto** para criar uma cópia independente sem substituir projetos existentes. Guarde primeiro os módulos em edição. Consulte [o formato e as correções da v2.6](V2.6.md).

## Criar um produto

1. Crie ou abra um projeto em **Projetos**.
2. Adicione módulos em **Conteúdo**: texto/HTML, ficheiros HTML/PHP, PDF, vídeo, áudio, galeria, downloads, artigos, YouTube, sites, links, IPTV ou software portable.
3. Defina título, cores e logótipo em **Aparência**; configure os extras de que precisa.
4. Utilize a pré-visualização para verificar o conteúdo.
5. Em **Publicar → Exportar**, escolha **Windows** ou **Mac**, confirme o formato apresentado e exporte.
6. Teste o produto no sistema de destino. Exporte uma vez por plataforma para entregar as duas versões.

A importação HTML/PHP pode copiar a pasta da página inicial com CSS, JavaScript, imagens e subpastas. Guarde nessa pasta apenas os recursos que pretende distribuir. Para atualizar a cópia importada, volte a selecionar o ficheiro principal.

FFmpeg é compilado a partir de fontes fixadas, incluído no Builder e apenas nos produtos exportados com IPTV. Quando a reprodução direta IPTV falha, o leitor tenta converter o canal para H.264/AAC compatível. A conversão usa o processador e limita o vídeo a 720p/30 fps. Consulte [IPTV.md](IPTV.md).

PHP continua opcional. HTML funciona sem PHP. Projetos PHP exigem um runtime incluído para a plataforma do Builder e para cada destino utilizado; consulte os guias abaixo.

## Navegação e links

Links HTTP/HTTPS externos de páginas HTML/PHP importadas abrem no browser predefinido após clique ou ativação por teclado. Links do HTML principal, artigos, banners e módulos de link externo são encaminhados para o browser quando aplicável.

A navegação interna entre páginas da mesma origem local continua no módulo importado. Sites incorporados, PDF, YouTube e streams continuam dentro da aplicação. Isto não significa que todos os links de todos os módulos sejam externos; popups automáticos de páginas importadas não abrem o browser.

## Documentação

- [Compilação, instalação e exportação](BUILD-V2.md)
- [Software portable: importação, execução e limites de compatibilidade](PORTABLE.md)
- [IPTV: reprodução, conversão e diagnóstico](IPTV.md)
- [Importação HTML/PHP e persistência](IMPORTAR-HTML-PHP.md)
- [Runtime PHP opcional](vendor/php/README.md)
- [Revisão de bugs e correções v2.1](AUDITORIA-V2.1.md)
- [Auditoria e limitações conhecidas](AUDITORIA-2026-10-04.md)
- [Arquitetura e notas de manutenção](NOTAS.md)

A captura de contactos não garante confirmação da inscrição no fornecedor. As palavras-passe dos módulos e a ofuscação IPTV não impedem a extração dos conteúdos. As páginas importadas usam uma sessão nova em cada abertura e não conservam cookies, `localStorage` ou IndexedDB. Não há exportação iOS nem atualização automática dos produtos distribuídos.

## Desenvolvimento e compilação

Use Node.js 22, Git e Windows x64 ou macOS. A partir da raiz do repositório:

```bash
cd Windows-Mac-Software-Builder
npm ci
npm test
npm start
```

O workflow **Build Windows and Mac installers**, na pasta `.github/workflows/` da raiz, compila os dois modelos Viewer e os dois instaladores Builder em máquinas nativas. Para builds locais, reúna os modelos Windows e Mac da **mesma versão do código** antes de criar qualquer instalador, conforme [BUILD-V2.md](BUILD-V2.md).

Depois de alterar o Viewer ou atualizar o Builder, reconstrua os modelos e volte a exportar os projetos. Os produtos já distribuídos conservam a versão que foi incluída na sua exportação.
