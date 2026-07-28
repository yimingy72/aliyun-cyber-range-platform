locals {
  common_tags = merge(
    var.tags,
    {
      managed_by         = "aliyun-cyber-range-platform"
      module             = "alicloud-vpc-single-ecs"
      PlatformManaged    = "true"
      PlatformTagVersion = "1"
    },
  )
  reuse_existing_vpc            = trimspace(var.existing_vpc_id) != ""
  reuse_existing_vswitch        = trimspace(var.existing_vswitch_id) != ""
  reuse_existing_security_group = trimspace(var.existing_security_group_id) != ""
  effective_instance_name       = trimspace(var.instance_name) != "" ? trimspace(var.instance_name) : "${var.resource_name_prefix}-ecs"
  effective_host_name           = trimspace(var.host_name) != "" ? trimspace(var.host_name) : local.effective_instance_name
}

resource "alicloud_vpc" "range" {
  count      = local.reuse_existing_vpc ? 0 : 1
  vpc_name   = "${var.resource_name_prefix}-vpc"
  cidr_block = var.vpc_cidr
  tags = merge(local.common_tags, {
    PlatformResourceType = "vpc"
  })
}

resource "alicloud_vswitch" "range" {
  count        = local.reuse_existing_vswitch ? 0 : 1
  vpc_id       = local.reuse_existing_vpc ? var.existing_vpc_id : alicloud_vpc.range[0].id
  zone_id      = var.zone_id
  cidr_block   = var.vswitch_cidr
  vswitch_name = "${var.resource_name_prefix}-vsw"
  tags = merge(local.common_tags, {
    PlatformResourceType = "vswitch"
  })
}

resource "alicloud_security_group" "range" {
  count               = local.reuse_existing_security_group ? 0 : 1
  security_group_name = "${var.resource_name_prefix}-sg"
  description         = "Security group for the first single-host cyber range."
  vpc_id              = local.reuse_existing_vpc ? var.existing_vpc_id : alicloud_vpc.range[0].id
  tags = merge(local.common_tags, {
    PlatformResourceType = "security_group"
  })
}

resource "alicloud_security_group_rule" "ssh_ingress" {
  count             = local.reuse_existing_security_group ? 0 : 1
  type              = "ingress"
  ip_protocol       = "tcp"
  nic_type          = "intranet"
  policy            = "accept"
  port_range        = "22/22"
  priority          = 1
  security_group_id = alicloud_security_group.range[0].id
  cidr_ip           = var.allowed_ingress_cidr
}

resource "alicloud_security_group_rule" "web_ingress" {
  count             = local.reuse_existing_security_group ? 0 : 1
  type              = "ingress"
  ip_protocol       = "tcp"
  nic_type          = "intranet"
  policy            = "accept"
  port_range        = "80/80"
  priority          = 1
  security_group_id = alicloud_security_group.range[0].id
  cidr_ip           = var.allowed_ingress_cidr
}

locals {
  effective_vpc_id            = local.reuse_existing_vpc ? var.existing_vpc_id : alicloud_vpc.range[0].id
  effective_vswitch_id        = local.reuse_existing_vswitch ? var.existing_vswitch_id : alicloud_vswitch.range[0].id
  effective_security_group_id = local.reuse_existing_security_group ? var.existing_security_group_id : alicloud_security_group.range[0].id
}

resource "alicloud_instance" "range" {
  instance_name              = local.effective_instance_name
  host_name                  = local.effective_host_name
  instance_type              = var.instance_type
  image_id                   = var.image_id
  password                   = var.instance_password
  security_groups            = [local.effective_security_group_id]
  vswitch_id                 = local.effective_vswitch_id
  internet_max_bandwidth_out = var.internet_max_bandwidth_out
  system_disk_category       = var.system_disk_category
  system_disk_size           = var.system_disk_size
  tags = merge(local.common_tags, {
    PlatformResourceType = "ecs"
    PlatformHostKey      = var.host_key
  })
}
