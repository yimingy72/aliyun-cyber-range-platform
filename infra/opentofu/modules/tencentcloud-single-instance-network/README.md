# Tencent Cloud shared single-instance network (preparatory)

This standalone workspace creates one tagged VPC, one subnet and one security
group using provider **1.83.34**. It owns the complete
`tencentcloud_security_group_rule_set`; other workspaces must not add independent
rules to the same group. Ingress is closed by default. Explicit ingress rules are
followed by a default DROP; egress is allowed. No NAT, EIP, peering or paid network
service is created. Multicast is disabled.

The caller freezes the verified account UIN, region, matching zone, network
profile and persisted creation intent. The subnet must be entirely inside the
VPC. `network_profile` is available only after its security-group rules are
applied. `resource_inventory` reports every created VPC/subnet/security-group ID
plus the VPC's automatic route-table ID for cleanup evidence.

The batch module receives these IDs as shared references. Before deleting this
network, the platform must verify in the original account that it has no active
instance/ENI/job references and that every owned ID belongs to this persisted
creation. No automatic cleanup, adoption of existing networks or retry after an
unknown create result is implemented here. See the batch README for provider
ClientToken and cleanup limits. Production workers do not use this module yet.
