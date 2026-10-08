# Android/APK — estado e critérios de execução incorporada

## Estado na versão 2.5

A execução de APK **não está disponível** nesta versão. Não existe neste
repositório um pacote Android incorporado, validado e redistribuível para Windows
e Mac. A opção experimental apresenta informação; não importa um APK como módulo
executável nem abre um emulador externo. A exportação de configurações alteradas
manualmente com módulos `apk` ou `android-apk` deve falhar antes de criar o pacote.

`src/shared/android-runtime.js` centraliza o estado e os textos do construtor e do
utilizador final em português e inglês. `available: false` é deliberado. Uma
variável de ambiente, um executável encontrado no PATH, metadados de um APK ou um
manifesto preenchido à mão não constituem prova de execução.

## Objetivo autorizado para o protótipo

O criador importa um APK e utiliza a aplicação dentro do Builder. O destinatário
abre a aplicação exportada, com o mesmo motor e sistema Android incorporados,
sem instalar Android Studio, BlueStacks, Java, Python, ADB ou outro emulador.
O APK não é convertido em código Windows ou Mac: é executado num sistema Android
virtualizado/emulado. Ficheiros IPA de iPhone/iPad não estão incluídos no âmbito.

O motor só arranca depois de escolher o módulo Android. O armazenamento gravável
fica numa pasta interna do produto, com dados separados por aplicação/projeto.
Projetos que não usam APK não devem incluir o motor nem a imagem Android no
software exportado. No construtor, uma imagem comum deve ser guardada uma única
vez; não deve ser duplicada nos templates Windows e Mac. Desativar o motor reduz
o consumo durante a utilização, mas não reduz os bytes de uma imagem que já
esteja incorporada no instalador.

## Caminhos técnicos investigados

### Android Emulator + imagem AOSP própria

O motor Android baseado em QEMU tem componentes para Windows x64 e Mac. A
interface gRPC permite transportar o ecrã e comandos para uma interface
incorporada. Imagens AOSP podem ser compiladas e partilhadas, sem adicionar
automaticamente serviços Google proprietários.

É necessário fixar as revisões de origem, compilar/verificar os motores nativos,
criar imagens adequadas x86_64 e arm64 e distribuir as licenças e o código-fonte
correspondente. O guia atual para compilar AOSP indica pelo menos 400 GB livres
e 64 GB de RAM num computador Linux x86 de 64 bits. **São requisitos de construção
do sistema Android, não requisitos do computador do destinatário.** Este ambiente
tem aproximadamente 29 GB livres e 9,7 GiB de RAM; não foi efetuada essa compilação.

### QEMU normal + distribuição Android para PC

QEMU suporta TCG, que permite executar um sistema x86_64 em Windows e Mac,
incluindo um Mac ARM. Um servidor VNC local e uma ponte WebSocket autenticada
podem transportar o ecrã e teclado/rato para Electron. É um caminho possível
para um protótipo, ainda sem prova de desempenho, áudio ou compatibilidade.

Foi identificada a imagem arquivada oficial
`Bliss-Go-v16.9.7-x86_64-OFFICIAL-foss-20241011.iso`, com cerca de 2,3 GB, baseada
em Android 13. O anúncio Bliss OS Go indica que não inclui a ponte ARM por
predefinição. Contudo, o site oficial atual informa que não há uma ISO pública
nova e que as imagens arquivadas não recebem atualizações nem suporte oficial.
Um nome `foss` não substitui a inspeção dos componentes efetivamente presentes:
o próprio projeto distingue software aberto de firmware, codecs, fontes,
Widevine, serviços Google e pontes ARM sujeitos a outras condições.

Essa imagem não foi descarregada, inspecionada, testada nem incluída nos
instaladores. Não é uma solução pronta para publicar com a promessa de conservar
qualidade e compatibilidade. Um único Android x86_64 também não executa
automaticamente APK que apenas contenham bibliotecas ARM. Emulação x86 num Mac
ARM pode ser muito mais lenta do que uma imagem nativa ARM.

### QEMU + Linux mínimo + imagens Waydroid atuais

O projeto Waydroid mantém imagens LineageOS/Android 13 para contentores Linux,
incluindo variantes `VANILLA` sem Google Apps. Foram identificadas imagens oficiais
de 27 de setembro de 2026: sistema x86_64 com cerca de 847 MB, sistema arm64 com
cerca de 912 MB e vendor x86_64 com cerca de 190 MB. São tamanhos dos downloads,
não estimativas do pacote completo nem dos dados de utilização.

Ao contrário de uma ISO Android para PC, essas imagens não arrancam diretamente
em QEMU. Um protótipo Windows/Mac precisaria também de incorporar um Linux mínimo
com suporte Binder, contentores e compositor Wayland, além de uma ponte de ecrã,
entrada, áudio e instalação de APK. Este caminho merece investigação porque
evita depender de uma imagem Bliss arquivada ou de compilar todo o AOSP neste
ambiente. Não foi construído nem testado e a redistribuição de todos os seus
componentes ainda exige verificação individual. Waydroid instalado no sistema
do utilizador não satisfaria o objetivo; toda a máquina virtual teria de fazer
parte do produto.

