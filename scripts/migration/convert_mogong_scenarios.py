"""Convert a private Mogong export into plans; compilation and all writes remain with the platform MCP."""
import argparse
import json
import re
from collections import Counter, defaultdict
from ipaddress import ip_address, ip_network
from pathlib import Path

def convert_scenarios(data, source_images, platform):
    p = platform
    images = {str(item['id']): item for item in source_images}
    all_assets = {i['id']: i for i in p['visible'] + p['mine']}
    assets = defaultdict(list)
    cloud = defaultdict(list)
    for a in all_assets.values():
        assets[a['imageId']].append(a)
    for scope in ('custom', 'publicImages'):
        for row in p[scope]['snapshots']:
            if row['isAvailable'] and row['status'] == 'Available':
                cloud[row['imageId']].append(row)
    vpcs = [ip_network(i) for i in ('10.0.0.0/16', '172.16.0.0/16', '192.168.0.0/16')]
    any_ip = '0.0.0.0/0'

    def cidr(s):
        s = (s or '').strip()
        if s in ('', '0.0.0.0', any_ip):
            return any_ip
        if '/' not in s:
            return str(ip_address(s)) + '/32'
        return str(ip_network(s, strict=False))

    def endpoint(raw):
        return str(ip_address(str(raw).strip().split('/')[0]))

    def ports(value):
        if value in ('-1/-1', '1/65535'):
            return '1/65535'
        if isinstance(value, str) and re.fullmatch('\\d+/\\d+', value):
            a, b = map(int, value.split('/'))
            if 1 <= a <= b <= 65535:
                return f'{a}/{b}'
        raise ValueError('端口范围无效')

    def rule(r, key, sg):
        typ, act, protocol = (r.get('type'), r.get('action'), str(r.get('protocol', '')).lower())
        if typ not in ('inbound', 'outbound') or act not in ('accept', 'drop') or protocol not in ('all', 'tcp', 'udp', 'icmp', 'gre'):
            raise ValueError('未知访问规则')
        source = cidr(r.get('source_ip')) if typ == 'inbound' else any_ip
        dest = cidr(r.get('destination_ip')) if typ == 'outbound' else any_ip
        if not isinstance(r.get('priority'), int):
            raise ValueError('访问规则缺少优先级')
        return dict(key=key, direction={'inbound': 'ingress', 'outbound': 'egress'}[typ] if sg else typ, protocol=protocol, portRange=ports(r.get('port_range')), sourceCidr=source if typ == 'inbound' else dest, policy=act if sg or act == 'drop' else 'allow', priority=r['priority'], description=r.get('desc') or '')

    def switch_rules(rules, key):
        result = [rule(r, f'{key}-acl-{i}', False) for i, r in enumerate(rules)]
        priorities = {r['priority'] for r in result}
        if 9999 in priorities and all((1 <= p < 1000 for p in priorities - {9999})):
            for r in result:
                if r['priority'] == 9999:
                    r['priority'] = 1000
        return result

    def allow_all(rs):
        return not rs or (len(rs) == 2 and {r.get('type') for r in rs} == {'inbound', 'outbound'} and all((str(r.get('protocol')).lower() == 'all' and r.get('action') == 'accept' and (r.get('port_range') in ('-1/-1', '1/65535')) and all(((r.get(f) or '') in ('', '0.0.0.0', any_ip) for f in ('source_ip', 'destination_ip'))) for r in rs)))

    def graph(record):
        detail = record['detail']
        net = record['network']['network_config'] or {}
        source = net.get('nodes') or []
        groups = Counter((n.get('group') for n in source))
        byid = {n.get('id'): n for n in source}
        problems = set()
        dependencies = {}
        nodes = []
        edges = []
        dns_values = [(n.get('configs') or {}).get('base', {}).get('dns') for n in source if n.get('group') == 'route']
        global_dns = next((value for value in dns_values if value), None)
        dns_servers = []

        def add(reason):
            problems.add(str(reason))
        if not detail['active']:
            add('墨攻已停用')
        if groups['route'] != 1 or not groups['exchange'] or (not groups['client']) or (len(byid) != len(source)):
            add('拓扑不完整或路由器数量不受支持')
        if set(groups) - {'route', 'exchange', 'client'}:
            add('未知节点类型')
        if global_dns:
            try:
                dns_servers = [str(ip_address(value.strip())) for value in str(global_dns).split(',')]
                if not 1 <= len(dns_servers) <= 4 or len(set(dns_servers)) != len(dns_servers) or any((':' in value for value in dns_servers)):
                    raise ValueError('源全局 DNS 配置无效')
            except ValueError:
                add('源全局 DNS 配置无效')
        for n in source:
            k = n['id']
            g = n['group']
            cfg = n.get('configs') or {}
            b = cfg.get('base') or {}
            label = (n.get('label') or b.get('name') or '').strip()
            if not label:
                add('节点缺少名称')
            node = dict(id=k, label=label, position={'x': n.get('x', 0), 'y': n.get('y', 0)})
            try:
                if g == 'route':
                    if not allow_all(cfg.get('acl')):
                        add('平台不支持路由器级访问控制')
                    if (cfg.get('nat') or {}).get('dnat'):
                        add('平台不支持路由器级 NAT')
                    node.update(kind='router', routeRole='egress', egressType='internet', bindEip=False)
                elif g == 'exchange':
                    network = cfg.get('network') or []
                    if len(network) != 1 or not network[0].get('private_ip'):
                        raise ValueError('交换机缺少唯一网段')
                    segment = ip_network(network[0]['private_ip'], strict=False)
                    if not any((segment.subnet_of(vpc) for vpc in vpcs)):
                        raise ValueError('交换机网段超出平台 VPC 范围')
                    nat = cfg.get('nat') or {}
                    snat = (nat.get('snat') or {}).get('enable')
                    if not isinstance(snat, bool):
                        raise ValueError('交换机缺少明确的 SNAT 配置')
                    dnat = []
                    for i, r in enumerate(nat.get('dnat') or []):
                        proto = str(r.get('protocol', '')).lower()
                        external, internal = (str(r.get('public_port', '')), str(r.get('private_port', '')))
                        if proto not in ('tcp', 'udp') or not (external.isdecimal() and internal.isdecimal() and (0 < int(external) < 65536) and (0 < int(internal) < 65536)):
                            raise ValueError('DNAT 包含平台不支持的协议或端口范围')
                        dnat.append(dict(key=f'{k}-dnat-{i}', targetHostId=r['client_id'], protocol=proto, externalPort=int(external), internalPort=int(internal)))
                    node.update(kind='switch', zoneKey=k, cidr=str(segment), purpose='lab', aclRules=switch_rules(cfg.get('acl') or [], k), nat=dict(snatEnabled=snat, dnatMappings=dnat))
                elif g == 'client':
                    cpu, memory = (b.get('cpu'), b.get('memory'))
                    if any((type(v) is not int or v < 1 for v in (cpu, memory))):
                        add('虚拟机缺少有效的 CPU 或内存配置')
                    if not allow_all(cfg.get('acl')):
                        add('平台不支持额外的虚拟机级 ACL')
                    if b.get('dns'):
                        add('主机 DNS 需要单独核对')
                    if (cfg.get('nat') or {}).get('dnat'):
                        add('平台不支持虚拟机级 NAT')
                    target = b.get('target') or {}
                    target_id = str(b.get('target_image_id') or target.get('id') or '')
                    image = images.get(target_id)
                    if b.get('target_image_id') and target.get('id') and (str(target['id']) != target_id):
                        add('墨攻镜像引用不一致')
                    if not image:
                        raise ValueError('墨攻镜像未找到' if target_id else '虚拟机未配置镜像')
                    if image['image_type'] != 'vm':
                        raise ValueError('容器节点无法用 ECS 等价运行')
                    if not image['active']:
                        raise ValueError('依赖镜像已停用')
                    if global_dns and image.get('system_type') != 'windows':
                        add('源全局 DNS 涉及非 Windows 主机，尚无等价转换')
                    image_id = image['external_resource_id']
                    if not isinstance(image_id, str) or not image_id.strip():
                        raise ValueError('墨攻未记录云镜像 ID')
                    actual = [a for a in assets[image_id] if a.get('enabled') and a.get('sourceSnapshotAvailable')]
                    if len(actual) == 1:
                        asset_id, display = (actual[0]['id'], actual[0]['displayName'])
                    elif not assets[image_id] and len(cloud[image_id]) == 1:
                        source_image = cloud[image_id][0]
                        asset_id = 'uncollected:' + image_id
                        display = source_image['sourceImageName']
                        dependencies[image_id] = {'imageId': image_id, 'snapshotId': source_image['id'], 'displayName': display}
                    else:
                        raise ValueError('云镜像未匹配、未启用或存在多个候选')
                    nics = []
                    for i, ni in enumerate(cfg.get('network') or []):
                        nk = f'{k}-nic-{i + 1}'
                        sw = ni['switch_id']
                        if byid.get(sw, {}).get('group') != 'exchange':
                            raise ValueError('网卡关联的交换机不存在')
                        if not isinstance(ni.get('security_group'), list):
                            raise ValueError('网卡缺少明确的安全组配置')
                        nics.append(dict(id=nk, switchId=sw, zoneKey=sw, privateIp=endpoint(ni.get('private_ip')), secondaryIps=[endpoint(v) for v in re.split('[\\s,，;]+', ni.get('secondary_ip') or '') if v], securityGroupRulesMode='custom', securityGroupRules=[rule(r, f'{nk}-sg-{j}', True) for j, r in enumerate(ni['security_group'])]))
                    if not nics:
                        raise ValueError('主机未配置网卡')
                    node.update(kind='ecs', zoneKey=nics[0]['zoneKey'], role='lab', privateIp=nics[0]['privateIp'], image=display, imageName=display, platformImageAssetId=asset_id, imageId=image_id, imageStrategy=dict(mode='fixed', imageId=image_id), instanceTypeStrategy=dict(mode='auto'), cpu=cpu, memory=memory, nics=nics, portGroups=[], initScript='', hostName=b.get('hostname') or '', instanceName=b.get('name') or label, bootPriority=b.get('startup_seq') or 0, bootWaitSeconds=b.get('startup_delay') or 0)
                    if dns_servers and image.get('system_type') == 'windows':
                        node['dns'] = {'servers': dns_servers, 'nicIds': [nic['id'] for nic in nics]}
                else:
                    continue
                nodes.append(node)
            except (ValueError, TypeError, KeyError) as e:
                message = str(e)
                add(message if any((ord(x) > 127 for x in message)) else '节点配置无效或不完整')
        for e in net.get('edges') or []:
            first, second = (e.get('from'), e.get('to'))
            source_type = byid.get(first, {}).get('group')
            dest_type = byid.get(second, {}).get('group')
            allowed = {('route', 'exchange'), ('exchange', 'client')}
            if (dest_type, source_type) in allowed:
                first, second = (second, first)
            elif (source_type, dest_type) not in allowed:
                add('源拓扑含平台不支持的连接类型')
                continue
            edges.append(dict(id=e['id'], fromNodeId=first, toNodeId=second, relationType='manual'))
        return (sorted(problems), {'schemaVersion': '2.0.0', 'nodes': nodes, 'edges': edges}, dependencies if not problems else {})
    plan = []
    for r in data['details']:
        reasons, topology, dependencies = graph(r)
        src = r['detail']
        user = src.get('create_user') or {}
        plan.append(dict(sourceId=src['id'], name=src['name'], author=user.get('name') or user.get('username') or '未知创建人', active=src['active'], reasons=reasons, dependencies=dependencies, payload={'name': src['name'], 'description': (src.get('description') or '') + f"\n\n来源：墨攻场景 #{src['id']}；原创建人：{user.get('name') or user.get('username') or '未知'}。", 'topologyGraph': topology} if not reasons else None))
    return plan
if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--scenarios', required=True, type=Path)
    parser.add_argument('--images', required=True, type=Path)
    parser.add_argument('--platform', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    read = lambda path: json.loads(path.read_text())
    plan = convert_scenarios(read(args.scenarios), read(args.images), read(args.platform))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open('w') as handle:
        json.dump(plan, handle, ensure_ascii=False, separators=(',', ':'))
    args.output.chmod(384)
    print(json.dumps({'source': len(plan), 'candidates': sum((item['payload'] is not None for item in plan))}))
