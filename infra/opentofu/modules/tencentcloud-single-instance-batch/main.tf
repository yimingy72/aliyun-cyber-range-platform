resource "tencentcloud_instance" "members" {
  for_each = var.members

  instance_name              = each.value.instance_name
  hostname                   = each.value.host_name == "" ? null : each.value.host_name
  availability_zone          = var.zone_id
  instance_type              = each.value.instance_type
  image_id                   = each.value.image_id
  password                   = var.member_passwords[each.key]
  vpc_id                     = var.vpc_id
  subnet_id                  = each.value.subnet_id
  orderly_security_groups    = [var.security_group_id]
  instance_charge_type       = "POSTPAID_BY_HOUR"
  internet_charge_type       = "TRAFFIC_POSTPAID_BY_HOUR"
  allocate_public_ip         = each.value.internet_max_bandwidth_out > 0
  internet_max_bandwidth_out = each.value.internet_max_bandwidth_out
  system_disk_type           = each.value.system_disk_type
  system_disk_size           = each.value.system_disk_size
  disable_monitor_service    = true
  disable_security_service   = true
  tags                       = each.value.tags
}
