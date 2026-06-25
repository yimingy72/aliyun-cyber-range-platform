variable "access_key" {
  type        = string
  description = "Alibaba Cloud access key used by the example root module."
  sensitive   = true
}

variable "secret_key" {
  type        = string
  description = "Alibaba Cloud secret key used by the example root module."
  sensitive   = true
}

variable "region" {
  type        = string
  description = "Alibaba Cloud region used by the example root module."
}

variable "zone_id" {
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
  }))
  description = "Structured host definitions forwarded to the enterprise range module."
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
