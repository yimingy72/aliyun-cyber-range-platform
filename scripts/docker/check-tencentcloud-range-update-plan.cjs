const assert = require('node:assert/strict');
const fs = require('node:fs');
const rows = fs.readFileSync(process.argv[2], 'utf8').trim().split('\n').map(JSON.parse);
const plan = rows.find(row => row.type === 'test_plan' && row['@testrun'] === 'keeps_regional_nat_after_dnat_port_only_update')?.test_plan;
assert(plan && !plan.errored, 'Port-only update requires a complete prior-state OpenTofu plan');
const nats = plan.resource_changes.filter(row => row.type === 'tencentcloud_nat_gateway');
assert.equal(nats.length, 1);
assert.deepEqual(nats[0].change.actions, ['update'], 'Mutable job tags must not replace the existing standard NAT');
assert.deepEqual(nats[0].change.replace_paths ?? [], []);
assert.equal(nats[0].change.before.id, nats[0].change.after.id);
assert.equal(nats[0].change.after.subnet_id, '');
assert.equal(nats[0].change.after.zone, 'ap-shanghai-3');
assert.equal(nats[0].change.before.name, nats[0].change.after.name, 'NAT creation-intent name must stay frozen');
const entry = plan.resource_changes.find(row => row.type === 'tencentcloud_dnat');
assert.equal(entry?.change.after.elastic_port, '18081');
for (const row of plan.resource_changes.filter(row => ['tencentcloud_instance', 'tencentcloud_eip', 'tencentcloud_nat_gateway'].includes(row.type))) {
  assert(!row.change.actions.some(action => ['create', 'delete'].includes(action)), `${row.type} must not be recreated by a DNAT port change`);
  if (row.type === 'tencentcloud_eip') {
    assert.equal(row.change.before.client_token, row.change.after.client_token, 'Existing EIP allocation intent must remain frozen');
    assert.equal(row.change.before.name, row.change.after.name, 'Existing EIP name must remain frozen');
  }
}
console.log('Tencent port-only update plan verified: existing NAT, EIPs and CVM retained.');
