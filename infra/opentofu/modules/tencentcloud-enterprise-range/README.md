# Tencent Cloud enterprise range

This module maps the compiled platform topology to Tencent VPC and assistant CIDRs, one subnet per logical network in the frozen physical zone, CVMs, per-NIC security-group rule sets, ACLs, auxiliary ENIs and IPs, one shared NAT with separate SNAT/DNAT EIPs, explicit translation rules and separate subnet route tables. Only explicitly SNAT-enabled networks receive an internet route.

The renderer validates exact saleable CPU/RAM, exact available system-only images, documented CPU-based ENI/IP quotas, one primary NIC, same-VPC/zone attachment, supported protocols and port syntax, bounded user data and an explicit future termination time. The pinned provider sends a stable `ClientToken` and termination `ActionTimer` in the same creation request. Guest network interface names are not guaranteed by Tencent's attachment API; images or their initialization scripts must configure their additional interfaces and policy routes.

Every resource inventory includes original provider, context, account UID, region, range and source job. CVM and actual CBS system-disk IDs remain available for fee reconciliation. Persisted range identity and state must match before update or destroy. Unknown create outcomes retain their markers and require verified recovery; another apply cannot recreate them.

Tencent NAT defaults permit unmatched sources to use any attached EIP. Subnet route separation preserves disabled egress without guessing an undocumented StrictSnatMode API input. DNAT entry networks must explicitly enable SNAT for return traffic; an entry with SNAT disabled is rejected before creation.

The CVM timer does not destroy NAT gateways or EIPs. Platform expiry jobs must reclaim those resources; a worker outage can therefore leave network charges active. This implementation has been validated with isolated Docker schema and mock tests only, without a Tencent cloud smoke test.
