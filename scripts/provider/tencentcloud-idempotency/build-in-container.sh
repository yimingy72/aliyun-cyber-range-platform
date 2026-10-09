#!/bin/sh
set -eu
. /recipe/manifest.env
mkdir -p /cache/source /cache/go-mod /cache/go-build /source /out
archive="/cache/source/${TENCENTCLOUD_PROVIDER_SOURCE_COMMIT}.tar.gz"
if [ ! -f "$archive" ]; then
  curl -fsSL --connect-timeout 20 --retry 3 "$TENCENTCLOUD_PROVIDER_SOURCE_URL" -o "$archive.download"
  mv "$archive.download" "$archive"
fi
printf '%s  %s\n' "$TENCENTCLOUD_PROVIDER_SOURCE_SHA256" "$archive" | sha256sum -c -
tar -xzf "$archive" -C /source --strip-components=1
patch --batch --fuzz=0 -p1 < /recipe/client-token.patch
python3 /recipe/check-source.py
cp /recipe/client_token_test.go /source/tencentcloud/services/cvm/range_client_token_test.go
gofmt -w /source/tencentcloud/services/cvm/resource_tc_instance.go /source/tencentcloud/services/cvm/range_client_token_test.go
export GOMODCACHE=/cache/go-mod GOCACHE=/cache/go-build GOPROXY=https://goproxy.cn,direct
go test -mod=readonly -trimpath -count=1 ./tencentcloud/services/cvm -run '^TestRangePersistedClientToken$'
go build -mod=readonly -trimpath -buildvcs=false -ldflags="-s -w -buildid=" -o "/out/terraform-provider-tencentcloud_v${TENCENTCLOUD_PROVIDER_VERSION}" .
python3 /recipe/package.py "$TENCENTCLOUD_PROVIDER_VERSION" "$TENCENTCLOUD_PROVIDER_CUSTOM_SHA256"
