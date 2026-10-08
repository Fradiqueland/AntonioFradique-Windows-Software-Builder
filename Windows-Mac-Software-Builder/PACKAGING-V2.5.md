# Empacotamento v2.5

A compressão dos instaladores e dos ZIP usa o nível máximo disponível, sem
alterar imagens, vídeos, áudio, resolução ou conteúdo dos projetos. O Electron,
os codecs e as traduções mantêm-se. Não são retirados avisos de licença.

O Viewer exportado deixa de incluir as bibliotecas exclusivas de conversão de
ícones e edição de executáveis do Builder. O Builder Mac deixa de incluir a
ferramenta de edição de executáveis Windows, que só é utilizada pelo exportador
SFX executado no Windows. As dependências ZIP continuam presentes nos dois.

Nas exportações novas, o FFmpeg acompanha apenas projetos com IPTV. O PHP
acompanha apenas projetos que necessitem de executar PHP. Quando o FFmpeg é
incluído, os seus códigos-fonte exatos, a receita de compilação e as licenças
GPL continuam a acompanhá-lo. A ausência de PHP impede a exportação de um
projeto que o exija; não produz uma aplicação incompleta.

O template Mac contém a aplicação assinada e uma pasta adjacente
`LaunchBox Viewer.data`, com os motores opcionais. Na exportação, esta pasta
passa a usar o nome do produto. A seleção dos motores acontece nessa pasta,
sem modificar a assinatura da aplicação. Os executáveis dos motores têm as
suas próprias assinaturas ad-hoc e incluem Intel e Apple Silicon. Ao distribuir
ou mover uma aplicação exportada, deve preservar-se a estrutura completa do ZIP.

O Builder continua a incluir os dois templates de exportação e o FFmpeg
necessário à pré-visualização de IPTV. Não necessita de obter esses componentes
pela Internet. Estes componentes justificam parte importante do seu tamanho.

Os dois arquivos de código-fonte FFmpeg/x264, com um total de 12 580 755 bytes,
são guardados uma única vez no Builder. São retiradas apenas as cópias idênticas
dentro dos templates que acompanham o Builder. Os templates autónomos do CI
continuam completos. Na exportação IPTV, os arquivos originais são repostos
após verificar os seus tamanhos e SHA-256; cada produto distribuído continua a
incluir o código-fonte completo e as licenças. Fontes ausentes ou alteradas
bloqueiam a exportação. O construtor não depende de downloads posteriores.

Depois de juntar os dois templates autónomos e preparar o runtime nativo do
Builder, executar antes da compilação do instalador:

```sh
node scripts/deduplicate-template-sources.js
```

Depois das compilações nativas, executar:

```sh
node scripts/report-package-size.js
```

O relatório `dist/package-size-report.json` apresenta tamanhos medidos dos
templates, dos instaladores e das pastas das aplicações. Compara os templates
com a v2.1.1. Distingue o ficheiro do instalador do ZIP de artefacto do GitHub;
estes dois tamanhos não devem ser apresentados como se fossem a mesma medição.

Os testes nativos verificam as dependências, o avanço de reprodução IPTV,
exportações com e sem os motores opcionais, permissões, ligações simbólicas e
assinaturas Mac. Nenhuma percentagem de redução é prometida antes de medir os
ficheiros finais.
