import 'reflect-metadata';

import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';

import { CreateRangeTemplateDto } from '../src/admin/dto/range-template.dto';

describe('CreateRangeTemplateDto', () => {
  it('accepts an optional topologySpec hostName field', () => {
    const dto = plainToInstance(CreateRangeTemplateDto, {
      name: '企业攻防靶场',
      topologySpec: {
        vpcCidr: '10.0.0.0/16',
        networkZones: [
          {
            key: 'core',
            name: 'Core',
            purpose: 'business-zone',
            cidr: '10.0.0.0/24',
          },
        ],
        hosts: [
          {
            key: 'ecs-1',
            name: 'ECS 1',
            hostName: 'ecs-1',
            zoneKey: 'core',
            role: 'entry',
            privateIp: '10.0.0.10',
            exposePublic: true,
          },
        ],
        publicEntry: {
          hostKey: 'ecs-1',
          protocols: [{ protocol: 'ssh', port: 22 }],
        },
      },
      topologyGraph: {},
      scenarioTemplateSpec: {},
      compiledProvisionSpec: {},
      compiledSpec: {},
    });

    expect(validateSync(dto)).toEqual([]);
  });
});
