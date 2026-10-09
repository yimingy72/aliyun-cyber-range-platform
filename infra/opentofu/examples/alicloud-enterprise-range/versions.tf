terraform {
  required_version = ">= 1.8.0"

  required_providers {
    alicloud = {
      source  = "aliyun/alicloud"
      version = "= 1.282.0-range.1"
    }
  }
}
