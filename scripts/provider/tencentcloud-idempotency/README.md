# Audited Tencent CVM creation patch

Build upstream commit `e0d222151a29d44795492d68a1076d55ec006cdb` (v1.83.34) using the pinned linux/amd64 Go container. The source archive checksum, zero-fuzz patch and deterministic provider archive checksum are recorded in `manifest.env`.

The CVM patch adds two immutable optional attributes:

- `client_token` replaces the upstream per-process random token when supplied. Unmodified external configurations keep upstream behavior.
- `action_timer_terminate_at` sends `ActionTimer { TimerAction: TerminateInstances, ActionTime: UTC }` atomically with `RunInstances`, rejecting times within five minutes.

EIP allocation also receives a persisted `client_token`. The platform NAT create callback never retries an error because `CreateNatGateway` exposes no ClientToken; the pending range intent must be reconciled first. Non-platform configurations retain the upstream NAT retry policy.

The platform supplies both CVM values from frozen intent and expiry records, rather than invoking an SDK creation fallback. Unknown results remain blocked even though the token is stable; no attempt relies on an undocumented indefinite idempotency window.

`sh scripts/provider/tencentcloud-idempotency/build.sh` runs unit checks and builds in Docker. Output is `.local/tencentcloud-idempotency/mirror`; the startup seed verifies its exact SHA-256 and publishes a read-only unpacked mirror. Offline module/schema validation uses the same binary.

Primary sources: [upstream CVM implementation](https://github.com/tencentcloudstack/terraform-provider-tencentcloud/blob/e0d222151a29d44795492d68a1076d55ec006cdb/tencentcloud/services/cvm/resource_tc_instance.go), [RunInstances](https://cloud.tencent.com/document/api/213/15730), [ActionTimer fields](https://intl.cloud.tencent.com/document/product/213/15753?has_map=1), [ENI constraints](https://cloud.tencent.com/document/product/576/18720).
