resource "alicloud_instance" "members" {
  for_each = var.members

  instance_name              = each.value.instance_name
  host_name                  = each.value.host_name == "" ? null : each.value.host_name
  instance_type              = each.value.instance_type
  image_id                   = each.value.image_id
  password                   = var.member_passwords[each.key]
  security_groups            = [var.security_group_id]
  vswitch_id                 = each.value.vswitch_id
  instance_charge_type       = "PostPaid"
  force_delete               = true
  internet_max_bandwidth_out = each.value.internet_max_bandwidth_out
  system_disk_category       = each.value.system_disk_category
  system_disk_size           = each.value.system_disk_size
  auto_release_time          = each.value.auto_release_time == "" ? null : each.value.auto_release_time
  tags                       = each.value.tags
  volume_tags                = merge(each.value.tags, { PlatformResourceType = "disk" })

  lifecycle {
    ignore_changes = [auto_release_time]
  }
}
