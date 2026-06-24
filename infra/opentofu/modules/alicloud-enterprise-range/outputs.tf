output "vpc_id" {
  description = "Created Alibaba Cloud VPC ID for the team enterprise range."
  value       = alicloud_vpc.range.id
}

output "subnet_ids" {
  description = "Created subnet IDs grouped by network zone."
  value = {
    dmz    = alicloud_vswitch.dmz.id
    office = alicloud_vswitch.office.id
    server = alicloud_vswitch.server.id
  }
}

output "host_ids" {
  description = "Created ECS instance IDs grouped by network zone."
  value = {
    dmz    = alicloud_instance.dmz.id
    office = alicloud_instance.office.id
    server = alicloud_instance.server.id
  }
}

output "public_entry" {
  description = "Primary team entrypoint exposed through the DMZ ECS instance."
  value = {
    host_role  = "dmz"
    public_ip  = alicloud_eip_address.dmz.ip_address
    private_ip = alicloud_instance.dmz.private_ip
    ssh        = "ssh root@${alicloud_eip_address.dmz.ip_address}"
  }
}

output "resource_summary" {
  description = "Lightweight summary of VPC, subnets, hosts, and EIP resources."
  value = {
    vpc_id = alicloud_vpc.range.id
    subnet_ids = {
      dmz    = alicloud_vswitch.dmz.id
      office = alicloud_vswitch.office.id
      server = alicloud_vswitch.server.id
    }
    host_ids = {
      dmz    = alicloud_instance.dmz.id
      office = alicloud_instance.office.id
      server = alicloud_instance.server.id
    }
    eip_allocation_id = alicloud_eip_address.dmz.id
  }
}
