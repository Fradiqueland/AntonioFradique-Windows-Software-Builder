# Guia v2 — instalar o Builder e criar softwares Windows/Mac

## Os dois produtos

**Windows & Mac Software Builder v2.0.1** é o editor instalado no seu computador. Os **projetos exportados** são aplicações independentes que os destinatários abrem sem instalar o Builder.

| Instalador do Builder | Computador |
| --- | --- |
| Windows-Mac-Software-Builder-2.0.1-windows-x64-setup.exe | Windows x64 |
| Windows-Mac-Software-Builder-2.0.1-mac-universal.dmg | Mac Intel ou Apple Silicon |

O Setup Windows usa NSIS. O DMG contém uma aplicação universal. Windows não tem assinatura de editor; Mac usa assinatura ad-hoc, sem notarização Apple. Podem surgir avisos do sistema: confirme a origem e o checksum. Não é necessário desativar globalmente as proteções.

## Gerar os dois instaladores no GitHub

1. Abra **Actions → Build v2 Windows and Mac installers**.
2. Use a execução correspondente ao commit v2. O workflow inicia-se em pushes para main, master e branches codex/**, e em pull requests. Depois de integrado na branch predefinida, também pode usar **Run workflow**.
3. Aguarde os quatro jobs: dois modelos Viewer e dois instaladores Builder. Todos devem terminar com sucesso.
4. Em **Artifacts**, descarregue **Windows-Mac-Software-Builder-2.0.1-Windows** e **Windows-Mac-Software-Builder-2.0.1-macOS**.
5. Extraia cada ZIP de artefacto. Contém o instalador e SHA256SUMS.txt. Disponibilidade: 30 dias.

O workflow instala dependências pelo lockfile, executa testes, compila, verifica os modelos incorporados e, no Mac, valida a assinatura e as duas arquiteturas. Os logs são publicados mesmo em falha. Estas verificações não substituem testar manualmente os instaladores e os projetos nos computadores de destino.

Para comparar com SHA256SUMS.txt:

```powershell
Get-FileHash .\Windows-Mac-Software-Builder-2.0.1-windows-x64-setup.exe -Algorithm SHA256
```

```bash
shasum -a 256 Windows-Mac-Software-Builder-2.0.1-mac-universal.dmg
```

## Instalar

**Windows:** execute o Setup EXE, escolha a pasta e conclua o assistente. Abra **Windows & Mac Software Builder** pelo menu Iniciar.

**Mac:** abra o DMG, arraste **Windows & Mac Software Builder.app** para **Aplicações**, ejete o DMG e abra a aplicação. Se o macOS pedir autorização por não estar notarizada, use a opção individual em **Definições do Sistema → Privacidade e Segurança**, depois de confirmar a origem. A assinatura ad-hoc não identifica um editor perante a Apple.

## Atualizar da v2.0.0 para a v2.0.1

Instale o novo Builder e volte a exportar os projetos. Os softwares já exportados
incluem a cópia antiga do Viewer e não recebem esta correção automaticamente.
A v2.0.1 corrige a escrita de `app.asar`, os diretórios dos ZIPs Mac e a abertura
de links HTTP/HTTPS de páginas importadas no browser predefinido.

## Exportar os softwares criados

1. Crie/abra o projeto e guarde os conteúdos.
2. Em **Exportar**, selecione **Windows** ou **Mac**.
3. Confirme o formato apresentado, indique o nome e exporte.
4. Teste o pacote num computador do sistema escolhido antes de distribuir.

| Builder usado | Destino Windows | Destino Mac |
| --- | --- | --- |
| Windows | EXE único, extrai e abre o Viewer | ZIP: Nome.app + Nome.data/ |
| Mac | ZIP portátil: EXE e dependências | ZIP: Nome.app + Nome.data/ |

O EXE de projeto é auto-extraível, não um instalador NSIS. Sem ferramentas SFX numa instalação de desenvolvimento, a exportação Windows usa ZIP; os instaladores do Builder exigem essas ferramentas no build.

No ZIP Windows, extraia **toda a pasta** e abra **LaunchBox Viewer.exe**. Não distribua só esse executável.

No ZIP Mac, mantenha a aplicação e a pasta **.data** juntas. Para instalar em Aplicações, mova os dois elementos para uma pasta própria. Se mover apenas a aplicação, ou se o macOS a abrir numa localização temporária, selecione a pasta .data correta no diálogo apresentado.

Os dados ficam fora do bundle Mac para preservar a assinatura. O ícone personalizado aplica-se ao EXE SFX gerado no Windows; os ZIPs mantêm o ícone do modelo. Módulos que executam programas Windows (.exe, .msi, .bat, etc.) bloqueiam a exportação Mac; os mesmos ficheiros podem continuar em módulos de Downloads.

## Compilar localmente

Requisitos: Node.js 22, Git e ferramentas nativas. No Mac, instale as Command Line Tools do Xcode. Os modelos devem corresponder à **mesma versão do código**. Um PC Windows não gera nativamente o modelo Mac nem o DMG.

```bash
cd "AntonioFradique.net Windows Software Builder"
npm ci
npm test
```

No Windows:

```bash
npm run build:viewer:win
```

No Mac:

```bash
npm run build:viewer:mac
```

Reúna estes quatro ficheiros em **dist/export-templates/** de cada máquina que vai criar um instalador, ou descarregue os artefactos export-template-* da mesma execução:

- windows-x64.zip
- windows-x64.manifest.json
- mac-universal.zip
- mac-universal.manifest.json

```bash
npm run check:templates
```

No Windows:

```bash
npm run build:builder:win
npm run verify:package
npm run checksums
```

No Mac:

```bash
npm run build:builder:mac
npm run verify:package
npm run checksums
```

Os instaladores ficam em **dist/builder/**. O comando **npm run build:all** gera o modelo da máquina atual e depois o Builder, mas precisa do modelo do outro sistema previamente colocado em dist/export-templates/.

## PHP e ffmpeg opcionais

HTML funciona sem runtime adicional. Prepare os binários, dependências e licenças **antes** de gerar os modelos e os Builders:

| Plataforma | PHP | ffmpeg |
| --- | --- | --- |
| Windows | vendor/php/windows-x64/php.exe | vendor/ffmpeg/windows-x64/ffmpeg.exe |
| Mac universal | vendor/php/mac-universal/php | vendor/ffmpeg/mac-universal/ffmpeg |

Os caminhos antigos vendor/php/php.exe e vendor/ffmpeg/ffmpeg.exe continuam aceites apenas no Windows. No Mac, forneça binários universais com dependências relocáveis. O build verifica Intel e Apple Silicon nos binários principais; teste a execução sem depender de runtimes instalados no sistema.

O repositório e o workflow não descarregam estes runtimes. Sem PHP, pode importar ficheiros, mas a pré-visualização PHP e a exportação para um modelo sem PHP são bloqueadas. Consulte [os limites do importador](IMPORTAR-HTML-PHP.md), incluindo a ausência de persistência de cookies/localStorage entre aberturas.

Não inclui iOS, notarização Apple, certificados Windows, atualização automática dos projetos ou proteção dos conteúdos contra extração.
