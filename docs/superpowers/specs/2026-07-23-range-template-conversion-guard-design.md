# Range Template Conversion Guard Design

## Goal

Make the topology design the only writable source for template creation. Every
template creation path compiles and validates the topology before persisting
derived deployment artifacts.

## Scope

- Share the topology-to-template converter between the MCP server and API.
- Support one primary VPC CIDR plus explicit secondary VPC CIDRs.
- Require each vSwitch CIDR to be contained by one configured VPC CIDR block.
- Reject caller-supplied derived topology artifacts on template creation.
- Teach the project Skill to produce a `RangeDesign/v1` and invoke the
  conversion-backed MCP tool.

## Data Model

The canonical network declaration is:

```ts
{
  primaryVpcCidr: string;
  secondaryVpcCidrs: string[];
}
```

`topologySpec.vpcCidr` remains the primary CIDR for compatibility. The
secondary CIDRs are stored in `scenarioTemplateSpec.topology` and
`compiledProvisionSpec.topology`, then forwarded to the provisioning plan and
OpenTofu renderer as `secondary_vpc_cidrs`.

The existing enterprise range module already attaches the secondary blocks
before it creates vSwitches. Making them explicit removes the current implicit
dependency on its default `172.16.0.0/16` and `192.168.0.0/16` values.

## Conversion Boundary

`compileTemplateTopology` moves into `@aliyun-cyber-range/scenario-runtime`.
It receives the topology graph and authoring metadata, normalizes defaults,
validates all graph relationships, and produces:

- `topologyGraph`
- `topologySpec`
- `scenarioTemplateSpec`
- `compiledProvisionSpec`
- `compiledSpec`

The API creates templates from a `topologyGraph` and authoring metadata only.
It invokes the shared converter using server-owned identity values. The
controller rejects caller-supplied derived fields so REST, MCP, and the web UI
cannot bypass the conversion boundary.

The MCP `range_template_create` continues to accept only topology metadata and
the graph. It invokes the same converter before calling the API. Its schema
does not expose derived fields.

## Network Semantics

- `primaryVpcCidr` creates the VPC.
- `secondaryVpcCidrs` creates additional VPC IPv4 CIDR blocks.
- A vSwitch must be inside the primary CIDR or any secondary CIDR.
- A range has one shared NAT gateway.
- SNAT and DNAT use distinct EIPs. Each enabled vSwitch receives one SNAT
  entry, and DNAT external ports are unique because the range shares one DNAT
  EIP.

## Skill Contract

The operations Skill directs agents to:

1. Produce or accept a `RangeDesign/v1` with explicit VPC blocks, vSwitches,
   hosts, image selectors, shared NAT, ACLs, security groups, and bootstrap
   configuration.
2. Resolve image selectors through the read-only platform image tool.
3. Call only `range_template_create` for template creation.
4. Never hand-author or pass the four derived artifacts.

## Tests

- Unit test that a graph with `10.0.0.0/24`, `172.16.0.0/24`, and
  `192.168.0.0/24` vSwitches compiles with the matching primary and secondary
  VPC CIDRs.
- Unit test that a vSwitch outside all configured VPC CIDRs is rejected.
- API test that caller-supplied derived fields are rejected during create.
- MCP test that `range_template_create` compiles the graph and cannot receive
  raw derived fields.
- Renderer test that `secondary_vpc_cidrs` reaches the OpenTofu variables.
