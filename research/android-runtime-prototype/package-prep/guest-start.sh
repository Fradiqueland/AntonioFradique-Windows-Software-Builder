#!/bin/sh
# Execute only inside the isolated Alpine prototype VM, never on the host.
# Waydroid must already be initialized with the matching official VANILLA images.
set -eu

if [ "$(id -u)" -ne 0 ] || [ ! -x /usr/bin/waydroid ] || [ ! -f /etc/alpine-release ]; then
    echo "Run this only as root inside the Alpine Waydroid prototype VM." >&2
    exit 1
fi

# Alpine's LTS kernel compiles PSI but disables it by default. LMKD needs PSI
# with this cgroup-v2-only memory configuration; activate it with guest psi=1.
if [ ! -r /proc/pressure/memory ]; then
    echo "Missing guest PSI interface. Boot the guest kernel with psi=1 before starting Android." >&2
    exit 1
fi

mkdir -p /var/log/apk-guest /run/user/0 /run/apk-guest
chmod 700 /run/user/0
chmod 700 /run/apk-guest
export XDG_RUNTIME_DIR=/run/user/0
export WAYLAND_DISPLAY=wayland-0
export PULSE_RUNTIME_PATH="$XDG_RUNTIME_DIR/pulse"
export LIBSEAT_BACKEND=seatd

# Stable OpenRC defaults to cgroup v2. No v1 override is required initially.
rc-service cgroups start
rc-service dbus start
rc-service udev start
rc-service udev-trigger start
rc-service udev-settle start
rc-service seatd start

modprobe virtio_gpu
modprobe evdev
modprobe loop
modprobe fuse
if ! grep -qs ' /sys/fs/fuse/connections ' /proc/mounts; then
    mount -t fusectl -o nodev,nosuid,noexec fusectl /sys/fs/fuse/connections
fi

# Binder IPC is built into linux-lts. Waydroid allocates binderfs nodes itself
# if the traditional /dev/binder, /dev/hwbinder and /dev/vndbinder are absent.
if ! grep -qw binder /proc/filesystems; then
    echo "The running kernel lacks binderfs; boot the installed linux-lts kernel." >&2
    exit 1
fi

rc-service waydroid-container start

# All Waydroid session/install/launch commands below share the same D-Bus bus.
exec dbus-run-session -- sh -c '
    set -eu
    umask 077
    printf "%s\n" "$DBUS_SESSION_BUS_ADDRESS" > /run/apk-guest/session-bus-address
    pulseaudio --start --exit-idle-time=-1 --log-target=file:/var/log/apk-guest/pulse.log
    weston --backend=drm --renderer=pixman --socket=wayland-0 \
        --shell=kiosk-shell.so --idle-time=0 --log=/var/log/apk-guest/weston.log &
    weston_pid=$!
    trap "waydroid session stop >/dev/null 2>&1 || true; kill $weston_pid >/dev/null 2>&1 || true" EXIT INT TERM
    remaining=30
    while [ ! -S "$XDG_RUNTIME_DIR/$WAYLAND_DISPLAY" ] || [ ! -S "$PULSE_RUNTIME_PATH/native" ]; do
        remaining=$((remaining - 1))
        if [ "$remaining" -le 0 ] || ! kill -0 "$weston_pid" 2>/dev/null; then
            echo "Guest display or PulseAudio socket failed; inspect /var/log/apk-guest." >&2
            exit 1
        fi
        sleep 1
    done
    # show-full-ui creates a session itself and waits for Android user readiness
    # before selecting the full UI, avoiding competing session-start commands.
    waydroid show-full-ui > /var/log/apk-guest/session.log 2>&1 &
    session_pid=$!
    wait "$session_pid"
'
