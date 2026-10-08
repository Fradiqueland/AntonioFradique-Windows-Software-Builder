# Guest startup notes

`guest-start.sh` is for the root account inside the dedicated QEMU Alpine guest only. Copy it into the guest after the official images have been installed and `waydroid init` completed.

Actual stable Alpine service names are `cgroups`, `dbus`, `udev`, `udev-trigger`, `udev-settle`, `udev-postmount`, `seatd`, `waydroid-container` and `sshd`. `eudev` is the package name, not the service name.

OpenRC defaults to cgroup v2 (`rc_cgroup_mode=unified`). Start with that supported default. `lxc-checkconfig`, `/proc/cgroups` and `/proc/self/cgroup` provide diagnostic evidence. Do not switch to legacy/hybrid merely because an old tutorial used cgroups v1.

The installed Linux 6.18.55-0-lts kernel has Binder IPC and binderfs built in, with traditional binder/hwbinder/vndbinder devices configured. `modprobe binder_linux` may fail because no module is needed. Waydroid's initializer allocates missing nodes from `/dev/binderfs/binder-control` and exposes selected nodes to Android as `/dev/binder`, `/dev/hwbinder` and `/dev/vndbinder`.

## PSI and the first actual Android startup failure

The first guest run reached LXC RUNNING and exposed a Binder service manager, then Android init reported repeated LMKD exits followed by InitFatalReboot. The guest kernel had `CONFIG_PSI=y`, `CONFIG_PSI_DEFAULT_DISABLED=y`, no `/proc/pressure/memory` interface, and no `CONFIG_MEMCG_V1` support.

Lineage 20 LMKD's `init_monitors()` first tries PSI by default. If that fails, it falls back to vmpressure, but `init_mp_common()` explicitly requires memory cgroup v1. If both mechanisms are unavailable, initialization fails. `lmkd.rc` marks LMKD as a critical service. Linux's `PSI_DEFAULT_DISABLED` setting explicitly requires the `psi=1` boot parameter to activate the compiled PSI interface. This explains why the missing interface is a concrete prerequisite failure; the next guest boot must still demonstrate successful Android startup.

Boot the guest with `psi=1` and verify that `/proc/pressure/memory` exists before starting Android. The startup script now checks this. Do not disable LMKD or switch to a legacy memory cgroup implementation absent from the compiled kernel.

Primary sources:

