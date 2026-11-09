#!/usr/bin/env python3
"""Rebuild the Java Android host around a previously built ARM64 server payload.

Usage: JAVA_HOME=... ANDROID_HOME=... python3 scripts/android/rebuild-host.py base.apk output.apk [assets-directory]
The output is unsigned; use apksigner with the same key as the existing install.
No personal data is read or embedded by this build.
"""
from pathlib import Path
import os
import hashlib
import json
import re
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET
import zipfile

root = Path(__file__).resolve().parents[2]
base, output = map(lambda p: Path(p).resolve(), sys.argv[1:3])
assets = Path(sys.argv[3]).resolve() if len(sys.argv) > 3 else None
if assets:
    bundle = json.loads((assets/'bundle.json').read_text())
    if hashlib.sha256((assets/'server.zip').read_bytes()).hexdigest() != bundle['sha256']:
        raise ValueError('Server payload does not match bundle.json')
sdk = Path(os.environ['ANDROID_HOME'])
java = Path(os.environ['JAVA_HOME']) / 'bin'
tools = sdk / 'build-tools' / os.environ.get('LH_BUILD_TOOLS', '36.0.0')
platform = sdk / 'platforms' / os.environ.get('LH_ANDROID_PLATFORM', 'android-36') / 'android.jar'
gradle = (root/'android/app/build.gradle').read_text()
version_code = re.search(r'versionCode\s+(\d+)', gradle).group(1)
version_name = re.search(r"versionName\s+'([^']+)'", gradle).group(1)

def run(*args):
    subprocess.run([str(a) for a in args], check=True)

with tempfile.TemporaryDirectory(prefix='lh-android-host-') as tmp:
    work = Path(tmp)
    generated, classes, dex = work/'generated', work/'classes', work/'dex'
    for p in (generated, classes, dex): p.mkdir()
    ET.register_namespace('android', 'http://schemas.android.com/apk/res/android')
    manifest = ET.parse(root/'android/app/src/main/AndroidManifest.xml')
    manifest.getroot().set('package', 'ar.com.learnharness')
    manifest.write(work/'AndroidManifest.xml', encoding='utf-8', xml_declaration=True)
    run(tools/'aapt2', 'compile', '--dir', root/'android/app/src/main/res', '-o', work/'res.zip')
    run(tools/'aapt2', 'link', '-o', work/'base.apk', '-I', platform, '--manifest', work/'AndroidManifest.xml',
        '--min-sdk-version', '26', '--target-sdk-version', '35', '--version-code', version_code,
        '--version-name', version_name, '--java', generated, work/'res.zip')
    (generated/'ar/com/learnharness/BuildConfig.java').write_text(
        'package ar.com.learnharness; public final class BuildConfig { public static final boolean DEBUG = false; }\n')
    sources = [*root.glob('android/app/src/main/java/**/*.java'), *generated.rglob('*.java')]
    run(java/'javac', '--release', '17', '-classpath', platform, '-d', classes, *sources)
    run(java/'jar', 'cf', work/'classes.jar', '-C', classes, '.')
    run(tools/'d8', '--release', '--min-api', '26', '--lib', platform, '--output', dex, work/'classes.jar')
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as out:
        with zipfile.ZipFile(work/'base.apk') as res:
            for info in res.infolist(): out.writestr(info, res.read(info))
        with zipfile.ZipFile(base) as original:
            for info in original.infolist():
                if info.filename.startswith('lib/arm64-v8a/') or (not assets and info.filename.startswith('assets/')):
                    out.writestr(info, original.read(info))
        if assets:
            for file in sorted(assets.rglob('*')):
                if file.is_file(): out.write(file, 'assets/' + file.relative_to(assets).as_posix())
        out.write(dex/'classes.dex', 'classes.dex')
    print('Unsigned APK:', output)
