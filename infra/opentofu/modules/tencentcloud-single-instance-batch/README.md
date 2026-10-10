# Tencent Cloud single-instance batch

The provider-aware worker executes this module in a per-batch work directory protected by a database lease, immutable account/provider/owner/network manifest and inspected target plan. Alibaba Cloud workspaces retain their existing module and provider.

The pinned `1.83.34-range.1` provider extends upstream `1.83.34` with a configurable immutable `client_token` and `action_timer_terminate_at`. The module sends the persisted creation intent and scheduled termination atomically in `RunInstances`; it creates only `POSTPAID_BY_HOUR` CVMs with managed cloud system disks. Secrets remain in the isolated process environment or sensitive password variables.

Each CVM retains its range/member ID, owner, context, verified account UID, batch, original creation job and unique intent. Shared VPC/subnet/security groups are references, not batch-owned resources. A positive public bandwidth allocates the CVM public IP; no separate retained EIP is created. The platform rejects images with attached data disks or incomplete disk metadata before creation.

An unknown apply never causes a second creation apply. Durable state, the submitted marker, the exact physical IDs and cloud ownership facts govern cleanup. An untracked system disk can be recovered only from the exact submitted CVM plus an independently queried CBS system-disk attachment and creation-time window. Foreign or unproven disks preserve `destroy_failed` and unreleased charges. The original tags alone do not prove disk creation.

Expiry must leave at least five minutes at apply time; intake requires ten minutes. Worker expiry handling remains responsible for platform state and cleanup verification after cloud termination.

```sh
sh scripts/provider/tencentcloud-idempotency/build.sh
sh scripts/dev/validate-tencentcloud-opentofu.sh
```

The isolated Docker validator checks schema, module validation and mock plans with `--network none`, no credentials and no live state. This does not verify actual inventory, stock, cloud billing or reclamation.
