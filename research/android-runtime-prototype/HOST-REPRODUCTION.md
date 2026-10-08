# Reconstruct the isolated Linux research environment

This recipe rebuilds a **failed feasibility experiment**, not a working product
feature. It targets an Ubuntu 24.04 x86_64 development host with Python 3.12+,
Java 21, `keytool` and `dpkg-deb`. Build tools are developer dependencies; this
does not specify prerequisites for an eventual Windows/Mac application user.
No `sudo`, host emulator installation or Google Android SDK is required here.

1. Place the frozen text sources in a fresh directory. Install local Python
   dependencies: `python3 -m pip install --target pypackages requests==2.34.2
   pycdlib==1.21.0`. These are research tooling, not an end-user runtime.
2. Fetch the exact Ubuntu `.deb` URLs in `ubuntu-tools-manifest.json`.
   Validate each file against its SHA-256 and byte size before extraction.
   All 48 files were also matched against the signed Ubuntu APT index hashes
   in this experiment. The snapshot is `20260828T000000Z`; versions and source
   package names are preserved. Extract them with `dpkg-deb -x FILE
   host-runtime`, never by installing them into the host OS. A suitable Java 21
   development runtime must be on PATH to build the fixture. Stop any prior
   prototype VM before replacing its extracted helper executables.
3. Download the official Alpine ISO URL in `bootstrap-tools.json`; check its
   recorded SHA-256. Extract the two ISO files through the Rock Ridge paths
   `/boot/vmlinuz-virt` and `/boot/initramfs-virt` using `pycdlib`, writing them
   as `vmlinuz-virt` and `initramfs-virt` next to `run_vm.py`.
4. Create the disposable disk once, with the isolated `qemu-img` and its library
   path (do not overwrite a disk containing anything valuable):

   ```sh
   LD_LIBRARY_PATH="$PWD/host-runtime/usr/lib/x86_64-linux-gnu" \
     host-runtime/usr/bin/qemu-img create -f qcow2 alpine-guest.qcow2 12G
   ```

5. `python3 download_images.py` retrieves the two pinned official Waydroid
   VANILLA/MAINLINE image URLs and verifies their published size and SHA-256.
   This is a developer experiment download, not permission to redistribute
   binary images. On a host with a restrictive outbound proxy, fetch through
   the proxy advertised by that environment without printing credentials.
6. Run `python3 build_fixture.py`. It assembles Smali, packages with isolated
   Ubuntu AOSP `aapt`/framework-res, creates a disposable debug key and signs
   with `apksigner`. It verifies V1/V2/V3 signatures. The debug signature and
   timestamps vary across reconstructions, so the recorded APK hash describes
   the tested fixture, not a reproducible-byte promise. No private key or APK
   binary belongs in this text-only checkpoint.
7. Follow `CHECKPOINT.md` for the live ISO installation and installed Linux
   boot. `run_vm.py` chooses `host-runtime` relative to its own directory. Its
   HTTP relay and fixed local ports are research conveniences, not production
   configuration. The source can fetch signed Alpine repositories on demand;
   `package-prep/prefetch.py` is an optional cache accelerator after obtaining
   the matching signed repository indexes, trusted ISO keys and `apk.static`
   described in `bootstrap-tools.json`. It is not needed for correctness.
8. In the installed guest, enable `psi=1`, initialize the pinned Android images,
   configure the software renderer and run `package-prep/guest-start.sh`.
   Refer to `GUEST-STARTUP.md` for actual diagnostics and the failed outcome.
   Wait for `sys.boot_completed=1` **before** installation/launch acceptance.
   Do not disable critical services, watchdogs or diagnostic signals to obtain
   an apparent pass.

The original host lacked `/dev/kvm`. This prototype therefore used QEMU TCG
with two virtual CPUs and 4 GiB RAM. Current native QEMU engines, guest ARM64,
relocatable Windows/Mac packaging, accelerated tests, audio, lifecycle cleanup,
security updates, permissions and full source/license closure remain separate
unimplemented release requirements.
