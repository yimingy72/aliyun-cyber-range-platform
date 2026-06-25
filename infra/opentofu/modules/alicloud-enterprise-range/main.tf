locals {
  common_tags = merge(
    {
      managed_by = "aliyun-cyber-range-platform"
      module     = "alicloud-enterprise-range"
    },
    var.tags,
  )

  normalized_network_zones = length(var.network_zones) > 0 ? var.network_zones : [
    {
      key             = "dmz"
      name            = "DMZ"
      cidr            = var.dmz_cidr
      purpose         = "public-entry"
      is_public_entry = true
    },
    {
      key             = "office"
      name            = "Office"
      cidr            = var.office_cidr
      purpose         = "user-workstations"
      is_public_entry = false
    },
    {
      key             = "server"
      name            = "Server"
      cidr            = var.server_cidr
      purpose         = "application-servers"
      is_public_entry = false
    },
  ]

  normalized_hosts = length(var.hosts) > 0 ? var.hosts : [
    {
      key           = "dmz-entry"
      name          = "DMZ Entry"
      zone_key      = "dmz"
      private_ip    = var.dmz_private_ip
      role          = "entry"
      expose_public = true
    },
    {
      key           = "office-client"
      name          = "Office Client"
      zone_key      = "office"
      private_ip    = var.office_private_ip
      role          = "office"
      expose_public = false
    },
    {
      key           = "server-app"
      name          = "Server App"
      zone_key      = "server"
      private_ip    = var.server_private_ip
      role          = "server"
      expose_public = false
    },
  ]

  network_zone_map = {
    for zone in local.normalized_network_zones : zone.key => zone
  }

  host_map = {
    for host in local.normalized_hosts : host.key => host
  }

  nat_gateway_map = {
    for nat_gateway in var.nat_gateways : nat_gateway.key => nat_gateway
  }

  explicit_entry_eips = [
    for eip in var.eips : eip if eip.bind_target_type == "host" && eip.bind_target_key == local.resolved_entry_host_key
  ]

  normalized_eips = concat(var.eips, length(local.explicit_entry_eips) == 0 ? [
    {
      key              = "entry-default"
      name             = "${var.resource_name_prefix}-entry-eip"
      bind_target_type = "host"
      bind_target_key  = local.resolved_entry_host_key
      bandwidth_mbps   = 10
    }
  ] : [])

  eip_map = {
    for eip in local.normalized_eips : eip.key => eip
  }

  normalized_security_group_rules = length(var.security_group_rules) > 0 ? var.security_group_rules : [
    {
      key             = "entry-ssh-default"
      name            = "Entry SSH Default"
      target_host_key = local.resolved_entry_host_key
      direction       = "ingress"
      policy          = "accept"
      protocol        = "tcp"
      port_range      = "22/22"
      source_cidr     = var.allowed_ingress_cidr
      priority        = 1
    },
    {
      key             = "entry-http-default"
      name            = "Entry HTTP Default"
      target_host_key = local.resolved_entry_host_key
      direction       = "ingress"
      policy          = "accept"
      protocol        = "tcp"
      port_range      = "80/80"
      source_cidr     = var.allowed_ingress_cidr
      priority        = 1
    },
  ]

  security_group_rule_map = {
    for rule in local.normalized_security_group_rules : rule.key => rule
  }

  acl_map = {
    for acl in var.acls : acl.key => acl
  }

  entry_eip_keys = [
    for eip in local.normalized_eips : eip.key if eip.bind_target_type == "host" && eip.bind_target_key == local.resolved_entry_host_key
  ]

  resolved_entry_eip_key = length(local.entry_eip_keys) > 0 ? local.entry_eip_keys[0] : ""

  entry_host_candidates = [
    for host in local.normalized_hosts : host.key if host.expose_public
  ]

  resolved_entry_host_key = var.entry_host_key != "" ? var.entry_host_key : (
    length(local.entry_host_candidates) > 0 ? local.entry_host_candidates[0] : ""
  )

  entry_host = try(local.host_map[local.resolved_entry_host_key], null)
}

check "entry_host_presence" {
  assert {
    condition     = local.resolved_entry_host_key != ""
    error_message = "The enterprise range module requires one entry host. Set entry_host_key or mark exactly one host with expose_public=true."
  }
}

check "entry_host_candidate_uniqueness" {
  assert {
    condition     = var.entry_host_key != "" || length(local.entry_host_candidates) == 1
    error_message = "When entry_host_key is omitted, exactly one host must set expose_public=true."
  }
}

check "entry_host_exists" {
  assert {
    condition     = local.entry_host != null
    error_message = "The configured entry_host_key does not exist in hosts."
  }
}

check "nat_gateway_zone_exists" {
  assert {
    condition = alltrue([
      for nat_gateway in var.nat_gateways : contains(keys(local.network_zone_map), nat_gateway.zone_key)
    ])
    error_message = "Every nat gateway must reference an existing network zone key."
  }
}

check "eip_target_exists" {
  assert {
    condition = alltrue([
      for eip in local.normalized_eips : (
        eip.bind_target_type == "host"
        ? contains(keys(local.host_map), eip.bind_target_key)
        : eip.bind_target_type == "nat_gateway"
          ? contains(keys(local.nat_gateway_map), eip.bind_target_key)
          : false
      )
    ])
    error_message = "Every EIP must reference an existing host or nat gateway target."
  }
}

check "entry_eip_exists" {
  assert {
    condition     = local.resolved_entry_eip_key != ""
    error_message = "The resolved entry host must have at least one EIP target."
  }
}

