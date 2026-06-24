provider "alicloud" {
  access_key = var.access_key
  secret_key = var.secret_key
  region     = var.region
}

module "range" {
  source = "../../modules/alicloud-enterprise-range"

  resource_name_prefix = var.resource_name_prefix
  zone_id              = var.zone_id
  vpc_cidr             = var.vpc_cidr
  dmz_cidr             = var.dmz_cidr
  office_cidr          = var.office_cidr
  server_cidr          = var.server_cidr
  dmz_private_ip       = var.dmz_private_ip
  office_private_ip    = var.office_private_ip
  server_private_ip    = var.server_private_ip
  instance_type        = var.instance_type
  image_id             = var.image_id
  instance_password    = var.instance_password
}
