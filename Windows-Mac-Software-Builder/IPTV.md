# IPTV — v2.5, com a correção de reprodução da v2.1.1

## Falha investigada

O diagnóstico recebido indicava que os segmentos chegavam ao leitor, mas o descodificador falhava com `PIPELINE_ERROR_DECODE`. A tentativa TS apresentava um fotograma, declarava sucesso e continuava a descarregar dados apesar dos erros seguintes. O registo não permite concluir que a causa exata seja entrelaçamento, placa gráfica ou um problema específico do fornecedor.

Foram encontrados dois problemas no produto: a tentativa deixava de tratar erros depois do primeiro fotograma; o fallback FFmpeg não vinha incluído no instalador e, quando existia, copiava o vídeo original em vez de o converter.

## Reprodução e conversão

O leitor mantém as tentativas diretas HLS/TS e trata erros durante toda a reprodução. Uma tentativa que falha é encerrada antes de iniciar a seguinte; a recuperação HLS tem um limite. O leitor também deteta reprodução que deixa de avançar, respeitando a pausa voluntária do utilizador.

Quando a reprodução direta falha, o FFmpeg incluído pode converter o vídeo para H.264 Main, nível 3.1, `yuv420p`, progressivo, até 1280×720 e 30 fps, com áudio AAC-LC estéreo a 48 kHz. O vídeo SD não é ampliado. A conversão usa o processador e pode reduzir resolução/frequência; exige capacidade suficiente para acompanhar um canal em direto.

Os instaladores incluem o FFmpeg físico e as fontes/licenças correspondentes. Na v2.5, os projetos exportados incluem esse runtime apenas quando contêm IPTV; as fontes partilhadas no Builder são repostas e verificadas em cada exportação IPTV. Não é necessário instalar um FFmpeg externo. PHP continua independente desta funcionalidade.

Uma ligação indisponível, expirada, bloqueada pelo fornecedor ou um fluxo protegido/incompatível pode continuar a falhar. A conversão não substitui uma ligação válida nem garante todos os canais.

## Atualização e diagnóstico

1. Instale o Builder **v2.5.0**.
2. Abra o projeto e teste o módulo IPTV.
3. Volte a exportar para Windows e/ou Mac. Os produtos antigos conservam o leitor antigo.
4. Se falhar, use o diagnóstico do leitor e indique sistema operativo, versão instalada e se ocorre no Builder ou num produto exportado.

Os novos diagnósticos ocultam os caminhos, parâmetros e credenciais dos URLs; a ligação original continua a ser utilizada apenas para reprodução. Registos de versões antigas podem conter credenciais: remova-as antes de partilhar.

## Validação

`npm test` cobre falhas depois do primeiro fotograma, recuperação limitada, limpeza de leitores, pausas e diagnóstico sem credenciais, além do ciclo de vida do proxy.

`npm run test:electron:iptv` usa um vídeo sintético H.264 High 1080i/AAC, servido apenas por HTTP local. Verifica a conversão real para H.264 Main 720p/30 progressivo, descodifica vários fotogramas com `ffprobe` e exige mais de dois segundos de reprodução e pelo menos 60 apresentações de fotogramas no Electron. `npm run test:electron:iptv:packaged` repete a verificação com o módulo e o FFmpeg do pacote. O workflow executa ambos no Windows e no Mac Intel e testa a conversão nativa do FFmpeg em Intel e ARM64.

Estes testes não usam URLs nem credenciais de fornecedores. O resultado em canais reais deve ser confirmado depois de instalar a atualização.
