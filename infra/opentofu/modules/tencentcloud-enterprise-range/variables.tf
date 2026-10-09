variable "resource_name_prefix" { type = string }
variable "range_instance_id" { type = string }
variable "region" { type = string }
variable "zone_id" {
  type = string
  validation {
    condition     = startswith(var.zone_id, "${var.region}-")
    error_message = "Every subnet and CVM must use the frozen region and physical zone."
  }
}
variable "vpc_cidr" { type = string }
variable "secondary_vpc_cidrs" { type = list(string) }
variable "entry_host_key" { type = string }
variable "network_zones" { type = list(object({ key = string, name = string, cidr = string })) }
variable "hosts" {
  type = list(object({ key = string, name = string, host_name = string, image_id = string, instance_type = string, private_ip = string, zone_key = string, system_disk_type = string, system_disk_size = number, terminate_at = string, creation_intent_id = string, user_data = string }))
  validation {
    condition     = alltrue([for host in var.hosts : can(regex("^[0-9a-f]{32}$", host.creation_intent_id)) && can(regex("^img-[a-z0-9]+$", host.image_id)) && host.system_disk_size >= 20 && host.system_disk_size <= 1024]) && length(distinct([for host in var.hosts : host.creation_intent_id])) == length(var.hosts)
    error_message = "Every CVM requires a distinct persistent creation intent, exact image and bounded managed disk."
  }
}
variable "network_interfaces" { type = list(object({ key = string, host_key = string, device_index = number, zone_key = string, private_ip = string, secondary_ips = list(string) })) }
variable "host_passwords" {
  type      = map(string)
  sensitive = true
  validation {
    condition     = toset(keys(var.host_passwords)) == toset([for host in var.hosts : host.key])
    error_message = "Credentials must belong to the exact host map."
  }
}
variable "security_group_rules" { type = list(object({ key = string, host_key = string, device_index = number, direction = string, action = string, protocol = string, port = string, cidr_block = string, priority = number, description = string })) }
variable "acls" { type = list(object({ key = string, zone_key = string, direction = string, action = string, protocol = string, port = string, cidr_block = string, priority = number, description = string })) }
variable "nat_gateways" { type = list(object({ key = string, name = string, zone_key = string })) }
variable "eips" { type = list(object({ key = string, name = string, nat_key = string, bandwidth = number })) }
variable "snat_entries" { type = list(object({ key = string, nat_key = string, zone_key = string, eip_key = string })) }
variable "dnat_entries" { type = list(object({ key = string, nat_key = string, eip_key = string, host_key = string, external_port = number, internal_port = number, protocol = string })) }
variable "tags" {
  type = map(string)
  validation {
    condition     = lookup(var.tags, "CloudProvider", "") == "tencent_cloud" && lookup(var.tags, "CloudAccountContextId", "") != "" && can(regex("^[0-9]{1,32}$", lookup(var.tags, "CloudAccountUid", ""))) && lookup(var.tags, "RangeInstanceId", "") == var.range_instance_id && lookup(var.tags, "PlatformCreateJobId", "") != "" && lookup(var.tags, "CreatedBy", "") == "cyber-range-platform"
    error_message = "Range resources require a frozen account, owner, range and creation job."
  }
}
