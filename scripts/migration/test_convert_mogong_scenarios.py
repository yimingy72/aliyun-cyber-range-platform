import copy
import unittest

from convert_mogong_scenarios import convert_scenarios


class ConversionTests(unittest.TestCase):
    def source(self):
        image_id = 'ubuntu_22_04_x64_20G_alibase_example.vhd'
        nodes = [
            {'id': 'router', 'group': 'route', 'label': 'Router'},
            {'id': 'switch', 'group': 'exchange', 'label': 'Switch', 'configs': {
                'network': [{'private_ip': '10.0.10.0/24'}],
                'acl': [], 'nat': {'snat': {'enable': False}, 'dnat': []},
            }},
            {'id': 'host', 'group': 'client', 'label': 'Host', 'configs': {
                'base': {'cpu': 1, 'memory': 2, 'target_image_id': '7', 'target': {'id': 7}},
                'network': [{'switch_id': 'switch', 'private_ip': '10.0.10.10', 'security_group': []}],
            }},
        ]
        source = {'details': [{'detail': {'id': 19, 'name': 'Scene', 'active': True}, 'network': {'network_config': {
            'nodes': nodes, 'edges': [{'id': 'rs', 'from': 'router', 'to': 'switch'}, {'id': 'sh', 'from': 'switch', 'to': 'host'}],
        }}}]}
        images = [{'id': 7, 'name': 'Source', 'image_type': 'vm', 'system_type': 'linux', 'active': True, 'external_resource_id': image_id}]
        platform = {'visible': [], 'mine': [], 'custom': {'snapshots': []}, 'publicImages': {'snapshots': [{
            'id': 'verified-snapshot', 'imageId': image_id, 'sourceImageName': 'Verified Ubuntu',
            'status': 'Available', 'isAvailable': True,
        }]}}
        return source, images, platform

    def test_preserves_public_image_identity_resources_network_and_empty_security_groups(self):
        source, images, platform = self.source()
        original = copy.deepcopy(source)
        row, = convert_scenarios(source, images, platform)
        self.assertFalse(row['reasons'])
        host = row['payload']['topologyGraph']['nodes'][2]
        self.assertEqual((host['cpu'], host['memory']), (1, 2))
        self.assertEqual(host['imageId'], images[0]['external_resource_id'])
        self.assertEqual(host['nics'][0]['securityGroupRulesMode'], 'custom')
        self.assertEqual(host['nics'][0]['securityGroupRules'], [])
        self.assertEqual(source, original)

    def test_does_not_collect_dependencies_for_a_dangling_or_unsupported_edge(self):
        for edge in ({'id': 'dangling', 'from': 'missing', 'to': 'host'}, {'id': 'host-router', 'from': 'host', 'to': 'router'}):
            with self.subTest(edge=edge):
                source, images, platform = self.source()
                source['details'][0]['network']['network_config']['edges'].append(edge)
                row, = convert_scenarios(source, images, platform)
                self.assertIsNone(row['payload'])
                self.assertEqual(row['dependencies'], {})

    def test_requires_exact_cloud_image_not_a_similar_name_or_a_disabled_source(self):
        for mutation in ('cloud-id', 'source-disabled'):
            with self.subTest(mutation=mutation):
                source, images, platform = self.source()
                if mutation == 'cloud-id':
                    platform['publicImages']['snapshots'][0]['imageId'] = 'similar-but-different'
                else:
                    images[0]['active'] = False
                row, = convert_scenarios(source, images, platform)
                self.assertIsNone(row['payload'])

    def test_maps_directional_peer_and_default_acl_precedence(self):
        source, images, platform = self.source()
        switch = source['details'][0]['network']['network_config']['nodes'][1]
        switch['configs']['acl'] = [{
            'type': 'outbound', 'action': 'accept', 'protocol': 'ALL', 'priority': 9999,
            'source_ip': '10.0.10.0/24', 'destination_ip': '0.0.0.0/0', 'port_range': '-1/-1',
        }]
        row, = convert_scenarios(source, images, platform)
        rule = row['payload']['topologyGraph']['nodes'][1]['aclRules'][0]
        self.assertEqual((rule['direction'], rule['sourceCidr'], rule['policy'], rule['priority']),
                         ('outbound', '0.0.0.0/0', 'allow', 1000))

    def test_preserves_global_dns_on_all_windows_nics_and_rejects_partial_linux_mapping(self):
        source, images, platform = self.source()
        source['details'][0]['network']['network_config']['nodes'][0]['configs'] = {'base': {'dns': '10.0.10.10,10.0.10.11'}}
        images[0]['system_type'] = 'windows'
        row, = convert_scenarios(source, images, platform)
        self.assertEqual(row['payload']['topologyGraph']['nodes'][2]['dns'],
                         {'servers': ['10.0.10.10', '10.0.10.11'], 'nicIds': ['host-nic-1']})
        images[0]['system_type'] = 'linux'
        row, = convert_scenarios(source, images, platform)
        self.assertIsNone(row['payload'])


if __name__ == '__main__':
    unittest.main()
