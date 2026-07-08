variable "resource_name_prefix" {
  type        = string
  description = "Short prefix used across VPC, vSwitch, security group, and ECS resource names."
}

variable "instance_name" {
  type        = string
  description = "Alibaba Cloud instance name for the single ECS host."
  default     = ""
}

variable "host_name" {
  type        = string
  description = "Alibaba Cloud host name for the single ECS host."
  default     = ""
}

variable "zone_id" {
  type        = string
  description = "Alibaba Cloud zone used by the vSwitch and ECS instance, for example cn-hangzhou-h."
}

variable "vpc_cidr" {
  type        = string
  description = "CIDR block allocated to the per-team VPC."
}

variable "vswitch_cidr" {
  type        = string
  description = "CIDR block allocated to the single vSwitch inside the team VPC."
}

variable "existing_vpc_id" {
  type        = string
  description = "Existing VPC ID reused by single-instance mode."
  default     = ""
}

variable "existing_vswitch_id" {
  type        = string
  description = "Existing vSwitch ID reused by single-instance mode."
  default     = ""
}

variable "existing_security_group_id" {
  type        = string
  description = "Existing security group ID reused by single-instance mode."
  default     = ""
}

variable "allowed_ingress_cidr" {
  type        = string
  description = "Ingress CIDR allowed to SSH into the bootstrap ECS host."
  default     = "0.0.0.0/0"
}

variable "instance_type" {
  type        = string
  description = "Alibaba Cloud ECS instance type for the first practice host."
}

variable "image_id" {
  type        = string
  description = "Alibaba Cloud image ID used to boot the first practice host."
}

variable "instance_password" {
  type        = string
  description = "Administrator password used by the first practice host."
  sensitive   = true
}

variable "internet_max_bandwidth_out" {
  type        = number
  description = "Public egress bandwidth in Mbps assigned to the ECS instance."
  default     = 10
}

variable "system_disk_category" {
  type        = string
  description = "System disk category for the ECS instance."
  default     = "cloud_essd"
}

variable "system_disk_size" {
  type        = number
  description = "System disk size in GB for the ECS instance."
  default     = 40
}

variable "tags" {
  type        = map(string)
  description = "Optional tags applied to all supported Alibaba Cloud resources."
  default     = {}
}
