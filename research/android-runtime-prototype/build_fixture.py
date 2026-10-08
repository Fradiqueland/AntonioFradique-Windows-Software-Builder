#!/usr/bin/env python3
"""Build the synthetic APK using Ubuntu-repackaged AOSP tools and Smali."""
from pathlib import Path
import os
import subprocess
import zipfile

ROOT = Path(__file__).resolve().parent
TOOLS = ROOT / 'host-runtime'
FIXTURE = ROOT / 'fixtures'
env = os.environ.copy()
env['LD_LIBRARY_PATH'] = ':'.join(str(TOOLS / p) for p in [
    'usr/lib/x86_64-linux-gnu/android', 'usr/lib/x86_64-linux-gnu'])
subprocess.run(['java', '-cp', str(TOOLS / 'usr/share/java/*'), 'org.jf.smali.Main',
                'assemble', str(FIXTURE / 'smali'), '-o', str(FIXTURE / 'classes.dex')], check=True)
unsigned = FIXTURE / 'prototype-unsigned.apk'
subprocess.run([str(TOOLS / 'usr/bin/aapt'), 'package', '-f', '-M', str(FIXTURE / 'AndroidManifest.xml'),
                '-I', str(TOOLS / 'usr/share/android-framework-res/framework-res.apk'),
                '-F', str(unsigned)], check=True, env=env)
with zipfile.ZipFile(unsigned, 'a') as apk:
    apk.write(FIXTURE / 'classes.dex', 'classes.dex')
key = ROOT / 'fixture-debug-key.p12'
if not key.exists():
    subprocess.run(['keytool', '-genkeypair', '-keystore', str(key), '-storetype', 'PKCS12',
                    '-storepass', 'prototype-only', '-keypass', 'prototype-only',
                    '-alias', 'prototype', '-keyalg', 'RSA', '-keysize', '2048',
                    '-validity', '365', '-dname', 'CN=Builder Synthetic Fixture'], check=True)
subprocess.run(['java', '-jar', str(TOOLS / 'usr/share/java/apksigner-31.0.2.jar'), 'sign',
                '--ks', str(key), '--ks-pass', 'pass:prototype-only', '--ks-key-alias', 'prototype',
                '--out', str(FIXTURE / 'builder-prototype.apk'), str(unsigned)], check=True)
subprocess.run(['java', '-jar', str(TOOLS / 'usr/share/java/apksigner-31.0.2.jar'), 'verify',
                '--verbose', str(FIXTURE / 'builder-prototype.apk')], check=True)
print('SYNTHETIC_APK', (FIXTURE / 'builder-prototype.apk').stat().st_size)
