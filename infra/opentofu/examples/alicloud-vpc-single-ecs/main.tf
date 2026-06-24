provider "alicloud" {
  access_key = var.access_key
  secret_key = var.secret_key
  region     = var.region
}

module "range" {
  source = "../../modules/alicloud-vpc-single-ecs"

  resource_name_prefix = var.resource_name_prefix
  zone_id              = var.zone_id
  vpc_cidr             = var.vpc_cidr
  vswitch_cidr         = var.vswitch_cidr
  instance_type        = var.instance_type
  image_id             = var.image_id
  instance_password    = var.instance_password
}
