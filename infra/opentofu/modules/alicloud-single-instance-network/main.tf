locals {
  common_tags = merge(
    {
      managed_by = "aliyun-cyber-range-platform"
      module     = "alicloud-single-instance-network"
    },
    var.tags,
  )
}

resource "alicloud_vpc" "default" {
  vpc_name   = "${var.resource_name_prefix}-vpc"
  cidr_block = var.vpc_cidr
  tags       = local.common_tags
}

resource "alicloud_vswitch" "default" {
  count = length(var.vswitch_cidrs)

  vpc_id       = alicloud_vpc.default.id
  zone_id      = var.zone_id
  cidr_block   = var.vswitch_cidrs[count.index]
  vswitch_name = format("%s-vsw-%02d", var.resource_name_prefix, count.index + 1)
  tags         = local.common_tags
}

resource "alicloud_security_group" "default" {
  security_group_name = var.security_group_name
  description         = "Security group shared by persisted single-instance ECS hosts."
  vpc_id              = alicloud_vpc.default.id
  tags                = local.common_tags
}

resource "alicloud_security_group_rule" "open_all_ingress" {
  type              = "ingress"
  ip_protocol       = "all"
  nic_type          = "intranet"
  policy            = "accept"
  port_range        = "-1/-1"
  priority          = 1
  security_group_id = alicloud_security_group.default.id
  cidr_ip           = "0.0.0.0/0"
}
