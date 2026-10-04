# Importar páginas HTML e PHP

O módulo **Ficheiro HTML / PHP** da versão 2.0.0 importa `.html`, `.htm` e `.php`
para o projeto. A opção HTML anterior continua a servir para colar conteúdo.

1. Abra **Conteúdos**, adicione um módulo e escolha **Ficheiro HTML / PHP**.
2. Selecione a página inicial no diálogo de ficheiros.
3. Se a página precisar de CSS, JavaScript, imagens, outras páginas ou `include`
   PHP, prepare uma pasta dedicada e ative a opção de copiar também essa pasta.
   A pasta da página inicial é a raiz do site. Recursos fora dela não são copiados.
4. Guarde o módulo e abra a pré-visualização.
5. Em **Exportar**, escolha Windows ou Mac. A cópia importada, incluindo subpastas,
   vai no pacote; o computador do destinatário não precisa do caminho original.

A seleção de uma pasta pode incluir informação privada em ficheiros PHP/JSON.
Reveja essa pasta antes de importar. Exclusões automáticas de ficheiros ocultos
e pastas de desenvolvimento não substituem essa revisão. Ligações simbólicas e
ficheiros especiais são rejeitados. Limites: 2000 ficheiros, 32 MB por ficheiro,
256 MB no total e 32 níveis de subpastas.

Guardar novamente, editar o título ou reordenar o módulo preserva a cópia atual.
Para atualizar o conteúdo, volte a selecionar o ficheiro. Substituir/apagar o
módulo recolhe a pasta antiga apenas depois de guardar a nova configuração.

## PHP

HTML funciona sem PHP. Para executar páginas PHP, o produto tem de incluir o
runtime portátil em `vendor/php` antes da compilação; consulte
[vendor/php/README.md](vendor/php/README.md). O Git não contém esse runtime.
A exportação verifica a presença de `php.exe` (Windows) ou `php` (Mac) no modelo escolhido quando o
projeto contém PHP. Ter PHP instalado no PATH não satisfaz esse requisito.

O módulo executa o PHP localmente e apresenta a resposta no Viewer. Não converte
PHP para HTML nem entrega o código PHP como página estática. A importação só
copia ficheiros; a execução começa na pré-visualização/abertura do módulo.

Importe apenas código de confiança: o PHP tem as permissões da conta do utilizador.
O runtime não instala bases de dados, extensões PHP, Composer ou Apache. Não há
suporte automático para `.htaccess`, regras de reescrita ou frameworks com raiz
`public/` separada de dependências privadas. Chamadas a serviços remotos continuam
a precisar de rede. Dados escritos dentro da pasta extraída do SFX são temporários
e não constituem armazenamento persistente da aplicação. A sessão e a origem
HTTP também mudam ao reabrir o módulo: cookies, `localStorage` e IndexedDB não
persistem entre aberturas, mesmo durante a mesma sessão do Viewer. Aplicações
que precisam de guardar trabalho devem usar armazenamento externo próprio;
a importação não cria uma camada de persistência para elas.

## Isolamento e testes

Cada abertura usa um servidor só em `127.0.0.1`, porta aleatória e autorização
local, com uma sessão de browser separada. As páginas não recebem a ponte IPC,
preload nem integração Node. A autorização local não é um sistema de licenciamento
e não protege ficheiros de quem tem acesso ao computador.

Execute `npm test` na pasta do projeto. A suite verifica importação, recursos,
caminhos, ciclo de vida HTTP, gravação e opções de isolamento sem instalar Electron.
Os testes que precisam de PHP real assinalam ausência do runtime como `skip`.

Antes de distribuir, teste em Windows e Mac: importar HTML com CSS/JS/imagens, importar
PHP com formulário e includes, editar/reordenar/substituir, fechar o Viewer,
reconstruir os modelos e os instaladores, abrir o EXE/ZIP Windows e o ZIP Mac em
máquinas limpas. Consulte [o guia v2](BUILD-V2.md) para compilação e instalação.
