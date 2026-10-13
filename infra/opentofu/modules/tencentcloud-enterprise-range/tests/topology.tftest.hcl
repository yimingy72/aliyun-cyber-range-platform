mock_provider "tencentcloud" {
  mock_resource "tencentcloud_vpc" { defaults = { id = "vpc-fixture", default_route_table_id = "rtb-fixture" } }
  mock_resource "tencentcloud_instance" { defaults = { id = "ins-fixture", system_disk_id = "disk-fixture", instance_status = "RUNNING" } }
  mock_resource "tencentcloud_eip" { defaults = { id = "eip-fixture", public_ip = "203.0.113.10" } }
  mock_resource "tencentcloud_nat_gateway" { defaults = { id = "nat-fixture", subnet_id = "", zone = "ap-shanghai-3", stock_public_ip_addresses_bandwidth_out = 30 } }
  mock_data "tencentcloud_enis" { defaults = { enis = [{ id = "eni-primary", primary = true, cdc_id = "", create_time = "", description = "", instance_id = "ins-fixture", ipv4s = [], ipv6s = [], mac = "", name = "primary", security_groups = [], state = "AVAILABLE", subnet_id = "subnet-fixture", tags = {}, vpc_id = "vpc-fixture" }] } }
}
variables {
  resource_name_prefix = "tencent-test"
  range_instance_id    = "range-fixture"
  region               = "ap-shanghai"
  zone_id              = "ap-shanghai-2"
  vpc_cidr             = "10.0.0.0/16"
  secondary_vpc_cidrs  = ["172.16.0.0/16", "192.168.0.0/16"]
  entry_host_key       = "entry"
  network_zones        = [{ key = "dmz", name = "DMZ", cidr = "10.0.1.0/24" }, { key = "internal", name = "Internal", cidr = "172.16.1.0/24" }]
  hosts                = [{ key = "entry", name = "Entry", host_name = "entry", image_id = "img-fixture", instance_type = "S5.MEDIUM4", private_ip = "10.0.1.10", zone_key = "dmz", system_disk_type = "CLOUD_PREMIUM", system_disk_size = 40, terminate_at = "2100-01-01T00:00:00Z", creation_intent_id = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", user_data = "" }]
  network_interfaces   = [{ key = "entry-0", host_key = "entry", device_index = 0, zone_key = "dmz", private_ip = "10.0.1.10", secondary_ips = ["10.0.1.11"] }, { key = "entry-1", host_key = "entry", device_index = 1, zone_key = "internal", private_ip = "172.16.1.10", secondary_ips = ["172.16.1.11"] }]
  host_passwords       = { entry = "FixturePassword123!" }
  security_group_rules = [{ key = "http", host_key = "entry", device_index = 0, direction = "ingress", action = "ACCEPT", protocol = "TCP", port = "80", cidr_block = "0.0.0.0/0", priority = 1, description = "HTTP" }, { key = "egress", host_key = "entry", device_index = null, direction = "egress", action = "ACCEPT", protocol = "ALL", port = "all", cidr_block = "0.0.0.0/0", priority = 100, description = "Egress" }]
  acls                 = [{ key = "in", zone_key = "dmz", direction = "inbound", action = "ACCEPT", protocol = "TCP", port = "80", cidr_block = "0.0.0.0/0", priority = 1, description = "HTTP" }]
  nat_gateways         = [{ key = "shared", name = "NAT", zone_key = "dmz", creation_intent_id = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }]
  eips                 = [{ key = "snat", name = "SNAT", nat_key = "shared", bandwidth = 10, creation_intent_id = "cccccccccccccccccccccccccccccccc" }, { key = "dnat", name = "DNAT", nat_key = "shared", bandwidth = 10, creation_intent_id = "dddddddddddddddddddddddddddddddd" }]
  snat_entries         = [{ key = "dmz", nat_key = "shared", zone_key = "dmz", eip_key = "snat" }]
  dnat_entries         = [{ key = "http", nat_key = "shared", eip_key = "dnat", host_key = "entry", external_port = 80, internal_port = 80, protocol = "TCP" }]
  tags                 = { CloudProvider = "tencent_cloud", CloudAccountContextId = "ctx-fixture", CloudAccountUid = "100000000001", RangeInstanceId = "range-fixture", PlatformCreateJobId = "job-fixture", CreatedBy = "cyber-range-platform", PlatformScope = "user", PlatformUserId = "owner-fixture" }
}
run "preserves_network_and_nic_policy_semantics" {
  command = plan
  assert {
    condition     = tencentcloud_instance.hosts["entry"].client_token == "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" && tencentcloud_instance.hosts["entry"].action_timer_terminate_at == "2100-01-01T00:00:00Z" && !tencentcloud_instance.hosts["entry"].allocate_public_ip
    error_message = "CVMs require persistent intent and atomic expiry without direct public IP."
  }
  assert {
    condition     = length(tencentcloud_security_group.nics) == 2 && length(tencentcloud_eni.secondary) == 1 && length(tencentcloud_eni.secondary["entry-1"].ipv4s) == 2 && length(tencentcloud_vpc.range.assistant_cidrs) == 2
    error_message = "Multi-network NIC addresses and distinct security groups must be retained."
  }
  assert {
    condition     = length(tencentcloud_route_table.zones) == 2 && length(tencentcloud_route_table_entry.internet) == 1 && !contains(keys(tencentcloud_route_table_entry.internet), "internal")
    error_message = "SNAT-disabled networks must not inherit Tencent default internet egress."
  }
  assert {
    condition     = tencentcloud_nat_gateway_snat.zones["dmz"].resource_type == "SUBNET" && tencentcloud_dnat.entry["http"].protocol == "TCP" && length(tencentcloud_vpc_acl.zones["dmz"].ingress) == 1
    error_message = "SNAT, DNAT and ACL policies must be explicit."
  }
}
run "keeps_atomic_nat_and_eip_recovery_identity" {
  command = plan
  assert {
    condition     = tencentcloud_nat_gateway.shared["shared"].tags["CreationIntentId"] == "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" && tencentcloud_nat_gateway.shared["shared"].tags["PlatformResourceType"] == "nat_gateway" && tencentcloud_nat_gateway.shared["shared"].tags["PlatformCreateJobId"] == "job-fixture"
    error_message = "NAT creation must atomically receive its exact recovery nonce and original source job."
  }
  assert {
    condition     = tencentcloud_eip.range["snat"].client_token != tencentcloud_eip.range["dnat"].client_token && tencentcloud_eip.range["snat"].tags["CreationIntentId"] == tencentcloud_eip.range["snat"].client_token
    error_message = "Each EIP must have a distinct persisted allocation intent and matching atomic tags."
  }
}

run "preserves_numeric_service_port_protocol_contract" {
  command = plan
  variables {
    security_group_rules = [{ key = "health", host_key = "entry", device_index = 0, direction = "ingress", action = "ACCEPT", protocol = "TCP", port = "8080", cidr_block = "0.0.0.0/0", priority = 1, description = "HEALTH" }]
    acls                 = [{ key = "health", zone_key = "dmz", direction = "inbound", action = "ACCEPT", protocol = "TCP", port = "8080", cidr_block = "0.0.0.0/0", priority = 1, description = "HEALTH" }]
  }
  assert {
    condition     = tencentcloud_security_group_rule_set.nics["entry-0"].ingress[0].protocol == "TCP" && tencentcloud_security_group_rule_set.nics["entry-0"].ingress[0].port == "8080" && tencentcloud_vpc_acl.zones["dmz"].ingress[0] == "ACCEPT#0.0.0.0/0#8080#TCP#HEALTH"
    error_message = "Single service ports must remain canonical numeric strings with TCP before provider serialization."
  }
}

run "scopes_reused_acl_keys_to_zone_and_direction" {
  command = plan
  variables {
    acls = [
      { key = "allow-main", zone_key = "dmz", direction = "inbound", action = "ACCEPT", protocol = "ALL", port = "ALL", cidr_block = "10.0.0.0/16", priority = 10, description = "DMZ MAIN" },
      { key = "allow-main", zone_key = "internal", direction = "inbound", action = "ACCEPT", protocol = "ALL", port = "ALL", cidr_block = "172.16.0.0/16", priority = 10, description = "INTERNAL MAIN" },
      { key = "allow-assist", zone_key = "dmz", direction = "inbound", action = "ACCEPT", protocol = "ALL", port = "ALL", cidr_block = "172.16.0.0/16", priority = 20, description = "DMZ ASSIST" },
      { key = "allow-assist", zone_key = "internal", direction = "inbound", action = "ACCEPT", protocol = "ALL", port = "ALL", cidr_block = "10.0.0.0/16", priority = 20, description = "INTERNAL ASSIST" },
      { key = "allow-egress", zone_key = "dmz", direction = "outbound", action = "ACCEPT", protocol = "ALL", port = "ALL", cidr_block = "0.0.0.0/0", priority = 100, description = "DMZ OUT" },
      { key = "allow-egress", zone_key = "internal", direction = "outbound", action = "ACCEPT", protocol = "ALL", port = "ALL", cidr_block = "0.0.0.0/0", priority = 100, description = "INTERNAL OUT" },
      { key = "allow-egress", zone_key = "dmz", direction = "inbound", action = "ACCEPT", protocol = "ALL", port = "ALL", cidr_block = "192.168.0.0/16", priority = 100, description = "DMZ IN" },
    ]
  }
  assert {
    condition     = tencentcloud_vpc_acl.zones["dmz"].ingress == tolist(["ACCEPT#10.0.0.0/16#ALL#ALL#DMZ MAIN", "ACCEPT#172.16.0.0/16#ALL#ALL#DMZ ASSIST", "ACCEPT#192.168.0.0/16#ALL#ALL#DMZ IN"]) && tencentcloud_vpc_acl.zones["dmz"].egress == tolist(["ACCEPT#0.0.0.0/0#ALL#ALL#DMZ OUT"])
    error_message = "ACL selection must retain only the requested zone and direction despite repeated keys and priorities."
  }
  assert {
    condition     = tencentcloud_vpc_acl.zones["internal"].ingress == tolist(["ACCEPT#172.16.0.0/16#ALL#ALL#INTERNAL MAIN", "ACCEPT#10.0.0.0/16#ALL#ALL#INTERNAL ASSIST"]) && tencentcloud_vpc_acl.zones["internal"].egress == tolist(["ACCEPT#0.0.0.0/0#ALL#ALL#INTERNAL OUT"])
    error_message = "A neighbouring subnet's identically keyed ACL must not appear in this ACL."
  }
}

run "exports_disks_and_complete_resource_inventory" {
  command = apply
  assert {
    condition     = output.resource_summary.system_disk_ids["entry"] == "disk-fixture" && output.public_entry.public_ip == "203.0.113.10" && length(output.resource_summary.security_group_ids) == 2
    error_message = "Inventory must retain actual disk IDs and every NIC policy resource."
  }
}
run "updates_security_policy_without_changing_private_cvm_identity" {
  command = plan
  variables {
    security_group_rules = [{ key = "deny-http", host_key = "entry", device_index = 0, direction = "ingress", action = "DROP", protocol = "TCP", port = "80", cidr_block = "10.0.0.0/16", priority = 1, description = "Deny HTTP" }]
  }
  assert {
    condition     = tencentcloud_instance.hosts["entry"].id == "ins-fixture" && tencentcloud_instance.hosts["entry"].system_disk_id == "disk-fixture" && !tencentcloud_instance.hosts["entry"].allocate_public_ip && tencentcloud_instance.hosts["entry"].internet_max_bandwidth_out == 0
    error_message = "A network policy edit must preserve the private CVM, its system disk and lack of direct public bandwidth."
  }
  assert {
    condition     = tencentcloud_security_group_rule_set.nics["entry-0"].ingress[0].action == "DROP" && tencentcloud_security_group_rule_set.nics["entry-0"].ingress[0].port == "80"
    error_message = "Preserving private CVM billing metadata must not suppress the requested security policy update."
  }
}
run "keeps_regional_nat_after_dnat_port_only_update" {
  command = plan
  variables {
    dnat_entries = [{ key = "http", nat_key = "shared", eip_key = "dnat", host_key = "entry", external_port = 18081, internal_port = 80, protocol = "TCP" }]
    tags         = { CloudProvider = "tencent_cloud", CloudAccountContextId = "ctx-fixture", CloudAccountUid = "100000000001", RangeInstanceId = "range-fixture", PlatformCreateJobId = "job-update", CreatedBy = "cyber-range-platform", PlatformScope = "user", PlatformUserId = "owner-fixture" }
  }
  assert {
    condition     = tencentcloud_nat_gateway.shared["shared"].id == "nat-fixture" && tencentcloud_nat_gateway.shared["shared"].subnet_id == "" && tencentcloud_nat_gateway.shared["shared"].zone == "ap-shanghai-3" && tencentcloud_nat_gateway.shared["shared"].stock_public_ip_addresses_bandwidth_out == 30
    error_message = "A port-only update must keep the original standard NAT and its real computed regional placement."
  }
  assert {
    condition     = tencentcloud_instance.hosts["entry"].id == "ins-fixture" && tencentcloud_instance.hosts["entry"].availability_zone == "ap-shanghai-2" && tencentcloud_dnat.entry["http"].elastic_port == "18081" && tencentcloud_nat_gateway.shared["shared"].tags["CreationIntentId"] == "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    error_message = "Only the entry port and mutable job tags may change; frozen CVM zone and NAT recovery intent must stay."
  }
}
run "rejects_cross_region_zone" {
  command = plan
  variables { zone_id = "ap-guangzhou-2" }
  expect_failures = [var.zone_id]
}

run "multiple_targets_and_secondary_nic_mapping" {
  command = plan
  variables {
    hosts = [
      { key = "entry", name = "Entry", host_name = "entry", image_id = "img-fixture", instance_type = "S5.MEDIUM4", private_ip = "10.0.1.10", zone_key = "dmz", system_disk_type = "CLOUD_PREMIUM", system_disk_size = 50, terminate_at = "2100-01-01T00:00:00Z", creation_intent_id = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", user_data = "" },
      { key = "other", name = "Other", host_name = "other", image_id = "img-fixture", instance_type = "S5.MEDIUM4", private_ip = "172.16.1.20", zone_key = "internal", system_disk_type = "CLOUD_PREMIUM", system_disk_size = 80, terminate_at = "2100-01-01T00:00:00Z", creation_intent_id = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", user_data = "" }
    ]
    host_passwords = { entry = "FixturePassword123!", other = "FixturePassword123!" }
    network_interfaces = [
      { key = "entry-0", host_key = "entry", device_index = 0, zone_key = "dmz", private_ip = "10.0.1.10", secondary_ips = [] },
      { key = "entry-1", host_key = "entry", device_index = 1, zone_key = "internal", private_ip = "172.16.1.10", secondary_ips = [] },
      { key = "other-0", host_key = "other", device_index = 0, zone_key = "internal", private_ip = "172.16.1.20", secondary_ips = [] }
    ]
    dnat_entries = [
      { key = "http", nat_key = "shared", eip_key = "dnat", host_key = "entry", private_ip = "172.16.1.10", external_port = 80, internal_port = 80, protocol = "TCP" },
      { key = "other-http", nat_key = "shared", eip_key = "dnat", host_key = "other", private_ip = "172.16.1.20", external_port = 8080, internal_port = 80, protocol = "TCP" }
    ]
  }
  assert {
    condition     = tencentcloud_dnat.entry["http"].private_ip == "172.16.1.10" && tencentcloud_dnat.entry["other-http"].private_ip == "172.16.1.20" && length(tencentcloud_eip.range) == 2
    error_message = "Shared DNAT must preserve selected NIC addresses with separate SNAT EIP."
  }
  assert {
    condition     = tencentcloud_instance.hosts["entry"].system_disk_size == 50 && tencentcloud_instance.hosts["other"].system_disk_size == 80
    error_message = "Host system disk sizes must remain independent."
  }
}

run "pure_private_without_nat_or_eips" {
  command = plan
  variables {
    nat_gateways = []
    eips         = []
    snat_entries = []
    dnat_entries = []
  }
  assert {
    condition     = length(tencentcloud_nat_gateway.shared) == 0 && length(tencentcloud_eip.range) == 0 && length(tencentcloud_dnat.entry) == 0 && output.public_entry.public_ip == null && output.public_entry.ssh == null
    error_message = "Private topology must not allocate NAT or EIP and must report a null public entry."
  }
}

run "rejects_unowned_dnat_address" {
  command = plan
  variables {
    dnat_entries = [{ key = "http", nat_key = "shared", eip_key = "dnat", host_key = "entry", private_ip = "172.16.1.99", external_port = 80, internal_port = 80, protocol = "TCP" }]
  }
  expect_failures = [check.dnat_owned_nic_targets]
}

run "does_not_extend_existing_cvm_deadline" {
  command = plan
  variables {
    hosts = [{ key = "entry", name = "Entry", host_name = "entry", image_id = "img-fixture", instance_type = "S5.MEDIUM4", private_ip = "10.0.1.10", zone_key = "dmz", system_disk_type = "CLOUD_PREMIUM", system_disk_size = 40, terminate_at = "2100-01-02T00:00:00Z", creation_intent_id = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", user_data = "" }]
  }
  assert {
    condition     = tencentcloud_instance.hosts["entry"].action_timer_terminate_at == "2100-01-01T00:00:00Z"
    error_message = "Changing rendered metadata must not extend an existing CVM timer."
  }
}
