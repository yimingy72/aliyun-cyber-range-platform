locals {
  common_tags = merge(
    {
      managed_by = "aliyun-cyber-range-platform"
      module     = "alicloud-vpc-single-ecs"
    },
    var.tags,
  )
}

resource "alicloud_vpc" "range" {
  vpc_name   = "${var.resource_name_prefix}-vpc"
  cidr_block = var.vpc_cidr
  tags       = local.common_tags
}

resource "alicloud_vswitch" "range" {
  vpc_id       = alicloud_vpc.range.id
  zone_id      = var.zone_id
  cidr_block   = var.vswitch_cidr
  vswitch_name = "${var.resource_name_prefix}-vsw"
  tags         = local.common_tags
}

resource "alicloud_security_group" "range" {
  security_group_name = "${var.resource_name_prefix}-sg"
  description         = "Security group for the first single-host cyber range."
  vpc_id              = alicloud_vpc.range.id
  tags                = local.common_tags
}

resource "alicloud_security_group_rule" "ssh_ingress" {
  type              = "ingress"
  ip_protocol       = "tcp"
  nic_type          = "intranet"
  policy            = "accept"
  port_range        = "22/22"
  priority          = 1
  security_group_id = alicloud_security_group.range.id
  cidr_ip           = var.allowed_ingress_cidr
}

resource "alicloud_security_group_rule" "web_ingress" {
  type              = "ingress"
  ip_protocol       = "tcp"
  nic_type          = "intranet"
  policy            = "accept"
  port_range        = "80/80"
  priority          = 1
  security_group_id = alicloud_security_group.range.id
  cidr_ip           = var.allowed_ingress_cidr
}

resource "alicloud_instance" "range" {
  instance_name              = "${var.resource_name_prefix}-ecs"
  host_name                  = "${var.resource_name_prefix}-ecs"
  instance_type              = var.instance_type
  image_id                   = var.image_id
  password                   = var.instance_password
  security_groups            = [alicloud_security_group.range.id]
  vswitch_id                 = alicloud_vswitch.range.id
  internet_max_bandwidth_out = var.internet_max_bandwidth_out
  system_disk_category       = var.system_disk_category
  system_disk_size           = var.system_disk_size
  tags                       = local.common_tags
}