### Emulação WebAssembly

O projeto v86 permite emular x86 dentro do browser, mas a documentação só indica
Android-x86 testado até 4.4-r2. Não foi escolhido um Android antigo para aparentar
uma integração completa e sacrificar compatibilidade e qualidade.

## Provas obrigatórias antes de disponibilizar execução/exportação

1. Fixar o motor e a imagem por revisão e SHA-256; identificar todos os componentes,
   respetivas licenças, avisos e código-fonte correspondente. Não copiar um SDK,
   uma imagem com Google Play ou uma ponte ARM proprietária sem fundamento de
   redistribuição para cada componente.
2. Construir pacotes nativos para Windows x64, Mac Intel e Mac Apple Silicon.
   Verificar todas as bibliotecas não pertencentes ao sistema e assinaturas Mac.
3. Testar em máquinas limpas sem ferramentas de desenvolvimento ou emuladores
   instalados. Confirmar que apenas executáveis incorporados são usados.
4. Iniciar o Android, instalar um APK sintético de código conhecido e abrir a
   atividade real. Confirmar vários frames, animação, teclado, rato/toque, áudio
   e encerramento. Uma leitura do manifesto ou um único screenshot não passa.
5. Repetir a mesma prova com o Builder instalado e com cada aplicação exportada,
   incluindo uma exportação Windows criada no Mac e uma exportação Mac criada
   no Windows. Desligar a Internet durante a instalação/execução da fixture local.
6. Validar ABI e versão mínima de Android antes de exportar; apresentar um erro
   concreto para APK incompatíveis. Testar aplicações Java/Kotlin sem bibliotecas
   nativas e fixtures distintas x86_64/ARM64, sem prometer que todos funcionam.
7. Provar persistência dos dados por aplicação, reinício, duas instâncias, falhas
   de boot, espaço insuficiente, timeout, processos terminados e limpeza. O motor
   não pode ficar ativo depois de fechar o módulo ou a aplicação.
8. Isolar o transporte no loopback com token por sessão e origem validada, limites
   de tamanho/tempo, portas efémeras e autorização IPC por janela. Não permitir
   que conteúdo web arbitrário controle o Android, ADB ou o processo do sistema.
9. Mostrar ao criador, antes de importar, os limites de arquitetura/serviços,
   requisitos de memória/disco e aumento de tamanho real. Ao destinatário,
   apresentar os requisitos antes do primeiro arranque e um diagnóstico acionável.
10. Medir tamanho comprimido e instalado, tempo de arranque, memória, CPU, fluidez
    e áudio nos três sistemas. Comparar com a versão sem Android. Nenhuma redução
    de tamanho justifica remover funcionalidades necessárias ou degradar a prova.

A aceleração de hardware pode exigir ativação da virtualização no firmware ou
de uma funcionalidade Windows. Mac usa o Hypervisor.Framework quando o motor e
o sistema convidado o permitem. O funcionamento por TCG sem aceleração precisa
de ser medido; não é garantia de uma experiência aceitável.

## Fontes primárias consultadas em 8 de outubro de 2026

- [Requisitos para construir AOSP](https://source.android.com/docs/setup/start/requirements)
- [Criar e partilhar imagens AVD AOSP](https://source.android.com/docs/setup/test/avd)
- [Código do motor QEMU Android](https://android.googlesource.com/platform/external/qemu/+/emu-dev/)
- [Exemplos oficiais de controlo gRPC](https://android.googlesource.com/platform/external/qemu/+/72862398a2b2055d8ac902a092648d89bf2c08a4/android/android-grpc/docs/grpc-samples)
- [Aceleração do Android Emulator](https://developer.android.com/studio/run/emulator-acceleration)
- [Aceleradores e TCG no QEMU](https://www.qemu.org/docs/master/system/introduction.html)
- [Estado dos downloads Bliss OS](https://blissos.org/download.html)
- [Licenciamento e componentes do Bliss OS](https://blissos.org/licensing.html)
- [Arquivo oficial Bliss OS Go FOSS](https://sourceforge.net/projects/blissos-x86/files/Official/BlissOS16/FOSS/Go/)
- [Anúncio Bliss OS Go e ponte ARM](https://blog.blissos.org/announcement-bliss-os-go/)
- [Código e arquitetura do Waydroid](https://github.com/waydroid/waydroid)
- [Construir imagens LineageOS para Waydroid](https://docs.waydro.id/development/compile-waydroid-lineage-os-based-images)
- [Imagens oficiais Waydroid x86_64](https://sourceforge.net/projects/waydroid/files/images/system/lineage/waydroid_x86_64/)
- [Imagens oficiais Waydroid arm64](https://sourceforge.net/projects/waydroid/files/images/system/lineage/waydroid_arm64/)
- [Vendor oficial Waydroid x86_64](https://sourceforge.net/projects/waydroid/files/images/vendor/waydroid_x86_64/)
- [Código/documentação do v86](https://github.com/copy/v86)

Estes links documentam a investigação. Não constituem prova de um runtime já
construído, de testes nativos concluídos ou de redistribuição validada de uma
imagem concreta.
