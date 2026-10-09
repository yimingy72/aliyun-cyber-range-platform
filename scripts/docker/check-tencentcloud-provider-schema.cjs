const assert = require('node:assert/strict');
const fs = require('node:fs');

const schema = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const provider = schema.provider_schemas['registry.opentofu.org/tencentcloudstack/tencentcloud'];
assert(provider, 'Tencent Cloud provider schema is missing');
const instance = provider.resource_schemas.tencentcloud_instance.block;
assert(instance.attributes.system_disk_id.computed, 'CVM must report its actual system disk ID');
assert(instance.attributes.instance_status.computed, 'CVM must report actual cloud status');
assert(instance.attributes.password.sensitive, 'CVM password must remain sensitive');
assert(instance.attributes.client_token?.optional, 'Persisted RunInstances ClientToken is required');
assert(provider.resource_schemas.tencentcloud_eip.block.attributes.client_token?.optional, 'Persisted EIP allocation intent is required');
assert(instance.attributes.action_timer_terminate_at?.optional, 'Atomic scheduled termination is required');
assert(instance.block_types.data_disks.block.attributes.data_disk_id.computed, 'Discovered data disk IDs must be available for cleanup');
assert(instance.block_types.data_disks.block.attributes.delete_with_instance.optional, 'Data disk cleanup semantics require an explicit review');
for (const resource of ['tencentcloud_vpc', 'tencentcloud_subnet', 'tencentcloud_security_group', 'tencentcloud_security_group_rule_set', 'tencentcloud_eni', 'tencentcloud_eni_attachment', 'tencentcloud_vpc_acl', 'tencentcloud_dnat', 'tencentcloud_nat_gateway_snat']) {
  assert(provider.resource_schemas[resource], `Missing required Tencent Cloud resource: ${resource}`);
}
console.log('Tencent Cloud provider schema contract verified; durable ClientToken and atomic scheduled termination are available.');
