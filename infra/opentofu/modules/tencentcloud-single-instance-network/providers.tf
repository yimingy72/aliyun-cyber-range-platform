terraform {
  required_version = ">= 1.13.1"
  required_providers {
    tencentcloud = {
      source  = "tencentcloudstack/tencentcloud"
      version = "= 1.83.34-range.1"
    }
  }
}
