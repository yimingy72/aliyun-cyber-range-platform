import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('enterprise range keeps primary host and secondary NIC security groups separate', () => {
  const mainTf = fs.readFileSync(
    new URL('../infra/opentofu/modules/alicloud-enterprise-range/main.tf', import.meta.url),
    'utf8',
  );

  assert.match(mainTf, /resource "alicloud_security_group" "hosts"/);
  assert.match(mainTf, /for_each\s*=\s*local\.host_map/);
  assert.match(mainTf, /coalesce\(each\.value\.target_device_index, 0\) > 0/);
  assert.match(mainTf, /alicloud_security_group\.hosts\[each\.value\.target_host_key\]\.id/);
  assert.match(mainTf, /resource "alicloud_security_group" "network_interfaces"/);
  assert.match(mainTf, /security_groups\s*=\s*\[alicloud_security_group\.hosts\[each\.key\]\.id\]/);
  assert.match(mainTf, /contains\(keys\(local\.secondary_security_group_map\), each\.key\)/);
  assert.match(mainTf, /alicloud_security_group\.network_interfaces\[each\.key\]\.id/);
  assert.match(mainTf, /alicloud_security_group\.hosts\[each\.value\.host_key\]\.id/);
  assert.doesNotMatch(mainTf, /normalized_security_group_rules/);
  assert.doesNotMatch(mainTf, /alicloud_security_group\.range/);
});
