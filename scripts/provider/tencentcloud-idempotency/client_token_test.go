package cvm

import (
  "testing"
  "github.com/hashicorp/terraform-plugin-sdk/v2/helper/schema"
)

func TestRangePersistedClientToken(t *testing.T) {
  for _, resource := range []*schema.Resource{ResourceTencentCloudInstance(), ResourceTencentCloudEip()} {
  field := resource.Schema["client_token"]
  if field == nil || !field.Optional || !field.ForceNew { t.Fatal("creation intent must be configurable and immutable") }
  for _, token := range []string{"abc123", "0123456789abcdef0123456789abcdef"} {
    data := schema.TestResourceDataRaw(t, resource.Schema, map[string]interface{}{"client_token": token})
    if rangeInstanceClientToken(data) != token || rangeInstanceClientToken(data) != token { t.Fatal("retry changed persisted token") }
  }
  if _, errs := field.ValidateFunc("", "client_token"); len(errs) == 0 { t.Fatal("empty intent must be rejected") }
  }
  timer := ResourceTencentCloudInstance().Schema["action_timer_terminate_at"]
  if timer == nil || !timer.ForceNew { t.Fatal("atomic expiry must be immutable") }
  if _, errs := timer.ValidateFunc("2100-01-01T00:00:00Z", "action_timer_terminate_at"); len(errs) != 0 { t.Fatal("UTC expiry rejected") }
  if _, errs := timer.ValidateFunc("2100-01-01", "action_timer_terminate_at"); len(errs) == 0 { t.Fatal("ambiguous expiry accepted") }
}
