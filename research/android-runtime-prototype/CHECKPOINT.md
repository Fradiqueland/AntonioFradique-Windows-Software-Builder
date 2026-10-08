# Android runtime feasibility checkpoint

This is an isolated experiment, **not a released APK runtime**. The production
Builder correctly reports Android execution as unavailable. All commands target
the disposable VM, not the host system or a user's project.

**Frozen result:** Linux/Binder/Wayland and partial Android 13 boot were proven.
The APK execution acceptance failed: Android never reported boot completion,
the fixture was not visibly rendered and no input-counter change was captured.
The current environment has no running QEMU guest. See `failure-evidence.log`
and `metrics.json`; a later trace captured EPIPE on a diagnostic/backtrace pipe,
which supersedes the speculative property-socket explanation for that write.
This is a current prototype blocker, not proof that Android on Windows/Mac is
permanently impossible. Native accelerated tests remain unimplemented.

## Inputs verified on 2026-10-08

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| Alpine 3.24.2 x86_64 virt ISO | 69,206,016 | `3ab424762af704b2c2a9e57df1dc37f982af260071504d977f2fb96822e7130b` |
| Waydroid Lineage 20.0 VANILLA x86_64 system, 2026-09-27 | 847,449,341 | `053552725bf4ae25e2d3f7e6f1947203294aa9d73dc17fe1f3abe646e5d3bd8a` |
| Waydroid Lineage 20.0 MAINLINE x86_64 vendor, 2026-09-27 | 189,818,687 | `d911b8353f6c807b94790b1c41c67e863a9f3dcd1cf3ec0232351398235afd7a` |

Official image metadata is saved in `waydroid-images.json`; measured downloads
in `image-download-evidence.json`. The two Android ZIPs total 1,037,268,028 bytes
before QEMU, the Linux guest or Electron. This cost is relevant to the user's
request to keep non-APK projects small: an eventual runtime must only be bundled
for projects that actually need Android.

The prototype uses isolated Ubuntu QEMU 8.2.2 security package
`1:8.2.2+ds-0ubuntu1.18`, downloaded from Ubuntu's 2026-08-28 package snapshot,
extracted under `host-runtime/`. It does not install a host emulator. There is
no `/dev/kvm`, so `run_vm.py` explicitly uses TCG software CPU emulation,
two virtual CPUs and 4 GiB guest RAM. A future shipping runtime needs separately
built, relocatable engines and native tests on Windows, Intel Mac and ARM Mac.

## Reproduction

The already-created `alpine-guest.qcow2` has a 12 GiB virtual limit. The local
runner serves verified Alpine repository packages and pinned files to the guest
on `http://10.0.2.2:8127`. Its HTTP, QMP and VNC listeners bind only to loopback.
Production authentication, per-session ports and process lifecycle are still
required. The host package cache uses trusted keys from the verified Alpine ISO.

The loopback package relay is an environment-specific workaround: this research
environment's process network namespaces and outbound proxy made a relay
outside the QEMU runner inaccessible to the guest. On a normal development
machine the standard Alpine HTTPS repositories can be used directly. There is
no requirement to use this relay, its ports, or this machine's paths in a
future distributed application. `run_vm.py` is a Linux research runner only.

Start the live installation environment:

```sh
PYTHONPATH=pypackages python run_vm.py
```

At its serial root shell:

```sh
ip link set eth0 up
udhcpc -i eth0 -q -n -t 3
printf '%s\n' 'auto lo' 'iface lo inet loopback' 'auto eth0' 'iface eth0 inet dhcp' > /etc/network/interfaces
rc-update add networking boot
printf '%s\n' 'http://10.0.2.2:8127/alpine/v3.24/main' 'http://10.0.2.2:8127/alpine/v3.24/community' > /etc/apk/repositories
apk update
ERASE_DISKS=/dev/vda setup-disk -m sys -k lts -s 0 /dev/vda
poweroff -f
```

`-k lts` is essential: Alpine's small virt kernel does not enable Android
Binder. Stable `linux-lts 6.18.55-r0` enables both Binder IPC and BinderFS.
The disk installer selects `linux-firmware-none`; installing all physical
hardware firmware would waste hundreds of megabytes in a VM. An interrupted
first installation is safe to overwrite because this disk has no user content.

