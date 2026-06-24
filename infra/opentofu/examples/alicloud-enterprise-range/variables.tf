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
