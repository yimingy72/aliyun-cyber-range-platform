output "vpc_id" {
  description = "Created Alibaba Cloud VPC ID for the persisted single-instance network."
  value       = alicloud_vpc.default.id
}

output "vpc_cidr" {
  description = "CIDR block assigned to the persisted single-instance network."
  value       = var.vpc_cidr
}

output "vswitch_ids" {
  description = "Created Alibaba Cloud vSwitch IDs for the persisted single-instance network."
  value       = alicloud_vswitch.default[*].id
}

output "vswitch_cidrs" {
  description = "CIDR blocks assigned to the persisted single-instance network vSwitches."
  value       = var.vswitch_cidrs
}

output "security_group_id" {
  description = "Created security group ID shared by persisted single-instance ECS hosts."
  value       = alicloud_security_group.default.id
}

output "security_group_name" {
  description = "Created security group name shared by persisted single-instance ECS hosts."
  value       = alicloud_security_group.default.security_group_name
}
