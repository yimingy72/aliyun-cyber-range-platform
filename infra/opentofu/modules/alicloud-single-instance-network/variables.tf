variable "resource_name_prefix" {
  type        = string
  description = "Short prefix used across the persisted single-instance network resources."
}

variable "zone_id" {
  type        = string
  description = "Alibaba Cloud zone used by the shared vSwitches."
}

variable "vpc_cidr" {
  type        = string
  description = "CIDR block allocated to the persisted single-instance VPC."
}

variable "vswitch_cidrs" {
  type        = list(string)
  description = "Three /24 CIDR blocks allocated to the persisted shared vSwitches."

  validation {
    condition     = length(var.vswitch_cidrs) == 3
    error_message = "Exactly three vSwitch CIDRs are required for the persisted single-instance network."
  }
}

variable "security_group_name" {
  type        = string
  description = "Security group name used by the persisted default network."
  default     = "single-instance-default-open-all"
}

variable "tags" {
  type        = map(string)
  description = "Optional tags applied to the persisted single-instance network resources."
  default     = {}
}
