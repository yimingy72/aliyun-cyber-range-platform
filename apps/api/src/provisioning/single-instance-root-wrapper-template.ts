export function buildSingleInstanceRootWrapperFiles(moduleSource: string) {
  return {
    'main.tf': [
      'provider "alicloud" {}',
      '',
      'module "range" {',
      `  source = "${moduleSource}"`,
      '',
      '  resource_name_prefix      = var.resource_name_prefix',
      '  instance_name             = var.instance_name',
      '  host_name                 = var.host_name',
      '  host_key                  = var.host_key',
      '  zone_id                   = var.zone_id',
      '  vpc_cidr                  = var.vpc_cidr',
      '  vswitch_cidr              = var.vswitch_cidr',
      '  existing_vpc_id           = var.existing_vpc_id',
      '  existing_vswitch_id       = var.existing_vswitch_id',
      '  existing_security_group_id = var.existing_security_group_id',
      '  allowed_ingress_cidr      = var.allowed_ingress_cidr',
      '  instance_type             = var.instance_type',
      '  image_id                  = var.image_id',
      '  instance_password         = var.instance_password',
      '  internet_max_bandwidth_out = var.internet_max_bandwidth_out',
      '  system_disk_category      = var.system_disk_category',
      '  system_disk_size          = var.system_disk_size',
      '  tags                      = var.tags',
      '}',
      '',
    ].join('\n'),
    'variables.tf': `variable "resource_name_prefix" {
  type        = string
  description = "Prefix applied to the single-instance workspace resources."
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

variable "host_key" {
  type        = string
  description = "Logical host key recorded in resource summary outputs."
}

variable "zone_id" {
  type        = string
  description = "Alibaba Cloud zone used by the single ECS host."
}

variable "vpc_cidr" {
  type        = string
  description = "CIDR block recorded for the shared VPC."
}

variable "vswitch_cidr" {
  type        = string
  description = "CIDR block recorded for the selected shared vSwitch."
}

variable "existing_vpc_id" {
  type        = string
  description = "Existing VPC ID reused by the single ECS host."
}

variable "existing_vswitch_id" {
  type        = string
  description = "Existing vSwitch ID reused by the single ECS host."
}

variable "existing_security_group_id" {
  type        = string
  description = "Existing security group ID reused by the single ECS host."
}

variable "allowed_ingress_cidr" {
  type        = string
  description = "Ingress CIDR used when the module has to create its own security group."
  default     = "0.0.0.0/0"
}

variable "instance_type" {
  type        = string
  description = "Alibaba Cloud ECS instance type used by the single ECS host."
}

variable "image_id" {
  type        = string
  description = "Alibaba Cloud image ID used by the single ECS host."
}

variable "instance_password" {
  type        = string
  description = "Administrator password used by the single ECS host."
  sensitive   = true
}

variable "internet_max_bandwidth_out" {
  type        = number
  description = "Public egress bandwidth in Mbps assigned to the ECS instance."
  default     = 10
}

variable "system_disk_category" {
  type        = string
  description = "System disk category for the single ECS host."
  default     = "cloud_essd"
}

variable "system_disk_size" {
  type        = number
  description = "System disk size in GB for the single ECS host."
  default     = 40
}

variable "tags" {
  type        = map(string)
  description = "Optional tags applied to supported resources."
  default     = {}
}
`,
    'outputs.tf': `output "public_entry" {
  value = {
    host_role  = var.host_key
    public_ip  = module.range.public_ip
    private_ip = module.range.private_ip
    ssh        = module.range.public_ip != null && module.range.public_ip != "" ? "ssh root@\${module.range.public_ip}" : null
  }
}

output "resource_summary" {
  value = {
    vpc_id                 = module.range.vpc_id
    subnet_ids             = { (var.host_key) = module.range.vswitch_id }
    host_ids               = { (var.host_key) = module.range.instance_id }
    resolved_instance_type = var.instance_type
    resolved_image_id      = var.image_id
  }
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
