import { BadRequestException } from '@nestjs/common';
import { isAlibabaCloudPortRange } from '../provisioning/alibaba-cloud-port-range';

export function validateRangeInstanceDraftPayload(input: {
  draftTopologyGraph: Record<string, unknown>;
  draftScenarioTemplateSpec: Record<string, unknown>;
  draftCompiledProvisionSpec: Record<string, unknown>;
}) {
  if (!isPlainObject(input.draftTopologyGraph)) {
    throw new BadRequestException('draftTopologyGraph must be a plain object');
  }

  if (!isPlainObject(input.draftScenarioTemplateSpec)) {
    throw new BadRequestException('draftScenarioTemplateSpec must be a plain object');
  }

  if (!isPlainObject(input.draftCompiledProvisionSpec)) {
    throw new BadRequestException('draftCompiledProvisionSpec must be a plain object');
  }

  const nodes = input.draftTopologyGraph.nodes;

  if (!Array.isArray(nodes)) {
    throw new BadRequestException('draftTopologyGraph.nodes must be an array');
  }

  for (const value of nodes) {
    if (!isPlainObject(value)) {
      continue;
    }

    if (value.kind === 'ecs') {
      assertEcsPrimaryIpIsSynchronized(value);
      assertNetworkRulePortRanges(value.nics, '安全组', 'securityGroupRules');
      assertNetworkRulePortRanges(value.portGroups, '端口组');
    }

    if (value.kind === 'switch') {
      assertNetworkRulePortRanges(value.aclRules, 'ACL');
    }
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function assertEcsPrimaryIpIsSynchronized(node: Record<string, unknown>) {
  const nics = node.nics;
  const primaryPrivateIp = typeof node.privateIp === 'string' ? node.privateIp.trim() : '';

  if (!Array.isArray(nics) || !isPlainObject(nics[0])) {
    throw new BadRequestException(`ECS ${String(node.id ?? '')} must include a primary NIC`);
  }

  const nicPrivateIp = typeof nics[0].privateIp === 'string' ? nics[0].privateIp.trim() : '';

  if (!primaryPrivateIp || primaryPrivateIp !== nicPrivateIp) {
    throw new BadRequestException(`ECS ${String(node.id ?? '')} primary private IP must match its first NIC`);
  }
}

function assertNetworkRulePortRanges(value: unknown, ruleType: string, nestedRulesKey?: string) {
  if (!Array.isArray(value)) {
    return;
  }

  for (const item of value) {
    if (!isPlainObject(item)) {
      continue;
    }

    const rules = nestedRulesKey ? item[nestedRulesKey] : [item];

    if (!Array.isArray(rules)) {
      continue;
    }

    for (const rule of rules) {
      if (!isPlainObject(rule)) {
        continue;
      }

      const portRange = typeof rule.portRange === 'string' ? rule.portRange : '';
      const protocol = typeof rule.protocol === 'string' ? rule.protocol : '';

      if (!isAlibabaCloudPortRange(portRange, protocol)) {
        throw new BadRequestException(`${ruleType} port range is invalid: ${String(rule.key ?? '')}`);
      }
    }
  }
}
