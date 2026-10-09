# Tencent Cloud single-instance batch (preparatory)

This module is not connected to the production worker. It pins the official
`tencentcloudstack/tencentcloud` provider to **1.83.34** and is validated with
OpenTofu **1.13.1**. `TencentCloudOpenTofuRenderer.render(input)` produces the
module variables. The caller configures the provider's `region` and supplies
`TENCENTCLOUD_SECRET_ID` / `TENCENTCLOUD_SECRET_KEY` only in the isolated process
environment; no credentials are Terraform variables or inventory outputs.

Each `members` key is a durable platform range-instance ID. Account UIN, region,
zone, VPC, security group, subnet, exact sellable shape, system-only image and
creation intent must be verified and frozen before writing the workspace. The
module preserves `RangeInstanceId`, `OwnerUserId`, `PlatformUserId`,
`CloudAccountUid`, `SingleInstanceBatchId`, `CreationIntentId` and source tags.
Secrets live in a separate sensitive `member_passwords` map.

The module creates CVMs on `POSTPAID_BY_HOUR` with managed cloud system disks.
Additional data disks, attaching existing disks, prepaid instances, NAT gateways
and EIP resources are outside this first implementation. A preflight must reject
images containing data disks until their creation, ownership and cleanup paths
have been verified. Public IP allocation is off at bandwidth `0`; explicit
positive bandwidth uses the CVM's own public IP and
`TRAFFIC_POSTPAID_BY_HOUR`, not a separately retained EIP. The shared network
must already exist and is never destroyed by this batch workspace.

`members` exports the exact CVM ID, system-disk ID, discovered data-disk IDs,
addresses, state, owner and creation intent. `resource_inventory` includes all
host/system/data disk IDs and separates shared `referenced_network` from empty
`owned_network`. These IDs must be durably recorded for billing and cleanup before
declaring the job complete. Provider tags are not creation proof for CBS disks:
the instance resource only tags the CVM itself, so disks need original-account
DescribeDisks ownership and fee reconciliation.

## Safety limits before activating creation

The provider does **not** expose a `client_token` variable. In its
[official CVM implementation](https://github.com/tencentcloudstack/terraform-provider-tencentcloud/blob/v1.83.34/tencentcloud/services/cvm/resource_tc_instance.go)
it builds a new `ClientToken` inside every resource create and only reuses it for
that invocation's internal retries. `CreationIntentId` is audit evidence; it is
not a durable cloud idempotency guarantee. After a timeout, process loss or
incomplete state, the platform must reconcile exact platform identity in the
original account before any retry. An unknown result must remain blocked; a new
apply cannot blindly recreate the resource. The same guard is required for the
separate network workspace.

Provider delete completion must not be treated as proof that all chargeable
resources disappeared. Independently verify every recorded CVM/disk ID and any
image-derived disks in the original account before marking resources released.
In particular, the provider's postpaid data-disk deletion path dereferences a
DescribeDiskById result without a nil check; it is not validated for disks already
automatically removed with their CVM. Do not activate data-disk support based on
these mock tests.

## Offline Docker validation

```sh
sh scripts/dev/download-tencentcloud-provider.sh
sh scripts/dev/validate-tencentcloud-opentofu.sh
```

The archive's pinned linux/amd64 SHA-256 is
`c94c2074fef39d38b351c4e24190ec0bed6f7e1bc6b014f98a8672921eaf2c8b`,
verified against [the official release](https://github.com/tencentcloudstack/terraform-provider-tencentcloud/releases/tag/v1.83.34).
The downloader prefers [Tencent's official mirror](https://mirrors.tencent.com/terraform/registry.terraform.io/tencentcloudstack/tencentcloud/1.83.34.json)
and falls back to the GitHub release only on a transport failure. Every accepted
archive must match the pinned GitHub SHA-256; a tampered cache or downloaded
checksum mismatch stops validation. `TENCENTCLOUD_PROVIDER_DOWNLOAD_URL` can
override the transport URL but cannot bypass the pinned checksum.
The validator rebuilds its dedicated image, mounts no live state or credentials,
and uses `--network none` for `validate`, schema inspection and mock plans.
Mock plans include fifty distinct member identities; they do not measure actual
cloud creation speed or verify billable resource reclamation.

`scripts/ci/verify-docker.sh` runs the downloader inside the CI container and then
this offline validator before application tests. GitHub caches only the pinned
provider archive. `TENCENTCLOUD_PROVIDER_MIRROR_HOST_PATH` reuses an existing
read-only cache; validation images use an isolated run ID so concurrent worktrees
cannot overwrite each other's image tag.
