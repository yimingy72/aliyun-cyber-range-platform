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
      action_timer_terminate_at = "2100-01-01T00:00:00Z"
      client_token              = "intent-first"
      instance_name             = "first-host", host_name = "first-host", instance_type = "S5.MEDIUM4", image_id = "img-fixture", subnet_id = "subnet-first"
      system_disk_type          = "CLOUD_PREMIUM", system_disk_size = 50, internet_max_bandwidth_out = 0
      tags                      = { OwnerUserId = "owner-first", PlatformUserId = "owner-first", RangeInstanceId = "first", CloudAccountUid = "100000000001", SingleInstanceBatchId = "batch-fixture", CreationIntentId = "intent-first", CreatedBy = "cyber-range-platform", PlatformScope = "user", PlatformResourceType = "ecs" }
    }
    second = {
      action_timer_terminate_at = "2100-01-01T00:00:00Z"
      client_token              = "intent-second"
      instance_name             = "second-host", host_name = "", instance_type = "S5.MEDIUM4", image_id = "img-fixture", subnet_id = "subnet-second"
      system_disk_type          = "CLOUD_SSD", system_disk_size = 50, internet_max_bandwidth_out = 5
      tags                      = { OwnerUserId = "owner-second", PlatformUserId = "owner-second", RangeInstanceId = "second", CloudAccountUid = "100000000001", SingleInstanceBatchId = "batch-fixture", CreationIntentId = "intent-second", CreatedBy = "cyber-range-platform", PlatformScope = "user", PlatformResourceType = "ecs" }
    }
  }
}

run "persists_absolute_cloud_termination" {
  command = apply
  assert {
    condition     = tencentcloud_instance.members["first"].action_timer_terminate_at == "2100-01-01T00:00:00Z"
    error_message = "First CVM creation must atomically submit its frozen deadline."
  }
}

run "does_not_clear_absolute_cloud_termination_on_refresh" {
  command = plan
  variables {
    members = {
      first = {
        client_token     = "intent-first"
        instance_name    = "first-host", host_name = "first-host", instance_type = "S5.MEDIUM4", image_id = "img-fixture", subnet_id = "subnet-first"
        system_disk_type = "CLOUD_PREMIUM", system_disk_size = 50, internet_max_bandwidth_out = 0
        tags             = { OwnerUserId = "owner-first", PlatformUserId = "owner-first", RangeInstanceId = "first", CloudAccountUid = "100000000001", SingleInstanceBatchId = "batch-fixture", CreationIntentId = "intent-first", CreatedBy = "cyber-range-platform", PlatformScope = "user", PlatformResourceType = "ecs" }
      }
      second = {
        client_token     = "intent-second"
        instance_name    = "second-host", host_name = "", instance_type = "S5.MEDIUM4", image_id = "img-fixture", subnet_id = "subnet-second"
        system_disk_type = "CLOUD_SSD", system_disk_size = 50, internet_max_bandwidth_out = 5
        tags             = { OwnerUserId = "owner-second", PlatformUserId = "owner-second", RangeInstanceId = "second", CloudAccountUid = "100000000001", SingleInstanceBatchId = "batch-fixture", CreationIntentId = "intent-second", CreatedBy = "cyber-range-platform", PlatformScope = "user", PlatformResourceType = "ecs" }
      }
    }
  }
  assert {
    condition     = tencentcloud_instance.members["first"].action_timer_terminate_at == "2100-01-01T00:00:00Z" && tencentcloud_instance.members["second"].action_timer_terminate_at == "2100-01-01T00:00:00Z"
    error_message = "An omitted timer must retain the original scheduled termination."
  }
}
