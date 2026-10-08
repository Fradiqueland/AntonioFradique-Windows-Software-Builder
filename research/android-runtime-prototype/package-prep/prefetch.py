#!/usr/bin/env python3
"""Prepare signed Alpine guest packages outside the production repository."""
import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time
import urllib.request

ROOT = Path(__file__).resolve().parent
REPOS = ("main", "community")
PACKAGES = ["waydroid", "waydroid-openrc", "linux-lts", "linux-firmware-none",
            "weston", "weston-backend-drm", "weston-shell-desktop", "eudev",
            "eudev-openrc", "seatd", "seatd-openrc", "dbus", "dbus-openrc",
            "openssh", "curl", "unzip", "e2fsprogs", "alpine-base", "openssl",
            "syslinux", "sfdisk", "pulseaudio"]


def apk_command():
    command = [str(ROOT / "apk.static"), "--root", str(ROOT / "emptyroot"),
               "--arch", "x86_64", "--keys-dir", str(ROOT / "keys")]
    for repo in REPOS:
        command += ["--repository", str(ROOT / "repos" / repo)]
    return command


def resolve():
    entries = {}
    for repo in REPOS:
        for text in (ROOT / (repo + "-APKINDEX")).read_text().split("\n\n"):
            entry = dict(line.split(":", 1) for line in text.splitlines() if ":" in line)
            if "P" in entry:
                entries[entry["P"] + "-" + entry["V"] + ".apk"] = (repo, entry)
    result = subprocess.run(apk_command() + ["fetch", "--recursive", "--url",
                                             "--simulate"] + PACKAGES,
                            capture_output=True, text=True, check=True)
    manifest = []
    for name in sorted(set(result.stdout.splitlines())):
        target = Path(name)
        repo, entry = entries[target.name]
        manifest.append({"package": entry["P"], "version": entry["V"],
                         "file": target.name, "repo": repo, "bytes": int(entry["S"]),
                         "installedBytes": int(entry["I"]), "indexChecksum": entry["C"],
                         "url": f"https://dl-cdn.alpinelinux.org/alpine/v3.24/{repo}/x86_64/{target.name}",
                         "target": str(target)})
    (ROOT / "package-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    (ROOT / "root-packages.json").write_text(json.dumps(PACKAGES, indent=2) + "\n")
    return manifest


def download(entry):
    target = Path(entry["target"])
    if target.exists() and target.stat().st_size == entry["bytes"]:
        return "cached"
    partial = target.with_suffix(".part")
    for attempt in range(3):
        try:
            request = urllib.request.Request(entry["url"], headers={"User-Agent": "Android-Builder-Prototype/0.1"})
            with urllib.request.urlopen(request, timeout=150) as response, partial.open("wb") as output:
                while chunk := response.read(1024 * 1024):
                    output.write(chunk)
            if partial.stat().st_size != entry["bytes"]:
                raise ValueError("Unexpected package size")
            partial.replace(target)
            return "downloaded"
        except Exception:
            if attempt == 2:
                raise
    raise RuntimeError("unreachable")


def main():
    manifest = resolve()
    print("RESOLVED", len(manifest), "PACKAGES", sum(e["bytes"] for e in manifest), "BYTES", flush=True)
    completed = 0
    failures = []
    start = time.monotonic()
    # Limit concurrent proxy requests and bring boot-critical packages forward.
    priority = {"linux-lts", "musl", "alpine-base", "syslinux", "sfdisk"}
    queue = sorted(manifest, key=lambda e: (e["package"] not in priority, e["file"]))
    with concurrent.futures.ThreadPoolExecutor(max_workers=int(os.environ.get("APK_PREFETCH_WORKERS", "4"))) as executor:
        pending = {executor.submit(download, entry): entry for entry in queue}
        for future in concurrent.futures.as_completed(pending):
            entry = pending[future]
            try:
                future.result()
                completed += 1
                if completed % 15 == 0 or completed == len(manifest):
                    print("CACHED", completed, "OF", len(manifest), "SECONDS", round(time.monotonic() - start, 1), flush=True)
            except Exception as error:
                failures.append(entry["file"])
                print("FAILED", entry["file"], type(error).__name__, flush=True)
    if failures:
        raise SystemExit("Package downloads failed: " + ", ".join(failures))
    # Do not disable signatures: verify downloaded APK control/data payloads
    # against the Alpine public keys already included in the official guest ISO.
    verified = subprocess.run([str(ROOT / "apk.static"), "--keys-dir", str(ROOT / "keys"),
                               "verify"] + [e["target"] for e in manifest],
                              capture_output=True, text=True)
    (ROOT / "signature-verification.log").write_text(verified.stdout + verified.stderr)
    if verified.returncode:
        print("APK_VERIFY_FAILED", verified.returncode, verified.stderr[:1000], flush=True)
        raise SystemExit(verified.returncode)
    for entry in manifest:
        entry["sha256"] = hashlib.sha256(Path(entry["target"]).read_bytes()).hexdigest()
    (ROOT / "package-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print("READY", len(manifest), "SIGNED_PACKAGES", "SECONDS", round(time.monotonic() - start, 1), flush=True)


if __name__ == "__main__":
    main()
