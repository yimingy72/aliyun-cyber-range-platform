locals {
  common_tags = merge(
    {
      managed_by = "aliyun-cyber-range-platform"
      module     = "alicloud-enterprise-range"
    },
    var.tags,
  )
}

resource "alicloud_vpc" "range" {
  vpc_name   = "${var.resource_name_prefix}-vpc"
  cidr_block = var.vpc_cidr
  tags       = local.common_tags
}

resource "alicloud_vswitch" "dmz" {
  vpc_id       = alicloud_vpc.range.id
  zone_id      = var.zone_id
  cidr_block   = var.dmz_cidr
  vswitch_name = "${var.resource_name_prefix}-dmz"
  tags         = merge(local.common_tags, { network_zone = "dmz" })
}

resource "alicloud_vswitch" "office" {
  vpc_id       = alicloud_vpc.range.id
  zone_id      = var.zone_id
  cidr_block   = var.office_cidr
  vswitch_name = "${var.resource_name_prefix}-office"
  tags         = merge(local.common_tags, { network_zone = "office" })
}

resource "alicloud_vswitch" "server" {
  vpc_id       = alicloud_vpc.range.id
  zone_id      = var.zone_id
  cidr_block   = var.server_cidr
  vswitch_name = "${var.resource_name_prefix}-server"
  tags         = merge(local.common_tags, { network_zone = "server" })
}

resource "alicloud_security_group" "range" {
  security_group_name = "${var.resource_name_prefix}-sg"
  description         = "Security group for the stage-one enterprise cyber range."
  vpc_id              = alicloud_vpc.range.id
  tags                = local.common_tags
}

resource "alicloud_security_group_rule" "dmz_ssh_ingress" {
  type              = "ingress"
  ip_protocol       = "tcp"
  nic_type          = "intranet"
  policy            = "accept"
  port_range        = "22/22"
  priority          = 1
  security_group_id = alicloud_security_group.range.id
  cidr_ip           = var.allowed_ingress_cidr
}

resource "alicloud_security_group_rule" "dmz_http_ingress" {
  type              = "ingress"
  ip_protocol       = "tcp"
  nic_type          = "intranet"
  policy            = "accept"
  port_range        = "80/80"
  priority          = 1
  security_group_id = alicloud_security_group.range.id
  cidr_ip           = var.allowed_ingress_cidr
}

resource "alicloud_instance" "dmz" {
  instance_name        = "${var.resource_name_prefix}-dmz"
  host_name            = "${var.resource_name_prefix}-dmz"
  instance_type        = var.instance_type
  image_id             = var.image_id
  password             = var.instance_password
  security_groups      = [alicloud_security_group.range.id]
  vswitch_id           = alicloud_vswitch.dmz.id
  private_ip           = var.dmz_private_ip
  system_disk_category = var.system_disk_category
  system_disk_size     = var.system_disk_size
  tags                 = merge(local.common_tags, { role = "dmz", entry = "true" })
}

resource "alicloud_instance" "office" {
  instance_name        = "${var.resource_name_prefix}-office"
  host_name            = "${var.resource_name_prefix}-office"
  instance_type        = var.instance_type
  image_id             = var.image_id
  password             = var.instance_password
  security_groups      = [alicloud_security_group.range.id]
  vswitch_id           = alicloud_vswitch.office.id
  private_ip           = var.office_private_ip
  system_disk_category = var.system_disk_category
  system_disk_size     = var.system_disk_size
  tags                 = merge(local.common_tags, { role = "office" })
}

resource "alicloud_instance" "server" {
  instance_name        = "${var.resource_name_prefix}-server"
  host_name            = "${var.resource_name_prefix}-server"
  instance_type        = var.instance_type
  image_id             = var.image_id
  password             = var.instance_password
  security_groups      = [alicloud_security_group.range.id]
  vswitch_id           = alicloud_vswitch.server.id
  private_ip           = var.server_private_ip
  system_disk_category = var.system_disk_category
  system_disk_size     = var.system_disk_size
  tags                 = merge(local.common_tags, { role = "server" })
}

resource "alicloud_eip_address" "dmz" {
  address_name         = "${var.resource_name_prefix}-dmz-eip"
  internet_charge_type = "PayByTraffic"
  payment_type         = "PayAsYouGo"
  bandwidth            = "10"
  tags                 = merge(local.common_tags, { role = "entry" })
}

resource "alicloud_eip_association" "dmz" {
  allocation_id = alicloud_eip_address.dmz.id
  instance_id   = alicloud_instance.dmz.id
}
