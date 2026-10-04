# PHP portátil para módulos HTML/PHP

O runtime não está incluído no Git. Antes de distribuir suporte PHP:

1. Obtenha uma distribuição oficial PHP para Windows x64 em https://windows.php.net/download/.
2. Extraia o ZIP completo em `vendor/php/windows-x64/`: `php.exe`, DLLs e licenças.
   O caminho antigo `vendor/php/php.exe` continua aceite.
3. Verifique os requisitos do Visual C++ Runtime indicados na página oficial no PC de destino.
4. Execute `npm run check:php` e depois `npm run build:all` em Windows.
5. Teste o `.exe` exportado num PC Windows limpo, sem PHP instalado e sem rede.

Os dois pacotes incluem a pasta como `resources/php`; não se depende de PHP no PATH
do aluno. Um template antigo precisa de ser reconstruído. A exportação de cursos
com PHP é bloqueada se o runtime não estiver no template.

O servidor fica apenas em `127.0.0.1`, numa porta atribuída pelo sistema, atrás de
um servidor local com autorização. É encerrado quando o módulo/Viewer fecha.
O PHP é iniciado com `-n`: não carrega `php.ini` externo nem extensões adicionais.
Scripts que dependam de extensões como MySQL/cURL, Apache/.htaccess, Composer,
serviços externos ou bases de dados não têm essas dependências instaladas por
este módulo. O conteúdo HTML é servido sem PHP quando não contém scripts PHP.

**Execute apenas PHP de confiança:** o interpretador tem as permissões do
utilizador do sistema operativo. O isolamento do browser protege a ponte Electron, mas não
é uma sandbox do sistema operativo para PHP. Não inclua credenciais privadas
nos ficheiros distribuídos; o conteúdo do SFX pode ser extraído.

Mantenha as licenças do PHP e das bibliotecas da distribuição junto do runtime.
O script não descarrega executáveis nem altera o PHP instalado no computador.

## macOS na v2

Prepare `vendor/php/mac-universal/php`, com permissão de execução, suporte Intel e
Apple Silicon e dependências relocáveis. Reconstrua o Viewer Mac e o Builder Mac
conforme [BUILD-V2.md](../../BUILD-V2.md). Um PHP instalado no sistema/Homebrew não
fica automaticamente portátil: teste numa máquina limpa de cada arquitetura. O
Git e o workflow não fornecem nem descarregam este runtime.
