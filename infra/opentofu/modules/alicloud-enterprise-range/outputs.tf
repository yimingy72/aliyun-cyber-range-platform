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
    public_ip  = local.resolved_entry_eip_key != "" ? alicloud_eip_address.addresses[local.resolved_entry_eip_key].ip_address : null
    private_ip = alicloud_instance.hosts[local.resolved_entry_host_key].private_ip
    ssh        = local.resolved_entry_eip_key != "" ? "ssh root@${alicloud_eip_address.addresses[local.resolved_entry_eip_key].ip_address}" : null
  }
}

output "resource_summary" {
  description = "Lightweight summary of VPC, subnets, hosts, secondary NICs, NAT entries, bootstrap targets, and resolved runtime selections."
  value = {
    vpc_id = alicloud_vpc.range.id
    subnet_ids = {
      for zone_key, zone in alicloud_vswitch.zones : zone_key => zone.id
    }
    network_acl_ids = {
      for zone_key, acl in alicloud_network_acl.zone_acls : zone_key => acl.id
    }
    security_group_ids = {
      for host_key, security_group in alicloud_security_group.hosts : host_key => security_group.id
    }
    host_ids = {
      for host_key, host in alicloud_instance.hosts : host_key => host.id
    }
    secondary_network_interface_ids = {
      for network_interface_key, network_interface in alicloud_network_interface.secondary : network_interface_key => network_interface.id
    }
    nat_gateway_ids = {
      for nat_gateway_key, nat_gateway in alicloud_nat_gateway.gateways : nat_gateway_key => nat_gateway.id
    }
    snat_entry_ids = {
      for snat_entry_key, snat_entry in alicloud_snat_entry.entries : snat_entry_key => snat_entry.id
    }
    dnat_entry_ids = {
      for dnat_entry_key, dnat_entry in alicloud_forward_entry.entries : dnat_entry_key => dnat_entry.id
    }
    eip_allocation_id = local.resolved_entry_eip_key != "" ? alicloud_eip_address.addresses[local.resolved_entry_eip_key].id : null
    eip_allocation_ids = {
      for eip_key, eip in alicloud_eip_address.addresses : eip_key => eip.id
    }
    bootstrap_host_keys = local.bootstrap_host_keys
    runtime_selections = {
      image_policies         = var.runtime_selections.image_policies
      instance_type_policies = var.runtime_selections.instance_type_policies
      attempted_zones        = try(var.runtime_selections.attempted_zones, [])
    }
    selected_zone_id       = var.zone_id
    attempted_zones        = try(var.runtime_selections.attempted_zones, [])
    resolved_instance_type = var.instance_type
    resolved_image_id      = var.image_id
    resolved_image_ids = {
      for host_key, host in alicloud_instance.hosts : host_key => host.image_id
    }
  }
}
