#!/usr/bin/env python3
"""Local feasibility experiment; not a distributable product runtime."""
import argparse
import hashlib
import http.server
import json
import os
from pathlib import Path
import resource
import socket
import subprocess
import threading
import time
import urllib.request
import urllib.parse
import requests

ROOT = Path(__file__).resolve().parent
PACKAGE_CACHE = ROOT / 'package-cache'
PACKAGE_CACHE.mkdir(exist_ok=True)
SESSION = requests.Session()


class PackageProxy(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        name = urllib.parse.urlsplit(self.path).path
        files = {'/files/system.zip': ROOT / 'downloads/lineage-20.0-20260927-VANILLA-waydroid_x86_64-system.zip',
                 '/files/vendor.zip': ROOT / 'downloads/lineage-20.0-20260927-MAINLINE-waydroid_x86_64-vendor.zip',
                 '/files/prototype.apk': ROOT / 'fixtures/builder-prototype.apk'}
        if name in files:
            file = files[name]
            if not file.is_file():
                self.send_error(404)
                return
            self.send_response(200)
            self.send_header('Content-Length', str(file.stat().st_size))
            self.end_headers()
            with file.open('rb') as source:
                while chunk := source.read(1024 * 1024):
                    self.wfile.write(chunk)
            return
        if not name.startswith('/alpine/v3.24/') or '..' in name.split('/'):
            self.send_error(404)
            return
        url = 'https://dl-cdn.alpinelinux.org' + name
        try:
            relative = Path(name.removeprefix('/alpine/v3.24/'))
            prepared_file = ROOT / 'package-prep/repos' / relative
            cache_file = PACKAGE_CACHE / relative
            cache_file.parent.mkdir(parents=True, exist_ok=True)
            if prepared_file.is_file() and prepared_file.stat().st_size:
                cache_file = prepared_file
            elif relative.name != 'APKINDEX.tar.gz':
                previous_file = PACKAGE_CACHE / relative.name
                if previous_file.is_file() and previous_file.stat().st_size:
                    cache_file = previous_file
            if cache_file.is_file() and cache_file.stat().st_size:
                self.send_response(200)
                self.send_header('Content-Length', str(cache_file.stat().st_size))
                self.end_headers()
                with cache_file.open('rb') as source:
                    while chunk := source.read(1024 * 1024):
                        self.wfile.write(chunk)
            else:
                with SESSION.get(url, stream=True, timeout=90) as source:
                    source.raise_for_status()
                    self.send_response(200)
                    self.send_header('Content-Type', source.headers.get('Content-Type', 'application/octet-stream'))
                    if source.headers.get('Content-Length'):
                        self.send_header('Content-Length', source.headers['Content-Length'])
                    self.end_headers()
                    part = cache_file.with_suffix('.part')
                    with part.open('wb') as output:
                        for chunk in source.iter_content(128 * 1024):
                            self.wfile.write(chunk)
                            output.write(chunk)
                    part.replace(cache_file)
        except Exception as error:
            print('PACKAGE_PROXY_ERROR', name, type(error).__name__, flush=True)
            self.send_error(502)

    def log_message(self, format, *args):
        if args and str(args[0]).startswith('GET'):
            print('PACKAGE', args[0].split(' ')[1], flush=True)


def qmp(execute, arguments):
    with socket.create_connection(('127.0.0.1', 4445), timeout=10) as sock:
        stream = sock.makefile('rwb')
        json.loads(stream.readline())
        stream.write(b'{"execute":"qmp_capabilities"}\n')
        stream.flush()
        while 'return' not in json.loads(stream.readline()):
            pass
        stream.write(json.dumps({'execute': execute, 'arguments': arguments}).encode() + b'\n')
        stream.flush()
        while True:
            result = json.loads(stream.readline())
            if 'return' in result or 'error' in result:
                return result


def control_mailbox():
    request = ROOT / 'control-request.json'
    response = ROOT / 'control-response.json'
    while True:
        if request.exists():
            data = json.loads(request.read_text())
            request.unlink()
            try:
                if data['action'] == 'screenshot':
                    file = ROOT / 'evidence' / ('screen-' + str(int(time.time())) + '.ppm')
                    file.parent.mkdir(exist_ok=True)
                    result = qmp('screendump', {'filename': str(file)})
                    result['file'] = str(file)
                elif data['action'] == 'click':
                    qmp('input-send-event', {'events': [
                        {'type': 'abs', 'data': {'axis': 'x', 'value': int(data.get('x', 16384))}},
                        {'type': 'abs', 'data': {'axis': 'y', 'value': int(data.get('y', 16384))}},
                        {'type': 'btn', 'data': {'button': 'left', 'down': True}}]})
                    result = qmp('input-send-event', {'events': [
                        {'type': 'btn', 'data': {'button': 'left', 'down': False}}]})
                else:
                    raise ValueError('Unknown control action')
            except Exception as error:
                result = {'error': type(error).__name__}
            response.write_text(json.dumps(result) + '\n')
        time.sleep(0.25)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--installed', action='store_true')
    args = parser.parse_args()
    proxy = http.server.ThreadingHTTPServer(('127.0.0.1', 8127), PackageProxy)
    threading.Thread(target=proxy.serve_forever, daemon=True).start()
    threading.Thread(target=control_mailbox, daemon=True).start()
    env = os.environ.copy()
    env['LD_LIBRARY_PATH'] = str(ROOT / 'host-runtime/usr/lib/x86_64-linux-gnu')
    env['QEMU_MODULE_DIR'] = str(ROOT / 'host-runtime/usr/lib/x86_64-linux-gnu/qemu')
    command = [str(ROOT / 'host-runtime/usr/bin/qemu-system-x86_64'),
               '-L', str(ROOT / 'host-runtime/usr/share/qemu'),
               '-bios', str(ROOT / 'host-runtime/usr/share/seabios/bios-256k.bin'),
               '-machine', 'q35', '-accel', 'tcg,thread=multi',
               '-cpu', 'max,-avx,-avx2', '-m', '4096', '-smp', '2',
               '-drive', f'file={ROOT / "alpine-guest.qcow2"},if=virtio,format=qcow2',
               '-display', 'none', '-chardev', f'stdio,id=console,signal=off,logfile={ROOT / "serial.log"},logappend=on',
               '-serial', 'chardev:console', '-monitor', 'none',
               '-qmp', 'tcp:127.0.0.1:4445,server=on,wait=off',
               '-netdev', 'user,id=net0,hostfwd=tcp:127.0.0.1:22252-:22',
               '-device', 'virtio-net-pci,netdev=net0,romfile=',
               '-device', f'virtio-vga,romfile={ROOT / "host-runtime/usr/share/seabios/vgabios-virtio.bin"}',
               '-vnc', '127.0.0.1:52', '-device', 'qemu-xhci', '-device', 'usb-tablet',
               '-no-reboot']
    if not args.installed:
        command += ['-kernel', str(ROOT / 'vmlinuz-virt'), '-initrd', str(ROOT / 'initramfs-virt'),
                    '-append', 'modules=loop,squashfs,sd-mod,usb-storage rootfstype=tmpfs console=ttyS0,115200 quiet',
                    '-cdrom', str(ROOT / 'downloads/alpine-virt-3.24.2-x86_64.iso'), '-boot', 'd']
    print('PROTOTYPE_QEMU_START', 'installed' if args.installed else 'ISO', flush=True)
    started = time.monotonic()
    try:
        return subprocess.call(command, cwd=ROOT, env=env)
    finally:
        proxy.shutdown()
        usage = resource.getrusage(resource.RUSAGE_CHILDREN)
        (ROOT / 'qemu-process-evidence.json').write_text(json.dumps({
            'elapsed_seconds': time.monotonic() - started,
            'user_cpu_seconds': usage.ru_utime, 'system_cpu_seconds': usage.ru_stime,
            'max_rss_kib': usage.ru_maxrss
        }, indent=2) + '\n')


if __name__ == '__main__':
    raise SystemExit(main())