check "security_group_rule_target_exists" {
  assert {
    condition = alltrue([
      for rule in local.normalized_security_group_rules : contains(keys(local.host_map), rule.target_host_key)
    ])
    error_message = "Every security group rule must reference an existing host target."
  }
}

check "acl_zone_exists" {
  assert {
    condition = alltrue([
      for acl in var.acls : contains(keys(local.network_zone_map), acl.zone_key)
    ])
    error_message = "Every ACL must reference an existing network zone key."
  }
}

resource "alicloud_vpc" "range" {
  vpc_name   = "${var.resource_name_prefix}-vpc"
  cidr_block = var.vpc_cidr
  tags       = local.common_tags
}

resource "alicloud_vswitch" "zones" {
  for_each = local.network_zone_map

  vpc_id       = alicloud_vpc.range.id
  zone_id      = var.zone_id
  cidr_block   = each.value.cidr
  vswitch_name = "${var.resource_name_prefix}-${each.key}"
  tags = merge(local.common_tags, {
    network_zone = each.key
    purpose      = each.value.purpose
  })
}

resource "alicloud_network_acl" "zone_acls" {
  for_each = local.acl_map

  vpc_id           = alicloud_vpc.range.id
  network_acl_name = substr(replace(each.value.name, " ", "-"), 0, 128)
  resources {
    resource_id   = alicloud_vswitch.zones[each.value.zone_key].id
    resource_type = "VSwitch"
  }

  dynamic "ingress_acl_entries" {
    for_each = each.value.direction == "ingress" || each.value.direction == "inbound" ? [each.value] : []
    content {
      network_acl_entry_name = ingress_acl_entries.value.name
      source_cidr_ip         = ingress_acl_entries.value.source_cidr
      entry_type             = "custom"
      policy                 = ingress_acl_entries.value.policy
      protocol               = ingress_acl_entries.value.protocol
      port                   = ingress_acl_entries.value.port_range
    }
  }

  dynamic "egress_acl_entries" {
    for_each = each.value.direction == "egress" || each.value.direction == "outbound" ? [each.value] : []
    content {
      network_acl_entry_name = egress_acl_entries.value.name
      destination_cidr_ip    = egress_acl_entries.value.source_cidr
      entry_type             = "custom"
      policy                 = egress_acl_entries.value.policy
      protocol               = egress_acl_entries.value.protocol
      port                   = egress_acl_entries.value.port_range
    }
  }

  tags = merge(local.common_tags, {
    acl_key  = each.key
    zone_key = each.value.zone_key
  })
}

resource "alicloud_security_group" "range" {
  security_group_name = "${var.resource_name_prefix}-sg"
  description         = "Security group for the stage-one enterprise cyber range."
  vpc_id              = alicloud_vpc.range.id
  tags                = local.common_tags
}

resource "alicloud_security_group_rule" "compiled_rules" {
  for_each = local.security_group_rule_map

  type              = each.value.direction
  ip_protocol       = each.value.protocol
  nic_type          = "intranet"
  policy            = each.value.policy
  port_range        = each.value.port_range
  priority          = each.value.priority
  security_group_id = alicloud_security_group.range.id
  cidr_ip           = each.value.source_cidr
}

resource "alicloud_instance" "hosts" {
  for_each = local.host_map

  instance_name        = "${var.resource_name_prefix}-${each.key}"
  host_name            = replace(substr(each.value.name, 0, 63), " ", "-")
  instance_type        = var.instance_type
  image_id             = var.image_id
  password             = var.instance_password
  security_groups      = [alicloud_security_group.range.id]
  vswitch_id           = alicloud_vswitch.zones[each.value.zone_key].id
  private_ip           = each.value.private_ip
  system_disk_category = var.system_disk_category
  system_disk_size     = var.system_disk_size
  tags = merge(local.common_tags, {
    host_key = each.key
    role     = each.value.role
    entry    = tostring(each.key == local.resolved_entry_host_key)
  })
}

resource "alicloud_nat_gateway" "gateways" {
  for_each = local.nat_gateway_map

  vpc_id           = alicloud_vpc.range.id
  vswitch_id       = alicloud_vswitch.zones[each.value.zone_key].id
  nat_gateway_name = "${var.resource_name_prefix}-${each.key}"
  nat_type         = "Enhanced"
  payment_type     = "PayAsYouGo"
  tags = merge(local.common_tags, {
    nat_gateway_key = each.key
    zone_key        = each.value.zone_key
  })
}

resource "alicloud_eip_address" "addresses" {
  for_each = local.eip_map

  address_name         = substr(replace(each.value.name, " ", "-"), 0, 128)
  internet_charge_type = "PayByTraffic"
  payment_type         = "PayAsYouGo"
  bandwidth            = tostring(each.value.bandwidth_mbps)
  tags = merge(local.common_tags, {
    eip_key           = each.key
    bind_target_type  = each.value.bind_target_type
    bind_target_key   = each.value.bind_target_key
  })
}

resource "alicloud_eip_association" "host_targets" {
  for_each = {
    for eip_key, eip in local.eip_map : eip_key => eip if eip.bind_target_type == "host"
  }

  allocation_id = alicloud_eip_address.addresses[each.key].id
  instance_id   = alicloud_instance.hosts[each.value.bind_target_key].id
}

resource "alicloud_eip_association" "nat_targets" {
  for_each = {
    for eip_key, eip in local.eip_map : eip_key => eip if eip.bind_target_type == "nat_gateway"
  }

  allocation_id = alicloud_eip_address.addresses[each.key].id
  instance_id   = alicloud_nat_gateway.gateways[each.value.bind_target_key].id
  instance_type = "Nat"
}
