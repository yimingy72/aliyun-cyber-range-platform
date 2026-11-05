# alicloud-single-instance-network

Creates the persisted default network used by single-instance ECS jobs:

- 1 VPC
- 3 vSwitches in the configured zone
- 1 shared security group allowing all inbound protocols and ports
- 1 open-all ingress rule on that security group
