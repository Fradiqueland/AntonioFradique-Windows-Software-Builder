#!/usr/bin/env python3
"""Download only pinned current official VANILLA/MAINLINE prototype images."""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import hashlib
import json
import time
import urllib.request

ROOT = Path(__file__).resolve().parent


def download(meta):
    filename = ROOT / 'downloads' / meta['filename']
    part = filename.with_suffix('.part')
    digest = hashlib.sha256()
    count = 0
    started = time.monotonic()
    direct = meta['url'].replace('https://sourceforge.net/projects/waydroid/files/',
                                 'https://downloads.sourceforge.net/project/waydroid/').removesuffix('/download')
    with urllib.request.urlopen(direct, timeout=180) as source, part.open('wb') as output:
        while chunk := source.read(1024 * 1024):
            count += len(chunk)
            if count > meta['size']:
                raise RuntimeError('Download exceeded pinned size')
            digest.update(chunk)
            output.write(chunk)
    if count != meta['size'] or digest.hexdigest() != meta['id']:
        raise RuntimeError('Pinned image size/hash validation failed: ' + meta['filename'])
    part.rename(filename)
    result = {'file': filename.name, 'bytes': count, 'sha256': digest.hexdigest(),
              'elapsed_seconds': round(time.monotonic() - started, 2)}
    print(json.dumps(result), flush=True)
    return result


if __name__ == '__main__':
    metas = json.loads((ROOT / 'waydroid-images.json').read_text())
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(download, metas))
    (ROOT / 'image-download-evidence.json').write_text(json.dumps(results, indent=2) + '\n')
