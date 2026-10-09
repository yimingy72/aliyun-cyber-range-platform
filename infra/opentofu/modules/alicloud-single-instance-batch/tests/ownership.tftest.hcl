mock_provider "alicloud" {}

variables {
  security_group_id = "sg-fixture"
  member_passwords  = { first = "FixturePassword123!", second = "OtherFixturePassword123!" }
  members = {
    first = {
      instance_name        = "first-host", host_name = "first-host", instance_type = "ecs.u1-c1m2.large", image_id = "fixture-image", vswitch_id = "vsw-first"
      system_disk_category = "cloud_essd", system_disk_size = 40, internet_max_bandwidth_out = 10, auto_release_time = ""
      tags                 = { PlatformUserId = "owner-first", RangeInstanceId = "first", SingleInstanceBatchId = "fixture-batch", PlatformResourceType = "ecs" }
    }
    second = {
      instance_name        = "second-host", host_name = "second-host", instance_type = "ecs.u1-c1m2.large", image_id = "fixture-image", vswitch_id = "vsw-second"
      system_disk_category = "cloud_essd", system_disk_size = 40, internet_max_bandwidth_out = 10, auto_release_time = ""
      tags                 = { PlatformUserId = "owner-second", RangeInstanceId = "second", SingleInstanceBatchId = "fixture-batch", PlatformResourceType = "ecs" }
    }
  }
}

run "keeps_each_member_identity_and_disk_billing_tags" {
  command = plan
  assert {
    condition     = length(alicloud_instance.members) == 2 && alicloud_instance.members["first"].tags["RangeInstanceId"] == "first" && alicloud_instance.members["second"].tags["RangeInstanceId"] == "second"
    error_message = "Each ECS resource must retain its exact platform member identity."
  }
  assert {
    condition     = alicloud_instance.members["first"].volume_tags["PlatformUserId"] == "owner-first" && alicloud_instance.members["second"].volume_tags["PlatformUserId"] == "owner-second" && alicloud_instance.members["first"].volume_tags["PlatformResourceType"] == "disk"
    error_message = "System disk billing tags must follow the exact member owner and disk type."
  }
  assert {
    condition     = alicloud_instance.members["first"].vswitch_id == "vsw-first" && alicloud_instance.members["second"].vswitch_id == "vsw-second" && alicloud_instance.members["first"].force_delete
    error_message = "Frozen network assignments and explicit single-member deletion must be preserved."
  }
}
