# Windows & Mac Software Builder — v2.1

Crie aplicações de conteúdos para **Windows e Mac**: cursos, bibliotecas, apresentações, páginas HTML/PHP, documentos e multimédia. Organize os módulos, personalize o aspeto e escolha a plataforma ao exportar.

O **Builder** é o programa de edição instalado no seu computador. As **aplicações exportadas** são os produtos que cria e distribui; os destinatários não precisam de instalar o Builder.

## Descarregar e instalar o Builder

Na [compilação v2.1 do GitHub Actions](https://github.com/Fradiqueland/AntonioFradique-Windows-Software-Builder/actions/workflows/build-v2-installers.yml), abra uma execução concluída com sucesso e descarregue os artefactos correspondentes:

| Computador | Artefacto v2.1 | Instalador incluído |
| --- | --- | --- |
| Windows x64 | `Windows-Mac-Software-Builder-2.1.0-Windows` | Setup `.exe` |
| Mac Intel ou Apple Silicon | `Windows-Mac-Software-Builder-2.1.0-macOS` | `.dmg` universal |

Os downloads requerem uma sessão GitHub e ficam disponíveis durante 30 dias após a execução. Extraia o ZIP do artefacto para obter o instalador e `SHA256SUMS.txt`. Certifique-se de que a execução e o instalador são da versão 2.1.0; instaladores anteriores não incluem o módulo portable.

No Windows, execute o Setup. No Mac, abra o DMG e arraste **Windows & Mac Software Builder.app** para **Aplicações**. O instalador Windows não tem assinatura de editor; a aplicação Mac tem assinatura ad-hoc e não está notarizada pela Apple. O [guia de instalação](Windows-Mac-Software-Builder/BUILD-V2.md) explica a verificação dos ficheiros e as autorizações individuais do sistema.

## O que pode criar

- Projetos com módulos de texto/HTML, ficheiros `.html`, `.htm` e `.php`, PDF, imagens, vídeo, áudio e downloads.
- [Software portable](Windows-Mac-Software-Builder/PORTABLE.md): importa a pasta, identifica executáveis e abre a versão Windows ou Mac; Wine externo opcional no Mac.
- Módulos YouTube, sites incorporados, links externos, artigos, embeds e IPTV.
- Produtos com título, logótipo, cores, banners, redes sociais e formulários de captura de contactos.
- Aplicações Windows e Mac com os conteúdos e recursos do projeto incluídos.

PHP e o motor ffmpeg são opcionais: os seus binários não estão incluídos no repositório nem são descarregados pelo workflow. HTML funciona sem PHP; páginas PHP precisam de um runtime compatível incluído no Builder e no modelo de exportação.

## Exportar os seus produtos

Em **Publicar → Exportar**, selecione **Windows** ou **Mac**. Cada instalador do Builder inclui os modelos dos dois sistemas.

| Sistema onde utiliza o Builder | Exportar para Windows | Exportar para Mac |
| --- | --- | --- |
| Windows x64 | EXE único auto-extraível | ZIP com aplicação `.app` universal e pasta `.data` |
| Mac Intel / Apple Silicon | ZIP portátil com EXE e dependências | ZIP com aplicação `.app` universal e pasta `.data` |

Estes produtos são diferentes dos instaladores do Builder. Extraia o ZIP completo antes de abrir um produto. No Mac, mantenha a `.app` e a pasta `.data` juntas; no Windows portátil, mantenha o EXE e as suas dependências juntos. Para distribuir nas duas plataformas, exporte o projeto duas vezes.

O ícone personalizado aplica-se ao EXE auto-extraível gerado no Windows. Os ZIPs conservam o ícone do visualizador. Programas incluídos num módulo de execução têm de ser compatíveis com o destino; programas Windows não se tornam aplicações Mac por serem importados.

## Como funcionam os links

Os links externos HTTP/HTTPS de páginas HTML/PHP importadas abrem no browser predefinido após clique ou ativação por teclado. Os links do HTML principal, dos artigos, dos banners e dos módulos de link externo também podem encaminhar o utilizador para o browser.

Esta regra não é universal: a navegação entre páginas da mesma origem local mantém-se no módulo importado; sites incorporados, PDF, YouTube e streams continuam a ser apresentados dentro da aplicação. Popups automáticos de páginas importadas não são encaminhados para o sistema.

## Documentação e desenvolvimento

- [Guia de compilação, instalação e exportação](Windows-Mac-Software-Builder/BUILD-V2.md)
- [Importar e executar software portable](Windows-Mac-Software-Builder/PORTABLE.md)
- [Importar HTML/PHP e conhecer os limites](Windows-Mac-Software-Builder/IMPORTAR-HTML-PHP.md)
- [Auditoria do produto e atualizações v2](Windows-Mac-Software-Builder/AUDITORIA-2026-10-04.md)
- [Arquitetura e notas de manutenção](Windows-Mac-Software-Builder/NOTAS.md)
- [README da aplicação](Windows-Mac-Software-Builder/README.md)

Requisitos de desenvolvimento: **Node.js 22**, Git e Windows x64 ou macOS.

```bash
cd Windows-Mac-Software-Builder
npm ci
npm test
npm start
```

O workflow **Build v2 Windows and Mac installers** compila os modelos e instaladores em máquinas nativas. Para builds locais, reúna os modelos Windows e Mac da mesma versão antes de compilar o Builder, conforme o guia.

## Limites atuais

A versão 2.1 não exporta para iOS. Os conteúdos distribuídos são extraíveis; as palavras-passe dos módulos e a ofuscação IPTV não são proteção contra extração. A captura de contactos não confirma, por si só, a inscrição no fornecedor. Páginas importadas não mantêm cookies, `localStorage` ou IndexedDB entre aberturas do módulo.

Ao atualizar o Builder, volte a exportar os projetos: os produtos anteriormente distribuídos não se atualizam automaticamente. Teste os instaladores e os produtos em computadores dos sistemas de destino antes de os distribuir.
