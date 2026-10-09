import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fixturePlan, persistSuccessfulApply } from './opentofu-state-fixture';
import { OpenTofuRangeProvisioner } from '../src/provisioning/open-tofu-range-provisioner';

describe('range persisted state source-account proof', () => {
  let dir: string;
  beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'range-state-account-')); await fs.mkdir(path.join(dir, 'fixture')); });
  afterEach(async () => { await fs.rm(dir, { force: true, recursive: true }); });
  it.each(['missing', 'different UID', 'different context', 'matching'])('inspects resources only when the account evidence is %s', async scenario => {
    const tags = { RangeInstanceId: 'fixture', CloudAccountUid: 'uid-source', CloudAccountContextId: 'context-source' } as Record<string,string>;
    if (scenario === 'missing') delete tags.CloudAccountUid;
    if (scenario === 'different UID') tags.CloudAccountUid = 'uid-other';
    if (scenario === 'different context') tags.CloudAccountContextId = 'context-other';
    await fs.writeFile(path.join(dir,'fixture','terraform.tfstate'), JSON.stringify({ version: 4, lineage: 'fixture-lineage', serial: 1, resources: [
      { module: 'module.range', mode: 'managed', type: 'alicloud_instance', name: 'hosts', instances: [{ index_key: 'entry', attributes: { id: 'i-owned', system_disk_id: 'd-owned', tags } }] },
    ] }));
    const provisioner = new OpenTofuRangeProvisioner({ workspacesRootDir: dir });
    const result = provisioner.inspectResources({ rangeInstanceId: 'fixture', templateModulePath: 'fixture', allocatedCidr: null, requirePersistedState: true,
      billingTags: { CloudAccountUid: 'uid-source', CloudAccountContextId: 'context-source' } });
    if (scenario === 'matching') expect(await result).toMatchObject({ hostIds: { 'entry': 'i-owned' }, systemDiskIds: { 'entry': 'd-owned' } });
    else await expect(result).rejects.toThrow('source account');
  });
  it.each([false,true])('keeps verified state IDs when outputs omit them and rejects conflicting outputs: conflict=%s', async conflict => {
    const workspaceDir = path.join(dir, 'fixture');
    const runner = { init: jest.fn().mockResolvedValue({}), plan: jest.fn().mockResolvedValue({}),
      showPlan: jest.fn().mockResolvedValue(fixturePlan), apply: jest.fn(persistSuccessfulApply),
      output: jest.fn().mockResolvedValue({ resource_summary: { value: conflict ? { host_ids: { entry: 'i-foreign' } } : {} } }), destroy: jest.fn() };
    const provisioner = new OpenTofuRangeProvisioner({ runner: runner as any, workspacesRootDir: dir });
    jest.spyOn(provisioner as any, 'prepareWorkspace').mockResolvedValue({ workspaceDir, planFilePath: path.join(workspaceDir,'plan'), outputsFilePath: path.join(workspaceDir,'outputs.json'), varsFilePath: path.join(workspaceDir,'vars.json'), runnerEnv: {} });
    jest.spyOn(provisioner, 'inspectResources').mockResolvedValue({ mode: 'opentofu', hostIds: { entry: 'i-owned' }, systemDiskIds: { entry: 'd-owned' }, natGatewayIds: { nat: 'ngw-owned' }, eipAllocationIds: { dnat: 'eip-owned' } });
    const result = provisioner.create({ rangeInstanceId: 'fixture', templateModulePath: 'fixture', allocatedCidr: null, topologySpec: {
      vpcCidr: '10.0.0.0/16', networkZones: [{ key: 'dmz', name: 'DMZ', purpose: 'entry', cidr: '10.0.1.0/24' }],
      hosts: [{ key: 'entry', name: 'Entry', zoneKey: 'dmz', role: 'entry', privateIp: '10.0.1.10' }], publicEntry: { hostKey: 'entry', protocols: [{ protocol: 'ssh', port: 22 }] },
    } });
    if (conflict) await expect(result).rejects.toThrow('outputs conflict');
    else expect((await result).resourceSummary).toMatchObject({ hostIds: { entry: 'i-owned' }, systemDiskIds: { entry: 'd-owned' }, natGatewayIds: { nat: 'ngw-owned' }, eipAllocationIds: { dnat: 'eip-owned' } });
  });

});
