locals {
  tags = {
    CloudAccountUid                = var.cloud_account_uid
    SingleInstanceNetworkProfileId = var.network_profile_id
    CreationIntentId               = var.creation_intent_id
    CreatedBy                      = "cyber-range-platform"
    PlatformScope                  = "single-instance-network"
    OwnerUserId                    = "platform"
  }
}

resource "tencentcloud_vpc" "shared" {
  name         = "${var.resource_name_prefix}-vpc"
  cidr_block   = var.vpc_cidr
  is_multicast = false
  tags         = merge(local.tags, { PlatformResourceType = "vpc" })
}

resource "tencentcloud_subnet" "shared" {
  name              = "${var.resource_name_prefix}-subnet"
  vpc_id            = tencentcloud_vpc.shared.id
  cidr_block        = var.subnet_cidr
  availability_zone = var.zone_id
  is_multicast      = false
  tags              = merge(local.tags, { PlatformResourceType = "subnet" })

  lifecycle {
    precondition {
      condition = (
        tonumber(split("/", var.subnet_cidr)[1]) >= tonumber(split("/", var.vpc_cidr)[1]) &&
        cidrhost("${cidrhost(var.subnet_cidr, 0)}/${split("/", var.vpc_cidr)[1]}", 0) == cidrhost(var.vpc_cidr, 0)
      )
      error_message = "The subnet must be completely contained within its VPC."
    }
  }
}

resource "tencentcloud_security_group" "shared" {
  name        = "${var.resource_name_prefix}-sg"
  description = "Platform-managed single-instance network"
  tags        = merge(local.tags, { PlatformResourceType = "security-group" })
}

resource "tencentcloud_security_group_rule_set" "shared" {
  security_group_id = tencentcloud_security_group.shared.id

  dynamic "ingress" {
    for_each = var.ingress_rules
    content {
      action     = "ACCEPT"
      cidr_block = ingress.value.cidr_block
      protocol   = ingress.value.protocol
      port       = ingress.value.port
    }
  }
  ingress {
    action     = "DROP"
    cidr_block = "0.0.0.0/0"
    protocol   = "ALL"
    port       = "all"
  }
  egress {
    action     = "ACCEPT"
    cidr_block = "0.0.0.0/0"
    protocol   = "ALL"
    port       = "all"
  }
}
