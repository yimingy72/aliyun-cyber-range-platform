output "vpc_id" {
  description = "Created Alibaba Cloud VPC ID for the team enterprise range."
  value       = alicloud_vpc.range.id
}

output "subnet_ids" {
  description = "Created subnet IDs grouped by network zone key."
  value = {
    for zone_key, zone in alicloud_vswitch.zones : zone_key => zone.id
  }
}

output "host_ids" {
  description = "Created ECS instance IDs grouped by template host key."
  value = {
    for host_key, host in alicloud_instance.hosts : host_key => host.id
  }
}

output "public_entry" {
  description = "Primary team entrypoint exposed through the configured public host."
  value = {
    host_role  = local.entry_host.role
    public_ip  = alicloud_eip_address.addresses[local.resolved_entry_eip_key].ip_address
    private_ip = alicloud_instance.hosts[local.resolved_entry_host_key].private_ip
    ssh        = "ssh root@${alicloud_eip_address.addresses[local.resolved_entry_eip_key].ip_address}"
  }
}

output "resource_summary" {
  description = "Lightweight summary of VPC, subnets, hosts, nat gateways, and EIP resources."
  value = {
    vpc_id = alicloud_vpc.range.id
    subnet_ids = {
      for zone_key, zone in alicloud_vswitch.zones : zone_key => zone.id
    }
    host_ids = {
      for host_key, host in alicloud_instance.hosts : host_key => host.id
    }
    nat_gateway_ids = {
      for nat_gateway_key, nat_gateway in alicloud_nat_gateway.gateways : nat_gateway_key => nat_gateway.id
    }
    eip_allocation_id = alicloud_eip_address.addresses[local.resolved_entry_eip_key].id
    eip_allocation_ids = {
      for eip_key, eip in alicloud_eip_address.addresses : eip_key => eip.id
    }
  }
}
