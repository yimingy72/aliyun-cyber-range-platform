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
