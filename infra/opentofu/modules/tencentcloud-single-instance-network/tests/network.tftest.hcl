mock_provider "tencentcloud" {}

variables {
  network_profile_id   = "network-fixture"
  creation_intent_id   = "intent-fixture"
  cloud_account_uid    = "100000000001"
  region               = "ap-shanghai"
  zone_id              = "ap-shanghai-2"
  resource_name_prefix = "range-fixture"
}

run "creates_closed_shared_network_without_eip_or_nat" {
  command = plan
  assert {
    condition     = tencentcloud_vpc.shared.cidr_block == "10.0.0.0/16" && tencentcloud_subnet.shared.cidr_block == "10.0.1.0/24" && !tencentcloud_vpc.shared.is_multicast && !tencentcloud_subnet.shared.is_multicast
    error_message = "Use the frozen private network without optional multicast."
  }
  assert {
    condition     = length(tencentcloud_security_group_rule_set.shared.ingress) == 1 && tencentcloud_security_group_rule_set.shared.ingress[0].action == "DROP" && length(output.resource_inventory.eip_ids) == 0 && length(output.resource_inventory.nat_gateway_ids) == 0
    error_message = "Default ingress must be closed and no chargeable public/NAT resource created."
  }
  assert {
    condition     = tencentcloud_vpc.shared.tags["CloudAccountUid"] == "100000000001" && tencentcloud_subnet.shared.tags["CreationIntentId"] == "intent-fixture" && tencentcloud_security_group.shared.tags["SingleInstanceNetworkProfileId"] == "network-fixture"
    error_message = "Every network resource needs its account and creation source."
  }
}

run "explicit_ingress_precedes_default_drop" {
  command = plan
  variables {
    ingress_rules = [{ cidr_block = "192.0.2.0/24", protocol = "TCP", port = "22" }]
  }
  assert {
    condition     = length(tencentcloud_security_group_rule_set.shared.ingress) == 2 && tencentcloud_security_group_rule_set.shared.ingress[0].cidr_block == "192.0.2.0/24" && tencentcloud_security_group_rule_set.shared.ingress[1].action == "DROP"
    error_message = "Only explicitly authorized ingress may precede the default deny."
  }
}

run "rejects_subnet_outside_vpc" {
  command = plan
  variables {
    subnet_cidr = "172.16.1.0/24"
  }
  expect_failures = [tencentcloud_subnet.shared]
}

run "rejects_mixed_region_and_zone" {
  command = plan
  variables {
    zone_id = "ap-guangzhou-2"
  }
  expect_failures = [var.zone_id]
}