- [Lineage 20 LMKD source: init_monitors and init_mp_common](https://github.com/LineageOS/android_system_memory_lmkd/blob/lineage-20.0/lmkd.cpp)
- [Lineage 20 LMKD critical service configuration](https://github.com/LineageOS/android_system_memory_lmkd/blob/lineage-20.0/lmkd.rc)
- [Linux 6.18 PSI_DEFAULT_DISABLED boot requirement](https://github.com/torvalds/linux/blob/v6.18/init/Kconfig)
- [Android LMKD kernel requirements and PSI defaults](https://source.android.com/docs/core/perf/lmkd)
- [Linux PSI interfaces and monitoring](https://docs.kernel.org/accounting/psi.html)

## Separate cgroup and post-stop diagnostics

The same initial Android logs reported read-only errors when creating process groups. Changing the generated LXC `lxc.mount.auto` entry from `cgroup:ro` to `cgroup:rw` is a separate experiment inside the disposable VM; it is not yet established as a necessary correction. The startup script does not apply that experiment automatically.

Waydroid 1.6.2's [official config_base](https://github.com/waydroid/waydroid/blob/1.6.2/data/configs/config_base) sets `lxc.hook.post-stop = /dev/null`. The observed post-stop exit 126 is consistent with attempting to execute that non-executable device. Replacing that guest diagnostic hook with `/bin/true` removes secondary log noise; it does not fix LMKD's startup failure.

The extracted Alpine OpenRC `sysfs` service mounts fusectl only when the FUSE control path already exists at boot. Loading `fuse` later does not repeat that step. The startup script now explicitly mounts `fusectl` at `/sys/fs/fuse/connections` after loading FUSE. An empty directory alone does not prove failure: verify `/proc/mounts` and capture the actual vold/FUSE logs.

## Second actual startup: vold SIGPIPE

With `psi=1`, the second actual startup progressed to SystemServer boot phase 550 and WayDroidService. The repeated fatal LMKD exits disappeared. At guest uptime 491.153 seconds, init recorded `Service 'vold' (pid 25) received signal 13`; the subsequent `reboot,vold-failed` follows the `reboot_on_failure` directive in [Lineage 20 vold.rc](https://github.com/LineageOS/android_system_vold/blob/lineage-20.0/vold.rc). Signal 13 is SIGPIPE. This evidence does not establish a FUSE permission or mount failure.

A specific hypothesis worth tracing is the Android property socket. [Lineage 20 bionic system_property_set.cpp](https://github.com/LineageOS/android_bionic/blob/lineage-20.0/libc/bionic/system_property_set.cpp) connects an AF_LOCAL stream socket and sends protocol-2 requests with `writev`, without MSG_NOSIGNAL. [Lineage 20 init property_service.cpp](https://github.com/LineageOS/android_system_core/blob/lineage-20.0/init/property_service.cpp) gives a newly accepted request 2,000 ms to supply its data and closes the owned client descriptor on return. A delayed guest sender could write after that close. This is a source-backed hypothesis until the failing syscall and descriptor are captured; `ro.hw_timeout_multiplier` does not scale this hardcoded property timeout.

The path is reachable during later user-storage preparation: [FsCrypt.cpp](https://github.com/LineageOS/android_system_vold/blob/lineage-20.0/FsCrypt.cpp) calls `RestoreconRecursive` for CE directories; [Utils.cpp](https://github.com/LineageOS/android_system_vold/blob/lineage-20.0/Utils.cpp) sends `selinux.restorecon_recursive` twice and waits for the property without a timeout. This function ignores both send results. Merely ignoring SIGPIPE could therefore turn a failed send into an indefinite storage stall. A confirmed property-socket defect requires robust send/error handling or a controlled image correction, rather than suppressing the signal globally.

Install the locally cached, signature-verified `strace` diagnostic package in the guest. From Alpine guest root, trace the host PID of Android's vold before reproducing the failure:

```sh
apk add strace
strace -ff -tt -yy -s 180 \
  -e trace=write,writev,sendto,sendmsg,connect,close \
  -e signal=SIGPIPE -p "$(pidof vold)" -o /root/vold-strace
```

Correlate the final `EPIPE` and SIGPIPE with the descriptor path and init's `sys_prop: timeout waiting for uid ... to send property message` logs. Do not disable vold's failure directive or change broad storage permissions merely to conceal the shutdown. The prototype has not yet passed Android boot, APK rendering, or restart acceptance.

### Captured trace supersedes the property-socket hypothesis

The later warm-run trace actually captured `write(11<pipe:[34552]>, ...)
= -1 EPIPE (Broken pipe)` while vold emitted native diagnostic/backtrace text.
The payload begins `----- pid 29 ... -----`, then its command line, ABI and
Binder stack frames. This descriptor is a **pipe**, not the AF_LOCAL property
socket previously hypothesized. The record establishes a closed reader during
diagnostic output; it does not establish who closed the pipe, its timeout, or
the initial reason that a stack dump was requested. The earlier kernel record
of vold receiving SIGPIPE and the later captured EPIPE are from different
startup attempts and must not be silently presented as one complete trace.

No `sys.boot_completed=1`, successful fixture rendering, counter input change,
or native Windows/Mac runtime acceptance was captured. Do not suppress Android
watchdogs, critical-service directives or native diagnostic signals to turn
this failed experiment into a passing feature.

Set the software-rendering properties in `/var/lib/waydroid/waydroid.cfg` and regenerate offline with `waydroid upgrade -o` before starting:

```ini
[properties]
ro.hardware.gralloc=default
ro.hardware.egl=swiftshader
```

Weston DRM/Pixman draws onto the QEMU virtio GPU without virgl. QEMU's host VNC captures that framebuffer. This requires no KVM; QEMU TCG emulates the guest CPU. The approach still needs actual boot and rendering evidence and can be slow.

Waydroid 1.6.2 generates a mandatory LXC mount for the PulseAudio native socket. A real `pulseaudio` server is therefore included in the expanded package plan. A null sink permits startup even without a QEMU sound device; actual host audio additionally needs an emulated audio device and QEMU audio backend.

Run APK commands within the same D-Bus session as `waydroid session start`, or use the root-only `waydroid shell` command for diagnostics. A new unrelated `dbus-run-session` cannot see the existing Waydroid session service.

For a second root terminal inside this same guest, the startup script preserves the session address in a private runtime file:

```sh
export XDG_RUNTIME_DIR=/run/user/0
export WAYLAND_DISPLAY=wayland-0
export PULSE_RUNTIME_PATH=/run/user/0/pulse
export DBUS_SESSION_BUS_ADDRESS="$(cat /run/apk-guest/session-bus-address)"
waydroid status
waydroid app install /root/fixture.apk
waydroid app launch example.package.name
```

The supplied startup sequence has been checked against the extracted package/source interfaces, but has not been represented as a passed runtime test.
