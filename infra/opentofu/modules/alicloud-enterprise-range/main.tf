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
      instance_type = var.instance_type
    },
    {
      key           = "office-client"
      name          = "Office Client"
      zone_key      = "office"
      private_ip    = var.office_private_ip
      role          = "office"
      expose_public = false
      instance_type = var.instance_type
    },
    {
      key           = "server-app"
      name          = "Server App"
      zone_key      = "server"
      private_ip    = var.server_private_ip
      role          = "server"
      expose_public = false
      instance_type = var.instance_type
    },
  ]

  network_zone_map = {
    for zone in local.normalized_network_zones : zone.key => zone
  }

  host_map = {
    for host in local.normalized_hosts : host.key => host
  }

  normalized_host_network_interfaces = [
    for attachment in var.host_network_interfaces : {
      host_key = attachment.host_key
      interfaces = [
        for network_interface in attachment.interfaces : network_interface if network_interface.device_index > 0
      ]
    }
  ]

  secondary_network_interface_records = flatten([
    for attachment in local.normalized_host_network_interfaces : [
      for network_interface in attachment.interfaces : {
        key          = "${attachment.host_key}-${network_interface.device_index}"
        host_key     = attachment.host_key
        device_index = network_interface.device_index
        zone_key     = network_interface.zone_key
        private_ip   = network_interface.private_ip
        description  = try(network_interface.description, null)
      }
    ]
  ])

  secondary_network_interface_map = {
    for network_interface in local.secondary_network_interface_records : network_interface.key => network_interface
  }

  create_time_network_interface_by_host = {
    for network_interface in local.secondary_network_interface_records : network_interface.host_key => network_interface
    if network_interface.device_index == 1
  }

  hotplug_network_interface_map = {
    for network_interface in local.secondary_network_interface_records : network_interface.key => network_interface
    if network_interface.device_index > 1
  }

  nat_gateway_map = {
    for nat_gateway in var.nat_gateways : nat_gateway.key => nat_gateway
  }

  normalized_eips = var.eips

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

  snat_entry_map = {
    for entry in var.snat_entries : entry.key => entry
  }

  dnat_entry_map = {
    for entry in var.dnat_entries : entry.key => entry
  }

  bootstrap_script_target_records = flatten([
    for script in var.bootstrap_scripts : [
      for host_key in script.target_host_keys : {
        key        = "${host_key}-${script.key}"
        host_key   = host_key
        script_key = script.key
        type       = script.type
        content    = script.content
      }
    ]
  ])

  bootstrap_host_keys = distinct([
    for target in local.bootstrap_script_target_records : target.host_key
  ])

  bootstrap_types_by_host = {
    for host_key in local.bootstrap_host_keys : host_key => distinct([
      for target in local.bootstrap_script_target_records : target.type if target.host_key == host_key
    ])
  }

  host_user_data_map = {
    for host_key in local.bootstrap_host_keys : host_key => join("\n\n", [
      for target in local.bootstrap_script_target_records : target.content if target.host_key == host_key
    ])
  }

  normalized_secondary_vpc_cidrs = distinct([
    for cidr in var.secondary_vpc_cidrs : cidr if cidr != var.vpc_cidr
  ])

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

check "snat_entry_targets_exist" {
  assert {
    condition = alltrue([
      for entry in var.snat_entries : (
        contains(keys(local.nat_gateway_map), entry.nat_gateway_key) &&
        contains(keys(local.network_zone_map), entry.source_zone_key) &&
        contains(keys(local.eip_map), entry.eip_key)
      )
    ])
    error_message = "Every SNAT entry must reference an existing nat gateway, source zone, and EIP key."
  }
}

check "dnat_entry_targets_exist" {
  assert {
    condition = alltrue([
      for entry in var.dnat_entries : (
        contains(keys(local.nat_gateway_map), entry.nat_gateway_key) &&
        contains(keys(local.eip_map), entry.eip_key) &&
        contains(keys(local.host_map), entry.backend_host_key)
      )
    ])
    error_message = "Every DNAT entry must reference an existing nat gateway, EIP key, and backend host key."
  }
}

check "secondary_network_interface_targets_exist" {
  assert {
    condition = alltrue([
      for network_interface in local.secondary_network_interface_records : (
        contains(keys(local.host_map), network_interface.host_key) &&
        contains(keys(local.network_zone_map), network_interface.zone_key)
      )
    ])
    error_message = "Every secondary host network interface must reference an existing host and network zone key."
  }
}

check "secondary_network_interface_key_uniqueness" {
  assert {
    condition = length(local.secondary_network_interface_records) == length(distinct([
      for network_interface in local.secondary_network_interface_records : network_interface.key
    ]))
    error_message = "Each host can attach at most one secondary interface per device_index."
  }
}

check "bootstrap_script_targets_exist" {
  assert {
    condition = alltrue([
      for target in local.bootstrap_script_target_records : contains(keys(local.host_map), target.host_key)
    ])
    error_message = "Every bootstrap script target must reference an existing host key."
  }
}

