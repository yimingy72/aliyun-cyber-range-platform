variable "security_group_id" {
  type        = string
  description = "Existing bound shared security group; this module never creates or destroys networks."
}

variable "members" {
  description = "Frozen instance definitions keyed by stable platform range-instance ID."
  type = map(object({
    instance_name              = string
    host_name                  = string
    instance_type              = string
    image_id                   = string
    vswitch_id                 = string
    system_disk_category       = string
    system_disk_size           = number
    internet_max_bandwidth_out = number
    auto_release_time          = string
    tags                       = map(string)
  }))
  default = {}
}

variable "member_passwords" {
  type        = map(string)
  sensitive   = true
  description = "Secrets kept separate from the non-sensitive for_each keys."
}
