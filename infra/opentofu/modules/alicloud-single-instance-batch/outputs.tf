output "members" {
  value = {
    for key, instance in alicloud_instance.members : key => {
      instance_id    = instance.id
      private_ip     = instance.private_ip
      public_ip      = instance.public_ip
      status         = instance.status
      system_disk_id = instance.system_disk_id
    }
  }
}
