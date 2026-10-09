# Alibaba Cloud provider with earlier ECS readiness checks

This source build pins upstream `v1.282.0`, commit
`501318273fb83fabb981d45383d2fd7075ec7c8a`, and changes **only** the
`alicloud_instance` creation waiter's first delay from 10 seconds to 2 seconds.
The resulting provider version is **`1.282.0-range.1`**. It remains a real
OpenTofu provider using the upstream resource implementation and state schema.

The Running target, Pending/Starting/Stopped states, Stopping failure state,
NotFound retries, 10-minute creation timeout and minimum 3-second subsequent
poll interval remain intact. ECS deletion still waits 10 seconds initially.
Earlier polling does not guarantee that Alibaba Cloud finishes provisioning
sooner; more concurrent resources can generate more status requests.

## Rebuild and verify

Run from the repository root:

```sh
scripts/provider/alicloud-fast-wait/build.sh
```

The script runs every build and verification step inside Docker, with 2 CPUs,
5 GiB RAM, Go `-p=1` and `GOMAXPROCS=2`. The Go and OpenTofu base images are
pinned by digest. The upstream archive is checked against its committed SHA256
before applying the zero-fuzz patch. Go module checksums remain enabled.
`-trimpath`, disabled VCS stamping, a cleared build ID, and fixed ZIP metadata
make the artifact reproducible. The provider's request version is set through
`-X`, without changing upstream runtime code.

Output defaults to `.local/provider-fast-wait/`:

- `mirror/registry.opentofu.org/aliyun/alicloud/terraform-provider-alicloud_1.282.0-range.1_linux_amd64.zip`
- `provider.env`: provider version and archive SHA256 for runtime verification.
- `provenance.json`: source, patch, builder, binary and archive hashes.
- `validation/`: actual OpenTofu init, validate, schema and lock file evidence.
- `cache/`: verified source archive, Go modules and compilation cache.

`ALICLOUD_PROVIDER_BUILD_OUTPUT` and `ALICLOUD_PROVIDER_BUILD_CACHE` can select
absolute output/cache directories. CI can cache the latter, keyed by this
recipe's files and image digests; the build still validates source and output
checksums. No credentials or cloud access are required by these checks.

## Runtime integration

Use the new mirror directory as a **separate read-only mount**. Set
`ALICLOUD_PROVIDER_VERSION=1.282.0-range.1` and the matching
`ALICLOUD_PROVIDER_SHA256` from `provider.env`; keep the official 1.282.0 archive
for rollback. Use the exact custom version in each module and generated wrapper.
A prerelease must be explicitly requested; an `= 1.282.0` constraint does not
select this build. Registry identity stays `registry.opentofu.org/aliyun/alicloud`
so state ownership/schema are retained.

Existing workspace lock files must be updated by `tofu init -upgrade` with the
changed exact version constraint and this mirror available. Do not relabel the
custom ZIP as official 1.282.0, remove checksums, delete state or use
`dev_overrides` in production. The runtime's existing archive checksum check and
immutable unpacked cache still apply.

Tests check that the upstream source differs by only the intended delay,
exercise the upstream waiter against eventual consistency and failure cases,
and invoke the real provider through OpenTofu init/schema/validate. These are
offline checks, not a 50-ECS cloud benchmark. The checked-in patch and pinned
source URL provide corresponding modified MPL-2.0 source for this local build.
