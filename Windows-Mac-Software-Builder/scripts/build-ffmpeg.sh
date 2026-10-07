#!/usr/bin/env bash
# Reproducible source inputs; native compiler/SDK versions are recorded in provenance.
set -euo pipefail
cd "$(dirname "$0")/.."
target="${1:?Usage: bash scripts/build-ffmpeg.sh windows-x64|mac-x64|mac-arm64}"
case "$target:$(uname -s):$(uname -m)" in
  windows-x64:MINGW*:x86_64|windows-x64:MSYS*:x86_64) ;;
  mac-x64:Darwin:x86_64|mac-arm64:Darwin:arm64) ;;
  *) echo "Compile $target on its native OS and architecture (Windows uses MSYS2 MINGW64)." >&2; exit 1 ;;
esac
node scripts/prepare-ffmpeg-sources.js "$target"
project_root="$PWD"
build_root="$project_root/dist/ffmpeg-build/$target"
prefix="$build_root/prefix"
output="$project_root/vendor/ffmpeg/$target"
ffmpeg_dir="$(node -p "require('./build-configs/ffmpeg-sources.json').sources.find(s=>s.name==='ffmpeg').directory")"
x264_dir="$(node -p "require('./build-configs/ffmpeg-sources.json').sources.find(s=>s.name==='x264').directory")"
jobs="${FFMPEG_BUILD_JOBS:-$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 2)}"
rm -rf "$prefix"
mkdir -p "$prefix" "$output"
export PKG_CONFIG_PATH="$prefix/lib/pkgconfig"
export LC_ALL=C
cflags=()
ldflags=()
platform_options=()
x264_options=()
if [[ "$target" == windows-x64 ]]; then
  export CC=gcc
  ldflags=(-static -static-libgcc)
  platform_options=(--target-os=mingw32 --arch=x86_64 --enable-schannel --disable-pthreads --enable-w32threads)
else
  export CC=clang
  export MACOSX_DEPLOYMENT_TARGET=11.0
  cflags=(-mmacosx-version-min=11.0)
  ldflags=(-mmacosx-version-min=11.0)
  platform_options=(--enable-securetransport)
  x264_options=(--enable-pic)
fi
cd "$build_root/$x264_dir"
./configure --prefix="$prefix" --enable-static --disable-cli --disable-opencl --bit-depth=8 \
  "${x264_options[@]}" "--extra-cflags=${cflags[*]}" "--extra-ldflags=${ldflags[*]}"
make -j"$jobs"
make install
cd "$build_root/$ffmpeg_dir"
# Keep only the codecs, containers, protocols and filters used by IPTV and its
# offline smoke tests. No nonfree or independently downloaded codec libraries.
./configure --prefix="$prefix" --disable-autodetect --disable-everything \
  --disable-shared --enable-static --disable-doc --disable-debug --disable-ffplay \
  --enable-ffmpeg --enable-ffprobe --enable-gpl --enable-libx264 --enable-network \
  --enable-avcodec --enable-avformat --enable-avfilter --enable-avdevice \
  --enable-swscale --enable-swresample --enable-indev=lavfi \
  --enable-protocol=file,pipe,http,https,tcp,tls,udp,crypto,data \
  --enable-demuxer=mpegts,hls,mov,matroska,flv,aac,ac3,eac3,mp3,mpegvideo,h264,hevc \
  --enable-decoder=h264,hevc,mpeg2video,mpeg4,aac,aac_latm,ac3,eac3,mp2,mp3,rawvideo,wrapped_avframe,pcm_s16le,pcm_f32le \
  --enable-parser=h264,hevc,mpegvideo,mpeg4video,aac,aac_latm,ac3,mpegaudio \
  --enable-encoder=libx264,aac --enable-muxer=mp4,mov,mpegts,null \
  --enable-bsf=aac_adtstoasc,h264_mp4toannexb,hevc_mp4toannexb,extract_extradata \
  --enable-filter=yadif,scale,fps,format,aresample,aformat,setpts,asetpts,trim,atrim,null,anull,testsrc2,sine \
  --pkg-config-flags=--static "--extra-cflags=-I$prefix/include ${cflags[*]}" \
  "--extra-ldflags=-L$prefix/lib ${ldflags[*]}" "${platform_options[@]}"
make -j"$jobs"
make install
cd "$project_root"
node scripts/package-ffmpeg-runtime.js "$target"
node scripts/check-ffmpeg.js "$target" "$output"
mkdir -p dist/runtime-native
tar -czf "dist/runtime-native/$target.tar.gz" -C "$output" .
