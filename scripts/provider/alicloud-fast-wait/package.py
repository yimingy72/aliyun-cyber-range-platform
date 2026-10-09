import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import zipfile
import sys
import zlib

version = os.environ['ALICLOUD_PROVIDER_VERSION']
commit = os.environ['ALICLOUD_PROVIDER_SOURCE_COMMIT']
root = Path('/out')
binary = root / f'terraform-provider-alicloud_v{version}'
provider_dir = root / 'mirror/registry.opentofu.org/aliyun/alicloud'
provider_dir.mkdir(parents=True, exist_ok=True)
archive = provider_dir / f'terraform-provider-alicloud_{version}_linux_amd64.zip'

def sha256(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()

info = zipfile.ZipInfo(binary.name, date_time=(1980, 1, 1, 0, 0, 0))
info.compress_type = zipfile.ZIP_DEFLATED
info.create_system = 3
info.external_attr = 0o100555 << 16
with zipfile.ZipFile(archive.with_suffix('.zip.tmp'), 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as target:
    with binary.open('rb') as source, target.open(info, 'w', force_zip64=True) as member:
        shutil.copyfileobj(source, member, 1024 * 1024)
    license_info = zipfile.ZipInfo('LICENSE', date_time=(1980, 1, 1, 0, 0, 0))
    license_info.compress_type = zipfile.ZIP_DEFLATED
    license_info.create_system = 3
    license_info.external_attr = 0o100444 << 16
    target.writestr(license_info, Path('/source/LICENSE').read_bytes())
archive.with_suffix('.zip.tmp').replace(archive)
archive_hash = sha256(archive)
expected_hash = os.environ.get('ALICLOUD_PROVIDER_CUSTOM_SHA256')
if expected_hash and archive_hash != expected_hash:
    raise RuntimeError(f'Custom provider differs from pinned build: expected {expected_hash}, got {archive_hash}')
metadata = {
    'provider': 'registry.opentofu.org/aliyun/alicloud',
    'version': version,
    'platform': 'linux_amd64',
    'upstreamTag': 'v1.282.0',
    'sourceCommit': commit,
    'sourceUrl': os.environ['ALICLOUD_PROVIDER_SOURCE_URL'],
    'sourceArchiveSha256': os.environ['ALICLOUD_PROVIDER_SOURCE_SHA256'],
    'patchSha256': sha256(Path('/recipe/create-delay.patch')),
    'builderImage': 'golang:1.25-alpine@sha256:1ae0735f00daffa3aaf1363a5184c0d2dc55c78e3db4ec70241cdac97bf84b59',
    'pythonVersion': sys.version,
    'zlibVersion': zlib.ZLIB_RUNTIME_VERSION,
    'builderPackages': subprocess.check_output(['apk', 'info', '-v'], text=True).splitlines(),
    'goVersion': subprocess.check_output(['go', 'version'], text=True).strip(),
    'buildFlags': ['-mod=readonly', '-trimpath', '-buildvcs=false', '-ldflags=-s -w -buildid= -X github.com/aliyun/terraform-provider-alicloud/alicloud/connectivity.providerVersion=' + version],
    'binarySha256': sha256(binary),
    'archiveSha256': archive_hash,
    'change': 'alicloud_instance ECS creation initial delay 10s -> 2s; deletion and all other waiters unchanged',
    'upstreamLicense': 'MPL-2.0',
}
(root / 'provenance.json').write_text(json.dumps(metadata, indent=2) + '\n')
(root / 'provider.env').write_text(f'ALICLOUD_PROVIDER_VERSION={version}\nALICLOUD_PROVIDER_SHA256={archive_hash}\n')
print(json.dumps(metadata, indent=2))
