locals {
  hosts          = { for host in var.hosts : host.key => host }
  zones          = { for zone in var.network_zones : zone.key => zone }
  nics           = { for nic in var.network_interfaces : nic.key => nic }
  primary_nics   = { for key, nic in local.nics : key => nic if nic.device_index == 0 }
  secondary_nics = { for key, nic in local.nics : key => nic if nic.device_index > 0 }
  nats           = { for nat in var.nat_gateways : nat.key => nat }
  eips           = { for eip in var.eips : eip.key => eip }
  acl_zones      = toset([for acl in var.acls : acl.zone_key])
  entry_eip_key  = one(distinct([for entry in var.dnat_entries : entry.eip_key if entry.host_key == var.entry_host_key]))
}
resource "tencentcloud_vpc" "range" {
  name            = "${var.resource_name_prefix}-vpc"
  cidr_block      = var.vpc_cidr
  assistant_cidrs = var.secondary_vpc_cidrs
  is_multicast    = false
  tags            = var.tags
}
resource "tencentcloud_subnet" "zones" {
  for_each          = local.zones
  name              = substr("${var.resource_name_prefix}-${each.key}", 0, 60)
  vpc_id            = tencentcloud_vpc.range.id
  cidr_block        = each.value.cidr
  availability_zone = var.zone_id
  tags              = var.tags
}
resource "tencentcloud_security_group" "nics" {
  for_each    = local.nics
  name        = substr("${var.resource_name_prefix}-${each.key}", 0, 60)
  description = "Range NIC ${each.key}"
  tags        = var.tags
}
resource "tencentcloud_security_group_rule_set" "nics" {
  for_each          = local.nics
  security_group_id = tencentcloud_security_group.nics[each.key].id
  dynamic "ingress" {
    for_each = [for rule in sort([for rule in var.security_group_rules : format("%03d:%s", rule.priority, rule.key) if rule.host_key == each.value.host_key && (rule.device_index == null || rule.device_index == each.value.device_index) && rule.direction == "ingress"]) : one([for value in var.security_group_rules : value if format("%03d:%s", value.priority, value.key) == rule])]
    content {
      action      = ingress.value.action
      cidr_block  = ingress.value.cidr_block
      protocol    = ingress.value.protocol
      port        = ingress.value.port
      description = ingress.value.description
    }
  }
  ingress {
    action     = "DROP"
    cidr_block = "0.0.0.0/0"
    protocol   = "ALL"
    port       = "all"
  }
  dynamic "egress" {
    for_each = [for rule in sort([for rule in var.security_group_rules : format("%03d:%s", rule.priority, rule.key) if rule.host_key == each.value.host_key && (rule.device_index == null || rule.device_index == each.value.device_index) && rule.direction == "egress"]) : one([for value in var.security_group_rules : value if format("%03d:%s", value.priority, value.key) == rule])]
    content {
      action      = egress.value.action
      cidr_block  = egress.value.cidr_block
      protocol    = egress.value.protocol
      port        = egress.value.port
      description = egress.value.description
    }
  }
  egress {
    action     = "DROP"
    cidr_block = "0.0.0.0/0"
    protocol   = "ALL"
    port       = "all"
  }
}
resource "tencentcloud_instance" "hosts" {
  for_each                   = local.hosts
  client_token               = each.value.creation_intent_id
  action_timer_terminate_at  = each.value.terminate_at
  instance_name              = each.value.name
  hostname                   = each.value.host_name == "" ? null : each.value.host_name
  availability_zone          = var.zone_id
  instance_type              = each.value.instance_type
  image_id                   = each.value.image_id
  password                   = var.host_passwords[each.key]
  vpc_id                     = tencentcloud_vpc.range.id
  subnet_id                  = tencentcloud_subnet.zones[each.value.zone_key].id
  private_ip                 = each.value.private_ip
  orderly_security_groups    = [tencentcloud_security_group.nics["${each.key}-0"].id]
  instance_charge_type       = "POSTPAID_BY_HOUR"
  internet_charge_type       = "TRAFFIC_POSTPAID_BY_HOUR"
  allocate_public_ip         = false
  internet_max_bandwidth_out = 0
  system_disk_type           = each.value.system_disk_type
  system_disk_size           = each.value.system_disk_size
  user_data_raw              = each.value.user_data == "" ? null : each.value.user_data
  disable_monitor_service    = true
  disable_security_service   = true
  tags                       = merge(var.tags, { PlatformHostKey = each.key, PlatformResourceType = "ecs", CreationIntentId = each.value.creation_intent_id })
  depends_on                 = [tencentcloud_security_group_rule_set.nics]

  lifecycle {
    # Private CVMs have no direct public IP or bandwidth. Tencent reads this
    # unused billing field back as empty; preserve that value during updates.
    ignore_changes = [internet_charge_type]
  }
}
resource "tencentcloud_eni" "secondary" {
  for_each                = local.secondary_nics
  name                    = substr("${var.resource_name_prefix}-${each.key}", 0, 60)
  vpc_id                  = tencentcloud_vpc.range.id
  subnet_id               = tencentcloud_subnet.zones[each.value.zone_key].id
  orderly_security_groups = [tencentcloud_security_group.nics[each.key].id]
  dynamic "ipv4s" {
    for_each = concat([{ ip = each.value.private_ip, primary = true }], [for ip in each.value.secondary_ips : { ip = ip, primary = false }])
    content {
      ip      = ipv4s.value.ip
      primary = ipv4s.value.primary
    }
  }
  tags       = merge(var.tags, { PlatformHostKey = each.value.host_key, PlatformNicKey = each.key })
  depends_on = [tencentcloud_security_group_rule_set.nics]
}
resource "tencentcloud_eni_attachment" "secondary" {
  for_each    = local.secondary_nics
  eni_id      = tencentcloud_eni.secondary[each.key].id
  instance_id = tencentcloud_instance.hosts[each.value.host_key].id
}
data "tencentcloud_enis" "primary" {
  for_each    = { for key, nic in local.primary_nics : key => nic if length(nic.secondary_ips) > 0 }
  instance_id = tencentcloud_instance.hosts[each.value.host_key].id
  vpc_id      = tencentcloud_vpc.range.id
  subnet_id   = tencentcloud_subnet.zones[each.value.zone_key].id
}
resource "tencentcloud_eni_ipv4_address" "primary" {
  for_each             = { for key, nic in local.primary_nics : key => nic if length(nic.secondary_ips) > 0 }
  network_interface_id = one([for eni in data.tencentcloud_enis.primary[each.key].enis : eni.id if eni.primary])
  dynamic "private_ip_addresses" {
    for_each = each.value.secondary_ips
    content {
      private_ip_address = private_ip_addresses.value
      primary            = false
    }
  }
}
resource "tencentcloud_vpc_acl" "zones" {
  for_each = local.acl_zones
  vpc_id   = tencentcloud_vpc.range.id
  name     = substr("${var.resource_name_prefix}-${each.key}", 0, 60)
  ingress  = [for key in sort([for acl in var.acls : format("%03d:%s", acl.priority, acl.key) if acl.zone_key == each.key && acl.direction == "inbound"]) : one([for acl in var.acls : "${acl.action}#${acl.cidr_block}#${acl.port}#${acl.protocol}#${acl.description}" if acl.zone_key == each.key && acl.direction == "inbound" && format("%03d:%s", acl.priority, acl.key) == key])]
  egress   = [for key in sort([for acl in var.acls : format("%03d:%s", acl.priority, acl.key) if acl.zone_key == each.key && acl.direction == "outbound"]) : one([for acl in var.acls : "${acl.action}#${acl.cidr_block}#${acl.port}#${acl.protocol}#${acl.description}" if acl.zone_key == each.key && acl.direction == "outbound" && format("%03d:%s", acl.priority, acl.key) == key])]
  tags     = var.tags
}
resource "tencentcloud_vpc_acl_attachment" "zones" {
  for_each  = local.acl_zones
  acl_id    = tencentcloud_vpc_acl.zones[each.key].id
  subnet_id = tencentcloud_subnet.zones[each.key].id
}
resource "tencentcloud_eip" "range" {
  client_token               = each.value.creation_intent_id
  for_each                   = local.eips
  name                       = "${var.resource_name_prefix}-${substr(each.value.creation_intent_id, 0, 16)}"
  internet_charge_type       = "TRAFFIC_POSTPAID_BY_HOUR"
  internet_max_bandwidth_out = each.value.bandwidth
  tags                       = merge(var.tags, { CreationIntentId = each.value.creation_intent_id, PlatformResourceType = "eip" })
}
resource "tencentcloud_nat_gateway" "shared" {
  for_each = local.nats
  name     = "${var.resource_name_prefix}-${substr(each.value.creation_intent_id, 0, 16)}"
  vpc_id   = tencentcloud_vpc.range.id
  # Standard public NAT is regional; preserve provider-computed placement instead of forcing subnet replacement.
  nat_product_version = 2
  bandwidth           = 5000
  max_concurrent      = 2000000
  assigned_eip_set    = [for key, eip in local.eips : tencentcloud_eip.range[key].public_ip if eip.nat_key == each.key]
  tags                = merge(var.tags, { CreationIntentId = each.value.creation_intent_id, PlatformResourceType = "nat_gateway" })
}
resource "tencentcloud_route_table" "zones" {
  for_each = local.zones
  vpc_id   = tencentcloud_vpc.range.id
  name     = substr("${var.resource_name_prefix}-${each.key}-routes", 0, 60)
  tags     = var.tags
}
resource "tencentcloud_route_table_association" "zones" {
  for_each       = local.zones
  route_table_id = tencentcloud_route_table.zones[each.key].id
  subnet_id      = tencentcloud_subnet.zones[each.key].id
}
resource "tencentcloud_route_table_entry" "internet" {
  for_each               = { for entry in var.snat_entries : entry.zone_key => entry }
  route_table_id         = tencentcloud_route_table.zones[each.key].id
  destination_cidr_block = "0.0.0.0/0"
  next_type              = "NAT"
  next_hub               = tencentcloud_nat_gateway.shared[each.value.nat_key].id
}
resource "tencentcloud_nat_gateway_snat" "zones" {
  for_each          = { for entry in var.snat_entries : entry.key => entry }
  nat_gateway_id    = tencentcloud_nat_gateway.shared[each.value.nat_key].id
  resource_type     = "SUBNET"
  subnet_id         = tencentcloud_subnet.zones[each.value.zone_key].id
  subnet_cidr_block = local.zones[each.value.zone_key].cidr
  public_ip_addr    = [tencentcloud_eip.range[each.value.eip_key].public_ip]
  description       = each.key
  depends_on        = [tencentcloud_route_table_entry.internet, tencentcloud_route_table_association.zones]
}
resource "tencentcloud_dnat" "entry" {
  for_each     = { for entry in var.dnat_entries : entry.key => entry }
  vpc_id       = tencentcloud_vpc.range.id
  nat_id       = tencentcloud_nat_gateway.shared[each.value.nat_key].id
  elastic_ip   = tencentcloud_eip.range[each.value.eip_key].public_ip
  elastic_port = tostring(each.value.external_port)
  private_ip   = coalesce(each.value.private_ip, tencentcloud_instance.hosts[each.value.host_key].private_ip)
  private_port = tostring(each.value.internal_port)
  protocol     = each.value.protocol
  description  = each.key
  depends_on   = [tencentcloud_route_table_entry.internet, tencentcloud_route_table_association.zones, tencentcloud_eni_attachment.secondary]
}

check "dnat_owned_nic_targets" {
  assert {
    condition = alltrue([for entry in var.dnat_entries : entry.private_ip == null || contains(
      [for nic in var.network_interfaces : nic.private_ip if nic.host_key == entry.host_key], entry.private_ip
    )])
    error_message = "DNAT private_ip must be a primary address of the referenced host's declared NICs."
  }
}
