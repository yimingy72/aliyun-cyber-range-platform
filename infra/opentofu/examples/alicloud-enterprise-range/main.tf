provider "alicloud" {
  access_key = var.access_key
  secret_key = var.secret_key
  region     = var.region
}

module "range" {
  source = "../../modules/alicloud-enterprise-range"

  resource_name_prefix    = var.resource_name_prefix
  zone_id                 = var.zone_id
  vpc_cidr                = var.vpc_cidr
  entry_host_key          = var.entry_host_key
  network_zones           = var.network_zones
  hosts                   = var.hosts
  host_network_interfaces = var.host_network_interfaces
  nat_gateways            = var.nat_gateways
  eips                    = var.eips
  security_group_rules    = var.security_group_rules
  acls                    = var.acls
  snat_entries            = var.snat_entries
  dnat_entries            = var.dnat_entries
  bootstrap_scripts       = var.bootstrap_scripts
  runtime_selections      = var.runtime_selections
  dmz_cidr                = var.dmz_cidr
  office_cidr             = var.office_cidr
  server_cidr             = var.server_cidr
  dmz_private_ip          = var.dmz_private_ip
  office_private_ip       = var.office_private_ip
  server_private_ip       = var.server_private_ip
  instance_type           = var.instance_type
  image_id                = var.image_id
  instance_password       = var.instance_password
}
