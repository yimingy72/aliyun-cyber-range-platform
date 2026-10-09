terraform {
  required_version = ">= 1.8.0"
  required_providers {
    tencentcloud = {
      source  = "tencentcloudstack/tencentcloud"
      version = "= 1.83.34-range.1"
    }
  }
}
