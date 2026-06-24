output "vpc_id" {
  description = "Created Alibaba Cloud VPC ID for the team range."
  value       = alicloud_vpc.range.id
}

output "vswitch_id" {
  description = "Created Alibaba Cloud vSwitch ID for the team range."
  value       = alicloud_vswitch.range.id
}

output "security_group_id" {
  description = "Created security group ID used by the first practice host."
  value       = alicloud_security_group.range.id
}

output "instance_id" {
  description = "Created ECS instance ID for the bootstrap host."
  value       = alicloud_instance.range.id
}

output "private_ip" {
  description = "Private IP address assigned to the bootstrap ECS host."
  value       = alicloud_instance.range.private_ip
}

output "public_ip" {
  description = "Public IP address assigned to the bootstrap ECS host when bandwidth is enabled."
  value       = alicloud_instance.range.public_ip
}

output "access_entry" {
  description = "Suggested operator entrypoint for the first single-host range."
  value = {
    private_ip = alicloud_instance.range.private_ip
    public_ip  = alicloud_instance.range.public_ip
    ssh        = "ssh root@${alicloud_instance.range.public_ip}"
  }
}
