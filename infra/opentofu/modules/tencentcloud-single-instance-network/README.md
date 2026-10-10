# Tencent shared single-instance network

The provider-aware network bootstrap creates one tagged VPC, one subnet and one security group in a separate context/provider/UID/region/zone-bound workspace. No NAT, EIP, peering or paid networking is created. The bootstrap owns the complete security-group rule set; member workspaces only reference its IDs.

The reusable module defaults to closed ingress. Platform instance intake explicitly requests its existing open training-host policy. Tags retain the provider, context, account, profile key and creation intent. Unknown create results preserve the pending profile and apply marker and block any second apply.

Deletion requires the registered validation run, exact account identity, no active platform instances/jobs, a cloud check for attached instances/ENIs, exact persisted module ownership, empty post-destroy state and independent cloud absence of all retained VPC/subnet/security-group IDs. Legacy networks cannot be adopted or deleted.

Validate with `sh scripts/provider/tencentcloud-idempotency/build.sh` followed by `sh scripts/dev/validate-tencentcloud-opentofu.sh`. The isolated mock validation does not contact Tencent or prove live cloud cleanup.
