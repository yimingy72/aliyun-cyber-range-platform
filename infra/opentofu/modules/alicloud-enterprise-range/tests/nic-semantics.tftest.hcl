mock_provider "alicloud" {}

override_resource {
  target = alicloud_security_group.hosts
  values = { id = "sg-primary" }
}

override_resource {
  target = alicloud_security_group.network_interfaces
  values = { id = "sg-secondary" }
}

variables {
  resource_name_prefix = "nic-test"
  zone_id              = "cn-hangzhou-h"
  vpc_cidr             = "10.0.0.0/16"
  dmz_cidr             = "10.0.1.0/24"
  office_cidr          = "10.0.2.0/24"
  server_cidr          = "10.0.3.0/24"
  dmz_private_ip       = "10.0.1.10"
  office_private_ip    = "10.0.2.20"
  server_private_ip    = "10.0.3.10"
  instance_type        = "ecs.e-c1m2.large"
  image_id             = "m-test"
  instance_password    = "Mock-test-only-123!"
  entry_host_key       = "entry"
  network_zones = [
    { key = "dmz", name = "DMZ", cidr = "10.0.1.0/24", purpose = "dmz", is_public_entry = true },
    { key = "private", name = "Private", cidr = "10.0.2.0/24", purpose = "internal", is_public_entry = false }
  ]
  hosts = [
    { key = "entry", name = "Entry", host_name = "entry-host", zone_key = "dmz", private_ip = "10.0.1.10", role = "entry", expose_public = true },
    { key = "internal", name = "Internal", host_name = "internal-host", zone_key = "private", private_ip = "10.0.2.20", role = "internal", expose_public = false }
  ]
  host_network_interfaces = [{
    host_key = "entry"
    interfaces = [
      { nic_id = "primary", device_index = 0, zone_key = "dmz", private_ip = "10.0.1.10", secondary_private_ips = ["10.0.1.11"] },
      { nic_id = "secondary", device_index = 1, zone_key = "private", private_ip = "10.0.2.10", secondary_private_ips = ["10.0.2.11"] }
    ]
  }]
  security_group_rules = [
    { key = "http-primary", name = "HTTP", target_host_key = "entry", target_device_index = 0, direction = "ingress", policy = "accept", protocol = "tcp", port_range = "80/80", source_cidr = "0.0.0.0/0", priority = 1 },
    { key = "ssh-secondary", name = "Private SSH", target_host_key = "entry", target_device_index = 1, direction = "ingress", policy = "accept", protocol = "tcp", port_range = "22/22", source_cidr = "10.0.2.0/24", priority = 1 }
  ]
  nat_gateways = [{ key = "nat", name = "NAT", zone_key = "dmz", snat_enabled = true }]
  eips         = [{ key = "dnat", name = "DNAT", bind_target_type = "nat_gateway", bind_target_key = "nat", bandwidth_mbps = 30 }]
  dnat_entries = [
    { key = "dnat-entry-tcp-80", name = "TCP80", nat_gateway_key = "nat", eip_key = "dnat", backend_host_key = "entry", external_port = 80, internal_port = 80, protocol = "tcp" },
    { key = "dnat-entry-udp-80", name = "UDP80", nat_gateway_key = "nat", eip_key = "dnat", backend_host_key = "entry", external_port = 80, internal_port = 80, protocol = "udp" }
  ]
}

run "scoped_nics" {
  command = apply
  assert {
    condition     = alicloud_instance.hosts["entry"].host_name == "entry-host"
    error_message = "The ECS hostname must be preserved."
  }
  assert {
    condition     = alicloud_instance.hosts["entry"].secondary_private_ips == toset(["10.0.1.11"])
    error_message = "Primary NIC auxiliary IPs must be allocated."
  }
  assert {
    condition     = alicloud_network_interface.secondary["entry-1"].private_ip_addresses == toset(["10.0.2.11"])
    error_message = "Secondary NIC auxiliary IPs must be allocated."
  }
  assert {
    condition     = alicloud_security_group_rule.compiled_rules["http-primary"].security_group_id == alicloud_security_group.hosts["entry"].id && alicloud_security_group_rule.compiled_rules["ssh-secondary"].security_group_id == alicloud_security_group.network_interfaces["entry-1"].id && alicloud_security_group.hosts["entry"].id != alicloud_security_group.network_interfaces["entry-1"].id
    error_message = "NIC rules must target separate security groups."
  }
  assert {
    condition     = alicloud_network_interface.secondary["entry-1"].security_group_ids == toset([alicloud_security_group.network_interfaces["entry-1"].id])
    error_message = "The ENI must bind its own security group."
  }
  assert {
    condition     = length(alicloud_forward_entry.entries) == 2
    error_message = "TCP and UDP may share an external port."
  }
}

run "legacy_host_groups" {
  command = apply
  variables {
    host_network_interfaces = [{
      host_key   = "entry"
      interfaces = [{ device_index = 1, zone_key = "private", private_ip = "10.0.2.10" }]
    }]
    security_group_rules = [{
      key = "legacy-ssh", name = "Legacy SSH", target_host_key = "entry", direction = "ingress", policy = "accept", protocol = "tcp", port_range = "22/22", source_cidr = "0.0.0.0/0", priority = 1
    }]
  }
  assert {
    condition     = length(alicloud_security_group.network_interfaces) == 0 && alicloud_network_interface.secondary["entry-1"].security_group_ids == toset([alicloud_security_group.hosts["entry"].id])
    error_message = "Legacy NICs must retain the host security group."
  }
  assert {
    condition     = !contains(keys(local.primary_secondary_ips_by_host), "entry") && local.secondary_network_interface_map["entry-1"].nic_id == null
    error_message = "Legacy snapshots must not clear unmanaged auxiliary IPs."
  }
}
