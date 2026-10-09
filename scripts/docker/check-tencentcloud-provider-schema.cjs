const assert = require('node:assert/strict');
const fs = require('node:fs');

const schema = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const provider = schema.provider_schemas['registry.opentofu.org/tencentcloudstack/tencentcloud'];
assert(provider, 'Tencent Cloud provider schema is missing');
const instance = provider.resource_schemas.tencentcloud_instance.block;
assert(instance.attributes.system_disk_id.computed, 'CVM must report its actual system disk ID');
assert(instance.attributes.instance_status.computed, 'CVM must report actual cloud status');
assert(instance.attributes.password.sensitive, 'CVM password must remain sensitive');
assert(!instance.attributes.client_token, 'Review durable ClientToken support before enabling creation');
assert(instance.block_types.data_disks.block.attributes.data_disk_id.computed, 'Discovered data disk IDs must be available for cleanup');
assert(instance.block_types.data_disks.block.attributes.delete_with_instance.optional, 'Data disk cleanup semantics require an explicit review');
for (const resource of ['tencentcloud_vpc', 'tencentcloud_subnet', 'tencentcloud_security_group', 'tencentcloud_security_group_rule_set']) {
  assert(provider.resource_schemas[resource], `Missing required Tencent Cloud resource: ${resource}`);
}
console.log('Tencent Cloud provider schema contract verified; durable ClientToken remains unavailable.');
