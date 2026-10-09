output "members" {
  value = {
    for key, instance in tencentcloud_instance.members : key => {
      instance_id        = instance.id
      private_ip         = instance.private_ip
      public_ip          = instance.public_ip
      status             = instance.instance_status
      system_disk_id     = instance.system_disk_id
      data_disk_ids      = compact([for disk in instance.data_disks : disk.data_disk_id])
      owner_user_id      = var.members[key].tags["OwnerUserId"]
      creation_intent_id = var.members[key].tags["CreationIntentId"]
    }
  }
}

output "resource_inventory" {
  value = {
    cloud_provider    = "tencent_cloud"
    cloud_account_uid = var.cloud_account_uid
    region            = var.region
    batch_id          = var.batch_id
    host_ids          = [for instance in values(tencentcloud_instance.members) : instance.id]
    system_disk_ids   = compact([for instance in values(tencentcloud_instance.members) : instance.system_disk_id])
    data_disk_ids     = flatten([for instance in values(tencentcloud_instance.members) : compact([for disk in instance.data_disks : disk.data_disk_id])])
    # Shared network IDs are references, not resources created/owned by this workspace.
    referenced_network = {
      vpc_id            = var.vpc_id
      subnet_ids        = distinct([for member in values(var.members) : member.subnet_id])
      security_group_id = var.security_group_id
    }
    owned_network = { vpc_ids = [], subnet_ids = [], security_group_ids = [], eip_ids = [], nat_gateway_ids = [] }
  }
}
