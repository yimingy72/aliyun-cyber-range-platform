import sys, pathlib, hashlib, zipfile
version=sys.argv[1]
binary=pathlib.Path('/out')/f'terraform-provider-tencentcloud_v{version}'
archive=pathlib.Path('/out/mirror/registry.opentofu.org/tencentcloudstack/tencentcloud')/f'terraform-provider-tencentcloud_{version}_linux_amd64.zip'
archive.parent.mkdir(parents=True,exist_ok=True)
temporary=archive.with_suffix('.build-tmp')
with zipfile.ZipFile(temporary,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=9) as z:
  entry=zipfile.ZipInfo(binary.name,(1980,1,1,0,0,0));entry.external_attr=0o100755 << 16;entry.compress_type=zipfile.ZIP_DEFLATED
  z.writestr(entry,binary.read_bytes())
sha=hashlib.sha256(temporary.read_bytes()).hexdigest()
if len(sys.argv)>2 and sys.argv[2] and sha != sys.argv[2]: raise RuntimeError('Pinned provider build checksum differs; preserve artifact for review')
temporary.replace(archive)
pathlib.Path('/out/provider.sha256').write_text(sha+'\n')
print('Patched Tencent provider SHA256:',sha)