check "bootstrap_script_types_supported" {
  assert {
    condition = alltrue([
      for script in var.bootstrap_scripts : contains(["shell", "cloud-init"], script.type)
    ])
    error_message = "Bootstrap scripts currently support only shell and cloud-init types."
  }
}

check "bootstrap_script_type_consistency_per_host" {
  assert {
    condition = alltrue([
      for host_key, types in local.bootstrap_types_by_host : length(types) <= 1
    ])
    error_message = "Each host can currently receive only one bootstrap script type at a time."
  }
}

resource "alicloud_vpc" "range" {
  vpc_name   = "${var.resource_name_prefix}-vpc"
  cidr_block = var.vpc_cidr
  tags       = local.common_tags
}

resource "alicloud_vpc_ipv4_cidr_block" "secondary" {
  for_each = toset(local.normalized_secondary_vpc_cidrs)

  vpc_id               = alicloud_vpc.range.id
  secondary_cidr_block = each.value
}

resource "alicloud_vswitch" "zones" {
  for_each = local.network_zone_map

  vpc_id       = alicloud_vpc.range.id
  zone_id      = var.zone_id
  cidr_block   = each.value.cidr
  vswitch_name = "${var.resource_name_prefix}-${each.key}"
  depends_on   = [alicloud_vpc_ipv4_cidr_block.secondary]
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

  instance_name        = substr(replace(replace("${var.resource_name_prefix}-${each.key}", " ", "-"), "_", "-"), 0, 128)
  host_name            = try(each.value.host_name, null)
  instance_type        = try(each.value.instance_type, var.instance_type)
  image_id             = var.image_id
  password             = lookup(var.host_passwords, each.key, var.instance_password)
  security_groups      = [alicloud_security_group.range.id]
  vswitch_id           = alicloud_vswitch.zones[each.value.zone_key].id
  private_ip           = each.value.private_ip
  user_data            = try(local.host_user_data_map[each.key], null)
  system_disk_category = var.system_disk_category
  system_disk_size     = var.system_disk_size

  dynamic "network_interfaces" {
    for_each = (
      contains(keys(local.create_time_network_interface_by_host), each.key)
      ? [local.create_time_network_interface_by_host[each.key]]
      : []
    )

    content {
      network_interface_id = alicloud_network_interface.secondary[network_interfaces.value.key].id
    }
  }

  tags = merge(local.common_tags, {
    host_key = each.key
    role     = each.value.role
    entry    = tostring(each.key == local.resolved_entry_host_key)
  })
}

resource "alicloud_network_interface" "secondary" {
  for_each = local.secondary_network_interface_map

  network_interface_name = substr(
    replace("${var.resource_name_prefix}-${each.value.host_key}-${each.value.device_index}", " ", "-"),
    0,
    128,
  )
  description        = each.value.description
  vswitch_id         = alicloud_vswitch.zones[each.value.zone_key].id
  primary_ip_address = each.value.private_ip
  security_group_ids = [alicloud_security_group.range.id]
  tags = merge(local.common_tags, {
    host_key     = each.value.host_key
    zone_key     = each.value.zone_key
    device_index = tostring(each.value.device_index)
  })
}

resource "alicloud_network_interface_attachment" "secondary" {
  for_each = local.hotplug_network_interface_map

  instance_id          = alicloud_instance.hosts[each.value.host_key].id
  network_interface_id = alicloud_network_interface.secondary[each.key].id
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
    eip_key          = each.key
    bind_target_type = each.value.bind_target_type
    bind_target_key  = each.value.bind_target_key
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

resource "alicloud_snat_entry" "entries" {
  for_each = local.snat_entry_map

  snat_entry_name   = substr(replace(each.value.name, " ", "-"), 0, 128)
  snat_table_id     = alicloud_nat_gateway.gateways[each.value.nat_gateway_key].snat_table_ids
  source_vswitch_id = alicloud_vswitch.zones[each.value.source_zone_key].id
  snat_ip           = alicloud_eip_address.addresses[each.value.eip_key].ip_address

  depends_on = [alicloud_eip_association.nat_targets]
}

resource "alicloud_forward_entry" "entries" {
  for_each = local.dnat_entry_map

  forward_entry_name = substr(replace(each.value.name, " ", "-"), 0, 128)
  forward_table_id   = alicloud_nat_gateway.gateways[each.value.nat_gateway_key].forward_table_ids
  external_ip        = alicloud_eip_address.addresses[each.value.eip_key].ip_address
  external_port      = tostring(each.value.external_port)
  ip_protocol        = each.value.protocol
  internal_ip        = alicloud_instance.hosts[each.value.backend_host_key].private_ip
  internal_port      = tostring(each.value.internal_port)

  depends_on = [alicloud_eip_association.nat_targets]
}
