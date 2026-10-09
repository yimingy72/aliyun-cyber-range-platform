mock_provider "alicloud" {}

run "keeps_launch_host_identity_on_ecs" {
  command = plan

  variables {
    resource_name_prefix       = "upgrade-test"
    host_key                   = "practice-host"
    zone_id                    = "cn-hangzhou-h"
    vpc_cidr                   = "10.70.0.0/16"
    vswitch_cidr               = "10.70.10.0/24"
    existing_vpc_id            = "vpc-fixture"
    existing_vswitch_id        = "vsw-fixture"
    existing_security_group_id = "sg-fixture"
    instance_type              = "ecs.u1-c1m2.large"
    image_id                   = "fixture-image"
    instance_password          = "FixturePassword123!"
  }

  assert {
    condition     = alicloud_instance.range.tags["PlatformHostKey"] == "practice-host"
    error_message = "The ECS billing tag must use the exact launch host key."
  }
}
