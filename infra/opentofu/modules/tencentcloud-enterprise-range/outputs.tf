output "public_entry" {
  value = {
    host_role  = var.entry_host_key
    public_ip  = tencentcloud_eip.range[local.entry_eip_key].public_ip
    private_ip = tencentcloud_instance.hosts[var.entry_host_key].private_ip
    ssh        = "ssh root@${tencentcloud_eip.range[local.entry_eip_key].public_ip}"
  }
}
output "resource_summary" {
  value = {
    vpc_id                          = tencentcloud_vpc.range.id
    route_table_ids                 = { for key, routes in tencentcloud_route_table.zones : key => routes.id }
    subnet_ids                      = { for key, subnet in tencentcloud_subnet.zones : key => subnet.id }
    security_group_ids              = { for key, group in tencentcloud_security_group.nics : key => group.id }
    network_acl_ids                 = { for key, acl in tencentcloud_vpc_acl.zones : key => acl.id }
    host_ids                        = { for key, host in tencentcloud_instance.hosts : key => host.id }
    system_disk_ids                 = { for key, host in tencentcloud_instance.hosts : key => host.system_disk_id }
    secondary_network_interface_ids = { for key, eni in tencentcloud_eni.secondary : key => eni.id }
    nat_gateway_ids                 = { for key, nat in tencentcloud_nat_gateway.shared : key => nat.id }
    snat_entry_ids                  = { for key, snat in tencentcloud_nat_gateway_snat.zones : key => snat.id }
    dnat_entry_ids                  = { for key, dnat in tencentcloud_dnat.entry : key => dnat.id }
    eip_allocation_ids              = { for key, eip in tencentcloud_eip.range : key => eip.id }
    selected_zone_id                = var.zone_id
    resolved_image_ids              = { for key, host in local.hosts : key => host.image_id }
  }
  depends_on = [tencentcloud_eni_attachment.secondary, tencentcloud_eni_ipv4_address.primary, tencentcloud_vpc_acl_attachment.zones, tencentcloud_route_table_entry.internet, tencentcloud_route_table_association.zones]
}
