variable "resource_name_prefix" {
  type        = string
  description = "Short prefix used across the enterprise cyber range resources."
}

variable "zone_id" {
  type        = string
  description = "Alibaba Cloud zone used by the vSwitches and ECS instances."
}

variable "vpc_cidr" {
  type        = string
  description = "CIDR block used by the per-team VPC."
}

variable "secondary_vpc_cidrs" {
  type        = list(string)
  description = "Additional IPv4 CIDR blocks attached to the VPC for extra switch ranges."
  default     = ["172.16.0.0/16", "192.168.0.0/16"]
}

variable "entry_host_key" {
  type        = string
  description = "Template host key exposed as the public DMZ entrypoint."
  default     = ""
}

variable "network_zones" {
  type = list(object({
    key             = string
    name            = string
    cidr            = string
    purpose         = string
    is_public_entry = bool
  }))
  description = "Structured network zone definitions compiled from the published template."
  default     = []
}

variable "hosts" {
  type = list(object({
    key           = string
    name          = string
    zone_key      = string
    private_ip    = string
    role          = string
    expose_public = bool
    instance_type = optional(string)
  }))
  description = "Structured host definitions compiled from the published template."
  default     = []
}

variable "host_network_interfaces" {
  type = list(object({
    host_key = string
    interfaces = list(object({
      device_index = number
      zone_key     = string
      private_ip   = string
      description  = optional(string)
    }))
  }))
  description = "Structured secondary host network interfaces compiled from the published template."
  default     = []
}

variable "nat_gateways" {
  type = list(object({
    key          = string
    name         = string
    zone_key     = string
    snat_enabled = bool
  }))
  description = "Structured nat gateway definitions compiled from the published template."
  default     = []
}

variable "eips" {
  type = list(object({
    key              = string
    name             = string
    bind_target_type = string
    bind_target_key  = string
    bandwidth_mbps   = number
  }))
  description = "Structured EIP definitions compiled from the published template."
  default     = []
}

variable "security_group_rules" {
  type = list(object({
    key             = string
    name            = string
    target_host_key = string
    direction       = string
    policy          = string
    protocol        = string
    port_range      = string
    source_cidr     = string
    priority        = number
  }))
  description = "Structured security group rules compiled from the published template."
  default     = []
}

variable "acls" {
  type = list(object({
    key         = string
    name        = string
    zone_key    = string
    direction   = string
    policy      = string
    protocol    = string
    port_range  = string
    source_cidr = string
    priority    = number
  }))
  description = "Structured network ACL rules compiled from the published template."
  default     = []
}

variable "snat_entries" {
  type = list(object({
    key             = string
    name            = string
    nat_gateway_key = string
    source_zone_key = string
    eip_key         = string
  }))
  description = "Structured SNAT entry definitions compiled from the published template."
  default     = []
}

variable "dnat_entries" {
  type = list(object({
    key              = string
    name             = string
    nat_gateway_key  = string
    eip_key          = string
    backend_host_key = string
    external_port    = number
    internal_port    = number
    protocol         = string
  }))
  description = "Structured DNAT entry definitions compiled from the published template."
  default     = []
}

variable "bootstrap_scripts" {
  type = list(object({
    key              = string
    name             = string
    type             = string
    content          = string
    target_host_keys = list(string)
  }))
  description = "Structured bootstrap scripts compiled from the published template."
  default     = []
}

variable "runtime_selections" {
  type = object({
    image_policies         = any
    instance_type_policies = any
    attempted_zones = optional(list(object({
      zone_id               = string
      can_create_all_hosts  = bool
      estimated_total_price = number
      reason                = optional(string)
    })))
  })
  description = "Resolved runtime policy metadata forwarded for diagnostics and traceability."
  default = {
    image_policies         = {}
    instance_type_policies = {}
  }
}

variable "dmz_cidr" {
  type        = string
  description = "CIDR block used by the DMZ subnet."
}

variable "office_cidr" {
  type        = string
  description = "CIDR block used by the office subnet."
}

variable "server_cidr" {
  type        = string
  description = "CIDR block used by the server subnet."
}

variable "dmz_private_ip" {
  type        = string
  description = "Fixed private IP for the DMZ entry ECS instance."
}

variable "office_private_ip" {
  type        = string
  description = "Fixed private IP for the office ECS instance."
}

variable "server_private_ip" {
  type        = string
  description = "Fixed private IP for the server ECS instance."
}

variable "instance_type" {
  type        = string
  description = "Alibaba Cloud ECS instance type used by all stage-one hosts."
}

variable "image_id" {
  type        = string
  description = "Alibaba Cloud image ID used by all stage-one hosts."
}

variable "instance_password" {
  type        = string
  description = "Administrator password used by all stage-one hosts."
  sensitive   = true
}

variable "allowed_ingress_cidr" {
  type        = string
  description = "Ingress CIDR allowed to reach the DMZ entry host."
  default     = "0.0.0.0/0"
}

variable "system_disk_category" {
  type        = string
  description = "System disk category for all stage-one hosts."
  default     = "cloud_essd"
}

variable "system_disk_size" {
  type        = number
  description = "System disk size in GB for all stage-one hosts."
  default     = 40
}

variable "tags" {
  type        = map(string)
  description = "Optional tags applied to supported resources."
  default     = {}
}
