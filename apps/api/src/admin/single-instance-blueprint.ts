import {
  compileScenarioTemplateSpec,
  resolvePreferredInstanceTypes,
} from '../../../../packages/scenario-runtime/src';
import type { ScenarioTemplateSpec } from '../../../../packages/scenario-runtime/src';

import type { PlatformImageAssetRecord } from './admin.repository';

type BuildSingleInstanceBlueprintInput = {
  name: string;
  hostKey: string;
  hostName: string;
  privateIp: string;
  password: string;
  cpu: number;
  memory: number;
  image: PlatformImageAssetRecord;
  regionId: string;
  zoneId: string;
  vpcCidr: string;
  zoneKey: string;
  zoneCidr: string;
};

export function buildSingleInstanceBlueprint(input: BuildSingleInstanceBlueprintInput) {
  const instanceTypePolicyKey = `${input.hostKey}-instance-type`;
  const imagePolicyKey = `${input.hostKey}-image`;
  const runtimeScenarioTemplateSpec: ScenarioTemplateSpec = {
    schemaVersion: '1.0.0',
    metadata: {
      name: input.name,
      slug: input.name,
      version: 'single-instance',
      cloudProvider: 'alibaba_cloud',
      iacType: 'opentofu',
      description: `Single instance runtime for ${input.name}`,
    },
    topology: {
      vpcCidr: input.vpcCidr,
      entryHostKey: input.hostKey,
      defaultRegion: input.regionId,
      defaultZoneId: input.zoneId,
    },
    networkZones: [
      {
        key: input.zoneKey,
        name: input.zoneKey,
        purpose: 'single-instance',
        cidr: input.zoneCidr,
        isPublicEntry: true,
        routeRole: 'entry',
      },
    ],
    hosts: [
      {
        key: input.hostKey,
        name: input.hostName,
        role: 'entry',
        zoneKey: input.zoneKey,
        primaryPrivateIp: input.privateIp,
        exposePublic: true,
        image: input.image.imageId,
        portGroupRefs: ['default-admin'],
        imagePolicyRef: imagePolicyKey,
        instanceTypePolicyRef: instanceTypePolicyKey,
        accountPreset: {
          username: 'root',
          password: input.password,
        },
      },
    ],
    nat: {
      natGateways: [],
      eips: [],
    },
    access: {
      portGroups: [
        {
          key: 'default-admin',
          name: 'Default Admin Access',
          rules: [
            { protocol: 'tcp', portRange: '22/22', sourceCidr: '0.0.0.0/0' },
            { protocol: 'tcp', portRange: '3389/3389', sourceCidr: '0.0.0.0/0' },
          ],
        },
      ],
    },
    bootstrap: {
      scripts: [],
    },
    runtimePreferences: {
      imagePolicies: [
        {
          key: imagePolicyKey,
          mode: 'fixed',
          imageId: input.image.imageId,
        },
      ],
      instanceTypePolicies: [
        {
          key: instanceTypePolicyKey,
          mode: 'prefer-list',
          preferredInstanceTypes: [...resolvePreferredInstanceTypes(input.cpu, input.memory)],
        },
      ],
    },
    extensions: {
      singleInstance: true,
    },
  };

  return {
    runtimeScenarioTemplateSpec,
    runtimeCompiledProvisionSpec: compileScenarioTemplateSpec(runtimeScenarioTemplateSpec),
    runtimeTopologyGraph: {
      schemaVersion: '1.0.0',
      nodes: [
        {
          id: input.zoneKey,
          kind: 'network-zone',
          data: {
            key: input.zoneKey,
            cidr: input.zoneCidr,
          },
        },
        {
          id: input.hostKey,
          kind: 'host',
          data: {
            key: input.hostKey,
            name: input.hostName,
            privateIp: input.privateIp,
            imageId: input.image.imageId,
            cpu: input.cpu,
            memory: input.memory,
          },
        },
      ],
      edges: [
        {
          id: `${input.zoneKey}->${input.hostKey}`,
          source: input.zoneKey,
          target: input.hostKey,
          kind: 'attached-to',
        },
      ],
      templateMeta: {
        singleInstance: true,
      },
    },
  };
}
