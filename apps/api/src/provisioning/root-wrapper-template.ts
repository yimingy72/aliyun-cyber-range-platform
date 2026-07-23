export function buildRootWrapperFiles(moduleSource: string) {
  return {
    'main.tf': [
      'provider "alicloud" {}',
      '',
      'module "range" {',
      `  source = "${moduleSource}"`,
      '',
      '  resource_name_prefix    = var.resource_name_prefix',
      '  zone_id                 = var.zone_id',
      '  vpc_cidr                = var.vpc_cidr',
      '  secondary_vpc_cidrs     = var.secondary_vpc_cidrs',
      '  entry_host_key          = var.entry_host_key',
      '  network_zones           = var.network_zones',
      '  hosts                   = var.hosts',
      '  host_network_interfaces = var.host_network_interfaces',
      '  nat_gateways            = var.nat_gateways',
      '  eips                    = var.eips',
      '  security_group_rules    = var.security_group_rules',
      '  acls                    = var.acls',
      '  snat_entries            = var.snat_entries',
      '  dnat_entries            = var.dnat_entries',
      '  bootstrap_scripts       = var.bootstrap_scripts',
      '  runtime_selections      = var.runtime_selections',
      '  dmz_cidr                = var.dmz_cidr',
      '  office_cidr             = var.office_cidr',
      '  server_cidr             = var.server_cidr',
      '  dmz_private_ip          = var.dmz_private_ip',
      '  office_private_ip       = var.office_private_ip',
      '  server_private_ip       = var.server_private_ip',
      '  instance_type           = var.instance_type',
      '  image_id                = var.image_id',
      '  host_passwords          = var.host_passwords',
      '  instance_password       = lookup(var.host_passwords, var.entry_host_key, var.instance_password)',
      '  allowed_ingress_cidr    = var.allowed_ingress_cidr',
      '  system_disk_category    = var.system_disk_category',
      '  system_disk_size        = var.system_disk_size',
      '  tags                    = var.tags',
      '}',
      '',
    ].join('\n'),
    'variables.tf': `variable "zone_id" {
  type        = string
  description = "Alibaba Cloud zone used by the example root module."
}

variable "resource_name_prefix" {
  type        = string
  description = "Prefix applied to resources created through the example root module."
}

variable "vpc_cidr" {
  type        = string
  description = "CIDR block assigned to the example VPC."
}

variable "secondary_vpc_cidrs" {
  type        = list(string)
  description = "Additional IPv4 CIDR blocks attached to the example VPC."
  default     = []
}

variable "dmz_cidr" {
  type        = string
  description = "CIDR block assigned to the example DMZ subnet."
}

variable "office_cidr" {
  type        = string
  description = "CIDR block assigned to the example office subnet."
}

variable "server_cidr" {
  type        = string
  description = "CIDR block assigned to the example server subnet."
}

variable "dmz_private_ip" {
  type        = string
  description = "Fixed private IP for the example DMZ ECS instance."
}

variable "office_private_ip" {
  type        = string
  description = "Fixed private IP for the example office ECS instance."
}

variable "server_private_ip" {
  type        = string
  description = "Fixed private IP for the example server ECS instance."
}

variable "instance_type" {
  type        = string
  description = "Alibaba Cloud ECS instance type used by the example root module."
}

variable "image_id" {
  type        = string
  description = "Alibaba Cloud image ID used by the example root module."
}

variable "instance_password" {
  type        = string
  description = "Administrator password used by the example root module."
  sensitive   = true
}

variable "host_passwords" {
  type        = map(string)
  description = "Per-host administrator passwords rendered by the API for compatibility shims and future module inputs."
  sensitive   = true
  default     = {}
}

variable "allowed_ingress_cidr" {
  type        = string
  description = "Ingress CIDR allowed to reach the DMZ entry host."
  default     = "0.0.0.0/0"
}

variable "internet_max_bandwidth_out" {
  type        = number
  description = "Reserved root-wrapper compatibility field for renderer output."
  default     = 0
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

variable "entry_host_key" {
  type        = string
  description = "Template host key used as the public entrypoint in the example root module."
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
  description = "Structured network zones forwarded to the enterprise range module."
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
    image_id      = optional(string)
  }))
  description = "Structured host definitions forwarded to the enterprise range module."
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
  description = "Structured secondary host network interfaces forwarded to the enterprise range module."
  default     = []
}

variable "nat_gateways" {
  type = list(object({
    key          = string
    name         = string
    zone_key     = string
    snat_enabled = bool
  }))
  description = "Structured NAT gateway definitions forwarded to the enterprise range module."
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
  description = "Structured EIP definitions forwarded to the enterprise range module."
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
  description = "Structured security group rules forwarded to the enterprise range module."
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
  description = "Structured ACL definitions forwarded to the enterprise range module."
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
  description = "Structured SNAT entry definitions forwarded to the enterprise range module."
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
  description = "Structured DNAT entry definitions forwarded to the enterprise range module."
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
  description = "Structured bootstrap scripts forwarded to the enterprise range module."
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
  description = "Resolved runtime policy metadata forwarded to the enterprise range module for diagnostics."
  default = {
    image_policies         = {}
    instance_type_policies = {}
  }
}
`,
    'outputs.tf': `output "public_entry" {
  value = module.range.public_entry
}

output "resource_summary" {
  value = module.range.resource_summary
}
`,
    'versions.tf': `terraform {
  required_version = ">= 1.8.0"

  required_providers {
    alicloud = {
      source  = "aliyun/alicloud"
      version = "~> 1.253"
    }
  }
}
`,
  };
}
