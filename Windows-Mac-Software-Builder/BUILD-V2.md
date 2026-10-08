# Guia v2.5 — instalar o Builder e criar softwares Windows/Mac

## Os dois produtos

**Windows & Mac Software Builder v2.5.0** é o editor instalado no seu computador. Os **projetos exportados** são aplicações independentes que os destinatários abrem sem instalar o Builder.

| Instalador do Builder | Computador |
| --- | --- |
| Windows-Mac-Software-Builder-2.5.0-windows-x64-setup.exe | Windows x64 |
| Windows-Mac-Software-Builder-2.5.0-mac-universal.dmg | Mac Intel ou Apple Silicon com macOS 13 ou posterior |

O Setup Windows usa NSIS. O DMG contém uma aplicação universal. Windows não tem assinatura de editor; Mac usa assinatura ad-hoc, sem notarização Apple. Podem surgir avisos do sistema: confirme a origem e o checksum. Não é necessário desativar globalmente as proteções.

## Gerar os dois instaladores no GitHub

1. Abra **Actions → Build v2 Windows and Mac installers**.
2. Use a execução correspondente ao commit v2. O workflow inicia-se em pushes para main, master e branches codex/**, e em pull requests. Depois de integrado na branch predefinida, também pode usar **Run workflow**.
3. Aguarde os sete jobs: FFmpeg Windows x64, Mac Intel e Mac ARM64, dois modelos Viewer e dois instaladores Builder. Todos devem terminar com sucesso.
4. Em **Artifacts**, descarregue **Windows-Mac-Software-Builder-2.5.0-Windows** e **Windows-Mac-Software-Builder-2.5.0-macOS**.
5. Extraia cada ZIP de artefacto. Contém o instalador e SHA256SUMS.txt. Disponibilidade: 30 dias.

O workflow instala dependências pelo lockfile, executa testes, compila e verifica os modelos incorporados. Valida a conversão IPTV com FFmpeg e a apresentação de vários fotogramas no Electron, utilizando um vídeo sintético servido localmente, tanto no código fonte como no pacote. No Mac, valida a assinatura e as duas arquiteturas. Os logs são publicados mesmo em falha. Estas verificações não substituem testar manualmente os instaladores e os projetos nos computadores de destino.

Para comparar com SHA256SUMS.txt:

```powershell
Get-FileHash .\Windows-Mac-Software-Builder-2.5.0-windows-x64-setup.exe -Algorithm SHA256
```

```bash
shasum -a 256 Windows-Mac-Software-Builder-2.5.0-mac-universal.dmg
```

## Instalar

A v2.5 utiliza Electron 44.6.0. Requer Windows 10 ou posterior (x64) ou macOS 13 Ventura ou posterior (Intel/Apple Silicon). A atualização do motor deixa de suportar versões antigas de macOS.

**Windows:** execute o Setup EXE, escolha a pasta e conclua o assistente. Abra **Windows & Mac Software Builder** pelo menu Iniciar.

**Mac:** abra o DMG, arraste **Windows & Mac Software Builder.app** para **Aplicações**, ejete o DMG e abra a aplicação. Se o macOS pedir autorização por não estar notarizada, use a opção individual em **Definições do Sistema → Privacidade e Segurança**, depois de confirmar a origem. A assinatura ad-hoc não identifica um editor perante a Apple.

## Atualizar para a v2.5.0

Instale o novo Builder e volte a exportar os projetos. Os softwares já exportados
incluem a cópia antiga do Viewer e não recebem esta correção automaticamente.
A v2.1 acrescenta o módulo Software portable, execução nativa Windows/Mac e Wine externo opcional no Mac. Consulte [PORTABLE.md](PORTABLE.md). Inclui também correções de gravação, navegação e ciclo de vida dos módulos.
Mantém as correções IPTV da v2.1.1, incluindo conversão real com FFmpeg. Na v2.5, os projetos sem IPTV deixam de incluir esse runtime. Consulte [IPTV.md](IPTV.md) e [V2.5.md](V2.5.md).

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

Os dados ficam fora do bundle Mac para preservar a assinatura. O ícone personalizado aplica-se ao EXE SFX gerado no Windows; os ZIPs mantêm o ícone do modelo. O módulo antigo Lançar ficheiro bloqueia programas Windows na exportação Mac; o módulo Software portable permite Wine externo se expressamente autorizado; os mesmos ficheiros podem continuar em módulos de Downloads.

## Compilar localmente

Requisitos: Node.js 22, Git e ferramentas nativas. No Mac, instale as Command Line Tools do Xcode. Os modelos devem corresponder à **mesma versão do código**. Um PC Windows não gera nativamente o modelo Mac nem o DMG.

```bash
cd "Windows-Mac-Software-Builder"
npm ci
npm test
```

Antes de compilar os modelos, prepare o FFmpeg obrigatório conforme a secção abaixo ou instale os artefactos `ffmpeg-native-*` da mesma execução do workflow.

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

## FFmpeg obrigatório e PHP opcional

HTML funciona sem PHP. Prepare os runtimes **antes** de gerar os modelos e os Builders:

| Plataforma | PHP | ffmpeg |
| --- | --- | --- |
| Windows | vendor/php/windows-x64/php.exe | vendor/ffmpeg/windows-x64/ffmpeg.exe |
| Mac universal | vendor/php/mac-universal/php | vendor/ffmpeg/mac-universal/ffmpeg |

O FFmpeg inclui `ffprobe`, os arquivos das fontes exatas FFmpeg/x264, licenças GPL e a receita de compilação. O workflow compila os três alvos nativamente e reúne os binários Mac com `lipo`; não usa um executável Windows no Mac. A ausência ou inconsistência do FFmpeg bloqueia o build.

Para compilar o FFmpeg localmente, siga [vendor/ffmpeg/README.md](vendor/ffmpeg/README.md). No Windows, use MSYS2 MINGW64 com GCC, NASM, pkg-config e make. No Mac, use Xcode Command Line Tools, NASM e pkg-config. Execute na plataforma e arquitetura correspondentes:

```bash
bash scripts/build-ffmpeg.sh windows-x64
# Num Mac Intel:
bash scripts/build-ffmpeg.sh mac-x64
# Num Mac Apple Silicon:
bash scripts/build-ffmpeg.sh mac-arm64
```

Cada comando cria `dist/runtime-native/<alvo>.tar.gz`. Reúna os arquivos dos dois Macs em `dist/runtime-native/` numa máquina Mac e execute:

```bash
node scripts/install-ffmpeg-runtime.js mac-universal
```

Para instalar o arquivo Windows em `dist/runtime-native/`, execute no Windows:

```bash
node scripts/install-ffmpeg-runtime.js windows-x64
```

Estes comandos verificam as fontes, os binários e uma conversão local. O build volta a validar o runtime, e os testes nativos verificam o FFmpeg que ficou efetivamente dentro do pacote.

PHP não é descarregado pelo workflow. O caminho antigo `vendor/php/php.exe` continua aceite apenas no Windows. No Mac, prepare um PHP universal com dependências relocáveis. Sem PHP, pode importar ficheiros, mas a pré-visualização PHP e a exportação para um modelo sem PHP são bloqueadas. Consulte [os limites do importador](IMPORTAR-HTML-PHP.md), incluindo a ausência de persistência de cookies/localStorage entre aberturas.

Não inclui iOS, notarização Apple, certificados Windows, atualização automática dos projetos ou proteção dos conteúdos contra extração.
