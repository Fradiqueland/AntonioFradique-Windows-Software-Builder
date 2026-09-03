Coloque aqui o ffmpeg.exe (build "essentials" ou "full" para Windows x64, ex.:
https://www.gyan.dev/ffmpeg/builds/  ou  https://github.com/BtbN/FFmpeg-Builds/releases).
Só o ffmpeg.exe é necessário (o ffprobe.exe e ffplay.exe não são usados).

Com o ficheiro presente, o Viewer ganha um motor extra para canais IPTV que o
Chromium não reproduz diretamente (ex.: vídeo entrelaçado 1080i, áudio AC-3):
o ffmpeg lê o stream e serve-o localmente em MP4 ao leitor, sem recodificar o vídeo.

O ffmpeg é distribuído sob LGPL/GPL; mantenha o ficheiro de licença que vem
com o build nesta pasta (é copiado para junto do ffmpeg.exe).

Binário incluído: FFmpeg 9.0.1 "essentials" (build www.gyan.dev, GPL).
Nota de licença: o ffmpeg é um programa separado, invocado pelo Viewer por linha
de comandos; não é ligado ao código da aplicação. Mantenha o texto de licença
GPL do build junto ao binário quando distribuir (ver https://www.gyan.dev/ffmpeg/builds/).
