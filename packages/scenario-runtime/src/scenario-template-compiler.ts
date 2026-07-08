import type { CompiledProvisionSpec } from './compiled-provision-spec';
import type { ScenarioTemplateSpec } from './scenario-template-spec';

export function compileScenarioTemplateSpec(template: ScenarioTemplateSpec): CompiledProvisionSpec {
  const imagePolicies = Object.fromEntries(
    template.runtimePreferences.imagePolicies.map((policy) => [policy.key, policy]),
  );
  const instanceTypePolicies = Object.fromEntries(
    template.runtimePreferences.instanceTypePolicies.map((policy) => [policy.key, policy]),
  );
  const bootstrapScripts = template.bootstrap.scripts.map((script) => ({
    key: script.key,
    name: script.name,
    type: script.type,
    content: script.content,
    targetHostKeys: template.hosts
      .filter((host) => host.bootstrapRef === script.key)
      .map((host) => host.key),
  }));

  return {
    schemaVersion: '1.0.0',
    identity: {
      templateSlug: template.metadata.slug,
      templateVersion: template.metadata.version,
      cloudProvider: template.metadata.cloudProvider,
      iacType: template.metadata.iacType,
    },
    topology: {
      vpcCidr: template.topology.vpcCidr,
      entryHostKey: template.topology.entryHostKey,
    },
    networkZones: template.networkZones.map((zone) => ({
      key: zone.key,
      name: zone.name,
      cidr: zone.cidr,
      purpose: zone.purpose,
      isPublicEntry: Boolean(zone.isPublicEntry),
      routeRole: zone.routeRole ?? (zone.isPublicEntry ? 'entry' : 'internal'),
      natGatewayKey: zone.natGatewayKey ?? zone.snat?.natGatewayKey,
    })),
    hosts: template.hosts.map((host) => ({
      key: host.key,
      name: host.name,
      role: host.role,
      zoneKey: host.zoneKey,
      primaryPrivateIp: host.primaryPrivateIp,
      exposePublic: Boolean(host.exposePublic),
      accountPreset: host.accountPreset
        ? {
            username: host.accountPreset.username,
            password: host.accountPreset.password,
          }
        : undefined,
      networkInterfaces:
        host.networkInterfaces?.map((networkInterface) => ({
          deviceIndex: networkInterface.deviceIndex,
          zoneKey: networkInterface.zoneKey,
          privateIp: networkInterface.privateIp,
          description: networkInterface.description,
        })) ?? [{ deviceIndex: 0, zoneKey: host.zoneKey, privateIp: host.primaryPrivateIp }],
      bootstrapScriptKey: host.bootstrapRef,
      imagePolicyKey: host.imagePolicyRef,
      instanceTypePolicyKey: host.instanceTypePolicyRef,
      tags: host.tags,
    })),
    natGateways: template.nat.natGateways.map((gateway) => ({
      key: gateway.key,
      name: gateway.name,
      zoneKey: gateway.zoneKey,
    })),
    eips: template.nat.eips.map((eip) => ({
      key: eip.key,
      name: eip.name,
      bindTargetType: eip.bindTargetType,
      bindTargetKey: eip.bindTargetKey,
      bandwidthMbps: eip.bandwidthMbps,
    })),
    snatEntries: template.networkZones
      .filter((zone) => zone.snat?.enabled && zone.snat.natGatewayKey && zone.snat.eipKey)
      .map((zone) => ({
        key: `snat-${zone.key}`,
        zoneKey: zone.key,
        natGatewayKey: zone.snat!.natGatewayKey!,
        eipKey: zone.snat!.eipKey!,
      })),
    dnatEntries: template.hosts.flatMap((host) =>
      (host.dnat?.enabled ? host.dnat.mappings ?? [] : []).map((mapping) => ({
        key: `dnat-${host.key}-${mapping.externalPort}`,
        hostKey: host.key,
        natGatewayKey: host.dnat?.natGatewayKey ?? '',
        eipKey: host.dnat?.eipKey ?? '',
        protocol: mapping.protocol,
        externalPort: mapping.externalPort,
        internalPort: mapping.internalPort,
      })),
    ),
    securityGroupRules: [
      ...(template.access.securityGroupRules ?? []).map((rule) => ({
        key: rule.key,
        targetHostKey: rule.targetHostKey,
        direction: rule.direction,
        protocol: rule.protocol,
        portRange: rule.portRange,
        sourceCidr: rule.sourceCidr,
        policy: rule.policy,
        priority: rule.priority ?? 1,
      })),
      ...template.hosts.flatMap((host) =>
        (host.portGroupRefs ?? []).flatMap((ref) => {
          const portGroup = template.access.portGroups.find((candidate) => candidate.key === ref);
          if (!portGroup) {
            return [];
          }
          return portGroup.rules.map((rule, index) => ({
            key: `${host.key}-${portGroup.key}-${index + 1}`,
            targetHostKey: host.key,
            direction: 'ingress' as const,
            protocol: rule.protocol,
            portRange: rule.portRange,
            sourceCidr: rule.sourceCidr,
            policy: 'accept' as const,
            priority: 1,
            derivedFromPortGroupKey: portGroup.key,
          }));
        }),
      ),
    ],
    aclRules: (template.access.aclRules ?? []).map((rule) => ({
      key: rule.key,
      zoneKey: rule.zoneKey,
      direction: rule.direction,
      protocol: rule.protocol,
      portRange: rule.portRange,
      sourceCidr: rule.sourceCidr,
      policy: rule.policy,
      priority: rule.priority ?? 1,
    })),
    bootstrapScripts,
    runtimeSelections: {
      imagePolicies,
      instanceTypePolicies,
    },
  };
}