**Observed boot fix:** the actual Alpine LTS configuration has
`CONFIG_PSI_DEFAULT_DISABLED=y` and no v1 memory controller
(`CONFIG_MEMCG_V1` unset). The installed kernel must therefore boot with
`psi=1`. Without it `/proc/pressure/memory` is absent, Android's `lmkd` exits
four times and init aborts before Android boot completion. Add `psi=1` to the
`APPEND` line in `/boot/extlinux.conf` and to the persistent default kernel
options used by Alpine's bootloader generator. This is a guest OS setting;
it does not require changing the Windows/Mac host kernel.

The first real container start reached Binder service manager, then failed
after about 36 seconds. Kernel diagnostics are retained in `serial.log`:
`createProcessGroup ... Read-only file system`, repeated `lmkd` exit and
`InitFatalReboot: signal 6`. The prototype also changes Waydroid's generated
`lxc.mount.auto` from `cgroup:ro` to `cgroup:rw` inside the disposable VM and
mounts `fusectl` at `/sys/fs/fuse/connections`. These diagnostic changes still
require a successful boot and subsequent security review; they are not shipped.
Waydroid's `/dev/null` post-stop hook reports exit 126 after container failure;
this secondary error is not the original Android boot failure. The prototype
uses `/bin/true` for that hook to avoid distracting diagnostics.

Boot the installed disk:

```sh
PYTHONPATH=pypackages python run_vm.py --installed
```

Then install the signed dependencies in the guest (never execute their
maintainer scripts on the host):

```sh
apk add waydroid waydroid-openrc linux-firmware-none weston weston-backend-drm weston-shell-desktop eudev eudev-openrc seatd seatd-openrc dbus dbus-openrc openssh curl unzip e2fsprogs
```

The intended display path is Weston DRM with Pixman on QEMU VirtIO GPU,
Waydroid software rendering (`ro.hardware.gralloc=default` and
`ro.hardware.egl=swiftshader`) and QEMU VNC/display capture. This is a hypothesis
until actual Android boot, APK install and input evidence are recorded. Weston
headless plus wayvnc does not satisfy this setup: stable Alpine Weston has no
VNC backend and wayvnc does not support Weston.

Pinned system/vendor images should be extracted to
`/etc/waydroid-extra/images/` before `waydroid init`, which uses the preinstalled
images without downloading another runtime. Binder, cgroups, loop/FUSE,
DBus/seatd/eudev and the Wayland session must work inside the guest.

## Fixture and acceptance

`build_fixture.py` assembles a pure-Dex, architecture-independent Android APK
using Smali and isolated `aapt`, then signs and verifies V1/V2/V3 with
`apksigner`. `fixtures/builder-prototype.apk` is 12,631 bytes. Its single full
screen button displays `APK RUNNING — TAP HERE` and a click counter. No network
permission, native library, Play Services or proprietary ARM bridge is used.

Acceptance requires the Android guest to report boot completion, the fixture
to install and launch, a screenshot with `Clicks: 0`, a real input event, then a
second screenshot with `Clicks: 1`. QMP commands are requested through
`control-request.json`; the runner writes `control-response.json` and screenshots
under `evidence/`. `serial.log` retains guest boot and errors;
`qemu-process-evidence.json` records wall time, CPU seconds and peak RSS when the
runner exits.

An isolated Linux proof does **not** prove Windows/Mac operation, sound,
keyboard, APK ABI coverage, smooth video, first-launch speed or safe packaging.
VNC carries display/input; it does not automatically carry Android audio.
WHPX needs a Windows optional OS feature and HVF only accelerates a matching
guest ISA. A bundled ARM guest is therefore needed for good ARM Mac performance.

## Source and licensing closure before distribution

Do not publish these image ZIPs merely because they boot. Pin source manifests,
recipe, patches, complete component licenses and corresponding source for QEMU,
Linux, Alpine, Waydroid, Lineage/AOSP and bundled dependencies/firmware. Vanilla
images avoid GApps but this is not a blanket license clearance. Redistribution
and update/security policy remain release acceptance work.

Primary sources:

- https://docs.waydro.id/usage/install-on-desktops
- https://docs.waydro.id/faq/get-waydroid-to-work-through-a-vm
- https://docs.waydro.id/usage/install-and-run-android-applications
- https://github.com/waydroid/OTA
- https://pkgs.alpinelinux.org/packages?name=waydroid&branch=v3.24
- https://gitlab.alpinelinux.org/alpine/aports/-/tree/3.24-stable/main/linux-lts
- https://www.qemu.org/docs/master/system/invocation.html
- https://www.qemu.org/docs/master/system/whpx.html
- https://source.android.com/docs/setup/start/requirements

