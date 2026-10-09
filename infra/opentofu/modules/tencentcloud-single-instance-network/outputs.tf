output "network_profile" {
  value = {
    cloud_provider     = "tencent_cloud"
    cloud_account_uid  = var.cloud_account_uid
    region             = var.region
    zone_id            = var.zone_id
    network_profile_id = var.network_profile_id
    creation_intent_id = var.creation_intent_id
    vpc_id             = tencentcloud_vpc.shared.id
    subnet_id          = tencentcloud_subnet.shared.id
    security_group_id  = tencentcloud_security_group.shared.id
  }
  depends_on = [tencentcloud_security_group_rule_set.shared]
}

output "resource_inventory" {
  value = {
    cloud_provider     = "tencent_cloud"
    cloud_account_uid  = var.cloud_account_uid
    region             = var.region
    network_profile_id = var.network_profile_id
    creation_intent_id = var.creation_intent_id
    vpc_ids            = [tencentcloud_vpc.shared.id]
    subnet_ids         = [tencentcloud_subnet.shared.id]
    security_group_ids = [tencentcloud_security_group.shared.id]
    route_table_ids    = [tencentcloud_vpc.shared.default_route_table_id]
    eip_ids            = []
    nat_gateway_ids    = []
  }
}
