import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('enterprise range assigns a dedicated security group to every topology ECS', () => {
  const mainTf = fs.readFileSync(
    new URL('../infra/opentofu/modules/alicloud-enterprise-range/main.tf', import.meta.url),
    'utf8',
  );

  assert.match(mainTf, /resource "alicloud_security_group" "hosts"/);
  assert.match(mainTf, /for_each\s*=\s*local\.host_map/);
  assert.match(mainTf, /security_group_id\s*=\s*alicloud_security_group\.hosts\[each\.value\.target_host_key\]\.id/);
  assert.match(mainTf, /security_groups\s*=\s*\[alicloud_security_group\.hosts\[each\.key\]\.id\]/);
  assert.match(mainTf, /security_group_ids\s*=\s*\[alicloud_security_group\.hosts\[each\.value\.host_key\]\.id\]/);
  assert.doesNotMatch(mainTf, /normalized_security_group_rules/);
  assert.doesNotMatch(mainTf, /alicloud_security_group\.range/);
});
