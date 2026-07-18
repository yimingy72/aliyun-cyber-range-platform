import fs from 'node:fs/promises';
import path from 'node:path';

const moduleMainPath = path.resolve(
  __dirname,
  '../../../infra/opentofu/modules/alicloud-enterprise-range/main.tf',
);

describe('alicloud-enterprise-range multi-NIC resource graph', () => {
  it('binds the second ENI during instance creation and hot-plugs only the third ENI', async () => {
    const moduleMain = await fs.readFile(moduleMainPath, 'utf8');

    expect(moduleMain).toMatch(
      /create_time_network_interface_by_host = \{[\s\S]*?device_index == 1[\s\S]*?\n  \}/,
    );
    expect(moduleMain).toMatch(
      /hotplug_network_interface_map = \{[\s\S]*?device_index > 1[\s\S]*?\n  \}/,
    );
    expect(moduleMain).toMatch(
      /resource "alicloud_instance" "hosts" \{[\s\S]*?dynamic "network_interfaces" \{[\s\S]*?create_time_network_interface_by_host[\s\S]*?network_interface_id = alicloud_network_interface\.secondary\[network_interfaces\.value\.key\]\.id/,
    );
    expect(moduleMain).toMatch(
      /resource "alicloud_network_interface_attachment" "secondary" \{[\s\S]*?for_each = local\.hotplug_network_interface_map/,
    );
  });
});
