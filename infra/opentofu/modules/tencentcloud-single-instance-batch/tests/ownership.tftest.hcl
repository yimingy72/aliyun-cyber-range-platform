mock_provider "tencentcloud" {
  mock_resource "tencentcloud_instance" {
    defaults = {
      id              = "ins-fixture"
      private_ip      = "10.0.1.10"
      public_ip       = ""
      instance_status = "RUNNING"
      system_disk_id  = "disk-fixture"
    }
  }
}

variables {
  batch_id          = "batch-fixture"
  cloud_account_uid = "100000000001"
  region            = "ap-shanghai"
  zone_id           = "ap-shanghai-2"
  vpc_id            = "vpc-fixture"
  security_group_id = "sg-fixture"
  member_passwords  = { first = "FixturePassword123!", second = "OtherFixturePassword123!" }
  members = {
    first = {
      instance_name    = "first-host", host_name = "first-host", instance_type = "S5.MEDIUM4", image_id = "img-fixture", subnet_id = "subnet-first"
      system_disk_type = "CLOUD_PREMIUM", system_disk_size = 50, internet_max_bandwidth_out = 0
      tags             = { OwnerUserId = "owner-first", PlatformUserId = "owner-first", RangeInstanceId = "first", CloudAccountUid = "100000000001", SingleInstanceBatchId = "batch-fixture", CreationIntentId = "intent-first", CreatedBy = "cyber-range-platform", PlatformScope = "single-instance", PlatformResourceType = "cvm" }
    }
    second = {
      instance_name    = "second-host", host_name = "", instance_type = "S5.MEDIUM4", image_id = "img-fixture", subnet_id = "subnet-second"
      system_disk_type = "CLOUD_SSD", system_disk_size = 50, internet_max_bandwidth_out = 5
      tags             = { OwnerUserId = "owner-second", PlatformUserId = "owner-second", RangeInstanceId = "second", CloudAccountUid = "100000000001", SingleInstanceBatchId = "batch-fixture", CreationIntentId = "intent-second", CreatedBy = "cyber-range-platform", PlatformScope = "single-instance", PlatformResourceType = "cvm" }
    }
  }
}

run "plans_exact_member_identity_and_pay_as_you_go" {
  command = plan
  assert {
    condition     = length(tencentcloud_instance.members) == 2 && tencentcloud_instance.members["first"].tags["OwnerUserId"] == "owner-first" && tencentcloud_instance.members["second"].tags["OwnerUserId"] == "owner-second"
    error_message = "Members must keep individual identity and owner."
  }
  assert {
    condition     = tencentcloud_instance.members["first"].instance_charge_type == "POSTPAID_BY_HOUR" && tencentcloud_instance.members["second"].internet_charge_type == "TRAFFIC_POSTPAID_BY_HOUR"
    error_message = "Instances and public traffic must use pay-as-you-go."
  }
  assert {
    condition     = !tencentcloud_instance.members["first"].allocate_public_ip && tencentcloud_instance.members["second"].allocate_public_ip
    error_message = "Public IP allocation must be explicit."
  }
  assert {
    condition     = tencentcloud_instance.members["first"].subnet_id == "subnet-first" && tencentcloud_instance.members["second"].subnet_id == "subnet-second"
    error_message = "Frozen member networks must not be mixed."
  }
}

run "exports_complete_owned_and_referenced_inventory" {
  command = apply
  assert {
    condition     = output.members["first"].system_disk_id == "disk-fixture" && output.members["second"].owner_user_id == "owner-second" && output.members["first"].creation_intent_id == "intent-first"
    error_message = "Inventory must include system disks and original source identity."
  }
  assert {
    condition     = length(output.resource_inventory.host_ids) == 2 && length(output.resource_inventory.system_disk_ids) == 2 && length(output.resource_inventory.data_disk_ids) == 0 && length(output.resource_inventory.owned_network.vpc_ids) == 0 && output.resource_inventory.referenced_network.vpc_id == "vpc-fixture"
    error_message = "Shared networks must never be mistaken for batch-owned resources."
  }
}

run "rejects_cross_account_identity" {
  command = plan
  variables {
    cloud_account_uid = "100000000002"
  }
  expect_failures = [var.members]
}

run "rejects_missing_member_password" {
  command = plan
  variables {
    member_passwords = { first = "FixturePassword123!" }
  }
  expect_failures = [var.member_passwords]
}

run "keeps_fifty_members_and_intents_distinct" {
  command = plan
  variables {
    member_passwords = { for index in range(50) : "member-${index}" => "FixturePassword123!" }
    members = {
      for index in range(50) : "member-${index}" => {
        instance_name    = "host-${index}", host_name = "", instance_type = "S5.MEDIUM4", image_id = "img-fixture", subnet_id = "subnet-fixture"
        system_disk_type = "CLOUD_PREMIUM", system_disk_size = 50, internet_max_bandwidth_out = 0
        tags             = { OwnerUserId = "owner-${index % 2}", PlatformUserId = "owner-${index % 2}", RangeInstanceId = "member-${index}", CloudAccountUid = "100000000001", SingleInstanceBatchId = "batch-fixture", CreationIntentId = "intent-${index}", CreatedBy = "cyber-range-platform", PlatformScope = "single-instance", PlatformResourceType = "cvm" }
      }
    }
  }
  assert {
    condition     = length(tencentcloud_instance.members) == 50 && tencentcloud_instance.members["member-49"].tags["CreationIntentId"] == "intent-49" && tencentcloud_instance.members["member-48"].tags["OwnerUserId"] == "owner-0"
    error_message = "Fifty members must not share resource identity or creation intents."
  }
}

run "empty_destroy_configuration_preserves_only_network_references" {
  command = plan
  variables {
    members          = {}
    member_passwords = {}
  }
  assert {
    condition     = length(tencentcloud_instance.members) == 0 && length(output.resource_inventory.host_ids) == 0 && length(output.resource_inventory.owned_network.vpc_ids) == 0
    error_message = "An empty batch must not take ownership of shared network resources."
  }
}
