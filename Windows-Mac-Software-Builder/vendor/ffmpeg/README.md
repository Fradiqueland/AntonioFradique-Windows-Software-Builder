# FFmpeg runtime used by IPTV

Release builds require FFmpeg and ffprobe. They are compiled from the exact
upstream FFmpeg 8.1.3 release and x264 commit pinned, with SHA-256 checksums, in
`build-configs/ffmpeg-sources.json`. The FFmpeg release signature was verified
against the official release key recorded in that file. No runtime binaries are
committed to this repository.

The recipe links libx264 statically and enables GPL-2.0-or-later. It uses the
operating system TLS implementation (Windows Schannel or macOS SecureTransport),
without a dependency on OpenSSL or Homebrew dynamic libraries. The resulting
FFmpeg and ffprobe are separate command-line executables. Every Builder and
Viewer includes the exact source archives, upstream license texts, source URLs,
checksums, build configuration, compiler information and rebuild scripts beside
those executables. See the shipped `ffmpeg/README-SOURCES.txt`,
`ffmpeg/runtime-manifest.json`, `ffmpeg/licenses/` and `ffmpeg/sources/`.

## Build from source

Install Node.js 22 or later and the native compiler, make, pkg-config and NASM.
On Windows use MSYS2 MINGW64 with packages `make tar xz bzip2 diffutils
mingw-w64-x86_64-gcc mingw-w64-x86_64-nasm mingw-w64-x86_64-pkgconf` and make
Node.js available in the shell PATH. On macOS use Xcode command-line tools and
`brew install nasm pkg-config`. Run from `Windows-Mac-Software-Builder`:

```sh
# Run each command on its matching operating system and CPU.
bash scripts/build-ffmpeg.sh windows-x64
bash scripts/build-ffmpeg.sh mac-x64
bash scripts/build-ffmpeg.sh mac-arm64
```

Each build downloads and checks the source hashes, compiles only the required
IPTV codecs, filters and network protocols, runs a CPU H.264/AAC transcode, checks
the result with ffprobe, and creates `dist/runtime-native/<target>.tar.gz`.
These tar archives preserve Unix executable permissions when transferred via CI.
Sources already placed in `dist/ffmpeg-sources/` are reused after hash validation.

Install the Windows artifact, or copy both Mac archives to `dist/runtime-native/`
on a Mac and assemble the universal runtime:

```sh
node scripts/install-ffmpeg-runtime.js windows-x64
node scripts/install-ffmpeg-runtime.js mac-universal
```

Packaging reads `vendor/ffmpeg/windows-x64/` or `vendor/ffmpeg/mac-universal/`.
The Mac executable contains Intel and Apple Silicon slices. Both slices are
compiled and tested on their native CPU in CI before the universal merge.
The installer checks source hashes, executable architecture and a native
transcode again; Mac checks also reject non-system dynamic library dependencies.

The GitHub workflow performs these steps before building Viewer templates and
Builder installers. Missing runtimes, source archives, license texts or failed
transcodes stop the release build. PHP is independent and remains optional.
