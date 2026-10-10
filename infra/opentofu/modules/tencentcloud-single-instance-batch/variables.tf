variable "batch_id" {
  type        = string
  description = "Frozen platform batch ID."
}

variable "cloud_account_uid" {
  type        = string
  description = "Verified Tencent Cloud root account UIN bound before resource creation."
  validation {
    condition     = can(regex("^[0-9]{1,32}$", var.cloud_account_uid))
    error_message = "A verified Tencent Cloud account UIN is required."
  }
}

variable "region" {
  type        = string
  description = "Frozen region; caller must configure the Tencent provider to this exact region."
}

variable "zone_id" {
  type = string
  validation {
    condition     = can(regex("^[a-z]{2}-[a-z]+(-[a-z]+)*-[0-9]+$", var.zone_id)) && startswith(var.zone_id, "${var.region}-")
    error_message = "The zone must belong to the frozen region."
  }
}

variable "vpc_id" {
  type = string
  validation {
    condition     = can(regex("^vpc-[a-z0-9]+$", var.vpc_id))
    error_message = "An explicitly bound VPC is required."
  }
}

variable "security_group_id" {
  type = string
  validation {
    condition     = can(regex("^sg-[a-z0-9]+$", var.security_group_id))
    error_message = "An explicitly bound security group is required."
  }
}

variable "members" {
  description = "Frozen CVM definitions keyed by stable platform range-instance ID; no network resources are created by this module."
  type = map(object({
    client_token               = string
    action_timer_terminate_at  = optional(string)
    instance_name              = string
    host_name                  = string
    instance_type              = string
    image_id                   = string
    subnet_id                  = string
    system_disk_type           = string
    system_disk_size           = number
    internet_max_bandwidth_out = number
    tags                       = map(string)
  }))
  default = {}
  validation {
    condition = length(var.members) <= 99 && length(distinct([for member in values(var.members) : lookup(member.tags, "CreationIntentId", "")])) == length(var.members) && alltrue([
      for key, member in var.members :
      can(regex("^[A-Za-z0-9][A-Za-z0-9_.:-]{0,126}$", key)) && lookup(member.tags, "RangeInstanceId", "") == key &&
      lookup(member.tags, "OwnerUserId", "") != "" &&
      (lookup(member.tags, "OwnerUserId", "") == "platform" ? lookup(member.tags, "PlatformUserId", "") == "" : lookup(member.tags, "PlatformUserId", "") == lookup(member.tags, "OwnerUserId", "")) &&
      lookup(member.tags, "CloudAccountUid", "") == var.cloud_account_uid &&
      lookup(member.tags, "SingleInstanceBatchId", "") == var.batch_id &&
      lookup(member.tags, "CreationIntentId", "") == member.client_token && length(member.client_token) > 0 && length(member.client_token) <= 64 &&
      lookup(member.tags, "CreatedBy", "") == "cyber-range-platform" &&
      contains(["user", "platform"], lookup(member.tags, "PlatformScope", "")) &&
      lookup(member.tags, "PlatformResourceType", "") == "ecs"
    ])
    error_message = "Every CVM must retain its exact owner, account, batch, creation intent and platform identity."
  }
  validation {
    condition = alltrue([
      for member in values(var.members) :
      contains(["CLOUD_PREMIUM", "CLOUD_SSD", "CLOUD_BSSD", "CLOUD_HSSD", "CLOUD_TSSD"], member.system_disk_type) &&
      member.system_disk_size >= 20 && member.system_disk_size <= 1024 && floor(member.system_disk_size) == member.system_disk_size &&
      member.internet_max_bandwidth_out >= 0 && member.internet_max_bandwidth_out <= 100 && floor(member.internet_max_bandwidth_out) == member.internet_max_bandwidth_out &&
      can(regex("^subnet-[a-z0-9]+$", member.subnet_id)) && can(regex("^img-[a-z0-9]+$", member.image_id))
    ])
    error_message = "CVMs require explicit image/subnet IDs, managed system disks and bounded public bandwidth."
  }
}

variable "member_passwords" {
  type        = map(string)
  sensitive   = true
  description = "Secrets separate from the non-sensitive for_each map; never include them in inventory outputs."
  validation {
    condition     = toset(keys(var.member_passwords)) == toset(keys(var.members))
    error_message = "Password keys must match the exact member IDs."
  }
}
