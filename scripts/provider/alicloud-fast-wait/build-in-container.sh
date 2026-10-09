#!/bin/sh
set -eu
. /recipe/manifest.env
mkdir -p /cache/source /cache/go-mod /cache/go-build /source /out
archive="/cache/source/${ALICLOUD_PROVIDER_SOURCE_COMMIT}.tar.gz"
if [ ! -f "$archive" ]; then
  curl -fsSL --connect-timeout 20 --retry 3 "$ALICLOUD_PROVIDER_SOURCE_URL" -o "$archive.download"
  mv "$archive.download" "$archive"
fi
printf '%s  %s\n' "$ALICLOUD_PROVIDER_SOURCE_SHA256" "$archive" | sha256sum -c -
tar -xzf "$archive" -C /source --strip-components=1
cp /source/alicloud/resource_alicloud_instance.go /tmp/original-instance.go
patch --batch --fuzz=0 -p1 < /recipe/create-delay.patch
python3 /recipe/check-source.py
export GOMODCACHE=/cache/go-mod GOCACHE=/cache/go-build
printf 'Building %s from %s\n' "$ALICLOUD_PROVIDER_VERSION" "$ALICLOUD_PROVIDER_SOURCE_COMMIT"
go test -mod=readonly -trimpath -count=1 -v ./fastwaitchecks
go build -mod=readonly -trimpath -buildvcs=false -ldflags="-s -w -buildid= -X github.com/aliyun/terraform-provider-alicloud/alicloud/connectivity.providerVersion=${ALICLOUD_PROVIDER_VERSION}" -o "/out/terraform-provider-alicloud_v${ALICLOUD_PROVIDER_VERSION}" .
printf 'Provider compilation complete\n'
set -a
. /recipe/manifest.env
set +a
python3 /recipe/package.py
python3 /recipe/validate.py
