# Software portable — v2.1

O módulo **Software portable** importa uma pasta inteira, identifica possíveis ficheiros de arranque e permite escolher uma entrada para Windows e outra para Mac. Está disponível no Builder e nos produtos exportados. O programa abre numa janela própria do sistema operativo, a partir do módulo; a sua interface não é incorporada na janela do Builder.

## Adicionar e testar

1. Em **Conteúdo**, adicione um módulo **Software portable**.
2. Escolha a pasta que contém o programa e os seus ficheiros de apoio. Num Mac também pode selecionar uma aplicação `.app`.
3. Confirme o ficheiro de arranque Windows e/ou Mac nas listas apresentadas. A análise verifica cabeçalhos PE e Mach-O e o executável declarado em `Info.plist`, em vez de confiar apenas na extensão. DLLs não são entradas de arranque.
4. Guarde o módulo. Utilize **Testar programa** no editor ou **Abrir programa** na pré-visualização.
5. Exporte para cada destino necessário e teste o produto no sistema de destino.

Quando há vários candidatos, escolha o programa principal, evitando instaladores, desinstaladores e auxiliares. Uma sugestão de ficheiro não comprova que o programa funciona. A pasta original não é alterada; para atualizar a cópia, volte a importá-la.

## Compatibilidade entre sistemas

| Programa incluído | Windows | Mac |
| --- | --- | --- |
| Executável Windows `.exe` | Execução nativa com arquitetura e dependências compatíveis | Pode ser tentado com Wine externo, se autorizado no módulo |
| Aplicação Mac `.app` ou executável Mach-O | Precisa de uma versão Windows | Execução nativa com arquitetura e dependências compatíveis |
| Pasta com as duas versões | Abre a entrada Windows selecionada | Dá preferência à entrada Mac selecionada |

Importar e exportar uma pasta **não converte executáveis** entre Windows e macOS. A exportação Windows exige uma entrada Windows. A exportação Mac exige uma entrada Mac ou uma entrada Windows com a opção Wine autorizada. O módulo antigo **Lançar ficheiro** mantém o seu comportamento; a exceção Wine pertence ao novo módulo portable.

Uma aplicação pode precisar de DLLs, frameworks, .NET, registo, serviços, drivers, ativação ou ficheiros externos que não existem na pasta. A identificação do formato e da arquitetura não verifica essas dependências. macOS moderno não executa aplicações Mac de 32 bits; aplicações Intel num Mac Apple Silicon podem precisar de Rosetta.

## Wine no Mac

A opção **Permitir abrir a versão Windows no Mac com Wine externo** vem desativada. Quando ativada e sem entrada Mac, o módulo tenta a entrada Windows através de Wine. A compatibilidade deve ser testada para cada programa; a opção não inclui um sistema Windows completo.

Em **Configurar Wine neste Mac**, selecione o executável `wine` já instalado e um prefixo Wine já preparado, que contenha `system.reg` e `user.reg`. As preferências ficam neste computador e não são distribuídas no projeto. Cada destinatário que utiliza esta opção precisa de preparar o seu próprio ambiente. O Builder não descarrega Wine, não executa instaladores, `wineboot` ou `winetricks` e não cria prefixos vazios. O próprio runtime Wine pode atualizar um prefixo ao utilizá-lo.

São aceites executáveis Windows x86 e x64 nesta opção. Executáveis Windows ARM não são tratados como executáveis Mac ARM. O funcionamento de programas x86 de 32 bits e a necessidade de Rosetta dependem do runtime Wine instalado. Consulte [WineHQ](https://www.winehq.org/) e a [documentação de dependências da CodeWeavers](https://support.codeweavers.com/en_US/troubleshooting/troubleshooting-unlisted-applications-cxmac).

## Ficheiros, permissões e dados

As subpastas, ficheiros de apoio, diretórios vazios, permissões de execução e ligações simbólicas relativas internas são preservados. São rejeitadas ligações para fora da pasta, ciclos, ficheiros especiais e nomes ambíguos entre sistemas. No Windows, preservar ligações simbólicas durante a importação pode exigir o Modo de Programador; quando isso falha, a importação é cancelada com uma indicação concreta. Importe aplicações Mac num Mac para preservar as permissões Unix. Se essas permissões já se perderam ao copiar a pasta para Windows, a exportação Mac é bloqueada com uma indicação para reimportar corretamente.

Uma pasta portable com ligações simbólicas usa exportação Windows ZIP, em vez do EXE auto-extraível. Utilize uma ferramenta de extração que preserve essas ligações e mantenha a pasta completa. Para distribuir apenas no Windows, prefira importar a pasta da versão Windows. A versão Mac deve ser extraída num Mac, preservando os ficheiros e as permissões.

O programa é executado a partir de uma cópia de trabalho persistente em `LaunchBox Portable Apps/projects`, dentro da pasta de dados de aplicações do utilizador: AppData no Windows e Library no Mac, normalmente ocultas no explorador. Nenhuma pasta de trabalho é criada no ambiente de trabalho ou junto do projeto exportado. Assim, os ficheiros que grava ao lado do executável sobrevivem a novas aberturas e à extração temporária do EXE Windows. A primeira abertura precisa de espaço para essa cópia. A pasta é novamente validada antes de cada execução; ficheiros criados pelo programa que ultrapassem os limites ou contenham ligações externas podem impedir uma nova abertura. Reimportar uma pasta cria uma revisão e uma cópia de trabalho novas; duplicar o projeto também separa os dados dos programas. Apagar um módulo remove a cópia do projeto, mas não apaga automaticamente os dados que o programa criou na pasta de trabalho.

Os programas importados são código nativo, executado com os privilégios do utilizador. O isolamento das páginas HTML do Builder não constitui uma sandbox para esses programas. A mensagem **Processo iniciado** confirma o arranque, não o funcionamento completo nem a compatibilidade Wine. A aplicação portable pode continuar aberta depois de fechar o Viewer.

Limites por importação: 30000 ficheiros/pastas, 64 níveis, 2 GB por ficheiro e 8 GB no total. A exportação aplica os seus limites ao conjunto de todos os recursos do projeto.

## Compilar v2.1

Execute `npm ci` e `npm test`, reconstrua os dois modelos Viewer a partir desta versão e depois os instaladores Builder, conforme [BUILD-V2.md](BUILD-V2.md). Não reutilize modelos v2.0.1: esses visualizadores não conhecem o módulo portable. Os projetos já distribuídos devem ser novamente exportados para receber o módulo e o runtime v2.1.
