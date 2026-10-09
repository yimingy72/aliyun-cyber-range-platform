variable "network_profile_id" {
  type = string
  validation {
    condition     = can(regex("^[A-Za-z0-9][A-Za-z0-9_.:-]{0,126}$", var.network_profile_id))
    error_message = "A stable platform network profile ID is required."
  }
}

variable "creation_intent_id" {
  type = string
  validation {
    condition     = can(regex("^[A-Za-z0-9][A-Za-z0-9_.:-]{0,126}$", var.creation_intent_id))
    error_message = "Persist the network creation intent before rendering the workspace."
  }
}

variable "cloud_account_uid" {
  type = string
  validation {
    condition     = can(regex("^[0-9]{1,32}$", var.cloud_account_uid))
    error_message = "A verified Tencent Cloud account UIN is required."
  }
}

variable "region" {
  type = string
}

variable "zone_id" {
  type = string
  validation {
    condition     = can(regex("^[a-z]{2}-[a-z]+(-[a-z]+)*-[0-9]+$", var.zone_id)) && startswith(var.zone_id, "${var.region}-")
    error_message = "The zone must belong to the frozen region."
  }
}

variable "resource_name_prefix" {
  type = string
  validation {
    condition     = length(var.resource_name_prefix) > 0 && length(var.resource_name_prefix) <= 40
    error_message = "Resource name prefix must contain 1 to 40 characters."
  }
}

variable "vpc_cidr" {
  type    = string
  default = "10.0.0.0/16"
  validation {
    condition     = can(cidrnetmask(var.vpc_cidr)) && try(cidrsubnet(var.vpc_cidr, 0, 0) == var.vpc_cidr, false)
    error_message = "Use a canonical IPv4 VPC CIDR."
  }
}

variable "subnet_cidr" {
  type    = string
  default = "10.0.1.0/24"
  validation {
    condition     = can(cidrnetmask(var.subnet_cidr)) && try(cidrsubnet(var.subnet_cidr, 0, 0) == var.subnet_cidr, false)
    error_message = "Use a canonical IPv4 subnet CIDR."
  }
}

variable "ingress_rules" {
  type = list(object({
    cidr_block = string
    protocol   = string
    port       = string
  }))
  default     = []
  description = "Explicit allowed ingress; empty means closed. This module owns the complete security-group rule set."
  validation {
    condition = alltrue([
      for rule in var.ingress_rules : can(cidrnetmask(rule.cidr_block)) &&
      contains(["TCP", "UDP", "ICMP", "ALL"], rule.protocol) &&
      ((contains(["ICMP", "ALL"], rule.protocol) && rule.port == "all") ||
      (contains(["TCP", "UDP"], rule.protocol) && can(regex("^[0-9]+(-[0-9]+)?(,[0-9]+(-[0-9]+)?)*$", rule.port))))
    ])
    error_message = "Ingress must use explicit IPv4 CIDRs, valid protocols and ports."
  }
}
