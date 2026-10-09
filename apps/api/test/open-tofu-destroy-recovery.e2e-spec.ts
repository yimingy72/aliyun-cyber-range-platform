import { fixturePlan } from './opentofu-state-fixture';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { OpenTofuRangeProvisioner } from '../src/provisioning/open-tofu-range-provisioner';
import type { RangeProvisionStepEvent } from '../src/provisioning/provisioning.types';

const instanceId = 'range-destroy-recovery';
const runtimeConfig = {
  accessKeyId: 'test-ak', accessKeySecret: 'test-sk',
  defaultRegion: 'cn-hangzhou', defaultZoneId: 'cn-hangzhou-h',
};
const input = {
  rangeInstanceId: instanceId, templateModulePath: 'infra/missing-current-module',
  allocatedCidr: null, runtimeConfig,
};
const savedFiles = {
  'main.tf': 'provider "alicloud" {}\n',
  'variables.tf': 'variable "zone_id" { type = string }\n',
  'outputs.tf': 'output "original" { value = "saved" }\n',
  'versions.tf': 'terraform { required_version = ">= 1.8.0" }\n',
  'range.auto.tfvars.json': '{"zone_id":"cn-hangzhou-original","instance_type":"ecs.saved.large"}\n',
  'terraform.tfstate': '{"version":4,"lineage":"test-lineage","serial":1,"resources":[]}\n',
};

describe('OpenTofu persisted destroy recovery', () => {
  afterEach(() => jest.restoreAllMocks());

  async function fixture() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'range-destroy-recovery-'));
    const workspacesRootDir = path.join(root, 'workspaces');
    const workspaceDir = path.join(workspacesRootDir, instanceId);
    await fs.mkdir(workspaceDir, { recursive: true });
    const runner = {
      init: jest.fn().mockResolvedValue({ stdout: 'init ok', stderr: '' }),
      validate: jest.fn().mockResolvedValue({ stdout: 'validate ok', stderr: '' }),
      plan: jest.fn().mockResolvedValue({ stdout: 'plan ok', stderr: '' }),
      apply: jest.fn(), output: jest.fn(), showPlan: jest.fn().mockResolvedValue(fixturePlan),
      destroy: jest.fn().mockResolvedValue({ stdout: 'destroy ok', stderr: '' }),
    };
    const instanceTypeResolver = jest.fn().mockRejectedValue(new Error('No saleable ECS instance type'));
    const imageResolver = jest.fn().mockRejectedValue(new Error('Image catalog unavailable'));
    const cloudRequest = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No cloud lookup allowed'));
    const options = {
      runner, projectRootDir: root, workspacesRootDir,
      availableInstanceTypeResolver: instanceTypeResolver, availableImageIdResolver: imageResolver,
      env: { OPENTOFU_INSTANCE_TYPE: 'auto' },
    };
    const provisioner = new OpenTofuRangeProvisioner(options);
    const writeSavedFiles = () => Promise.all(Object.entries(savedFiles).map(([file, content]) =>
      fs.writeFile(path.join(workspaceDir, file), content, 'utf8')));
    const assertNoLookup = () => {
      expect(instanceTypeResolver).not.toHaveBeenCalled();
      expect(imageResolver).not.toHaveBeenCalled();
      expect(cloudRequest).not.toHaveBeenCalled();
    };
    return { root, workspaceDir, runner, options, provisioner, writeSavedFiles, assertNoLookup };
  }

  it('destroys with the exact saved configuration while all catalogs and the current module are unavailable', async () => {
    const f = await fixture(); await f.writeSavedFiles();
    const events: RangeProvisionStepEvent[] = [];
    await f.provisioner.destroy({ ...input, reportStep: async event => { events.push(event); } });
    expect(f.runner.init).toHaveBeenCalledWith(expect.objectContaining({ workspaceDir: f.workspaceDir }));
    expect(f.runner.destroy).toHaveBeenCalledWith(expect.objectContaining({
      workspaceDir: f.workspaceDir, varsFilePath: path.join(f.workspaceDir, 'range.auto.tfvars.json'),
    }));
    for (const [file, content] of Object.entries(savedFiles)) {
      expect(await fs.readFile(path.join(f.workspaceDir, file), 'utf8')).toBe(content);
    }
    expect(events.map(event => [event.stepName, event.status])).toEqual([
      ['render_template', 'running'], ['render_template', 'succeeded'],
      ['tofu_init', 'running'], ['tofu_init', 'succeeded'],
      ['destroy', 'running'], ['destroy', 'succeeded'],
    ]);
    expect(f.runner.validate).not.toHaveBeenCalled();
    f.assertNoLookup();
  });

  it.each(['main.tf', 'variables.tf', 'outputs.tf', 'versions.tf', 'range.auto.tfvars.json'])(
    'refuses to guess %s when state already exists', async file => {
      const f = await fixture(); await f.writeSavedFiles(); await fs.unlink(path.join(f.workspaceDir, file));
      await expect(f.provisioner.destroy(input)).rejects.toThrow('Persisted OpenTofu destroy configuration is missing');
      expect(await fs.readFile(path.join(f.workspaceDir, 'terraform.tfstate'), 'utf8')).toBe(savedFiles['terraform.tfstate']);
      expect(f.runner.init).not.toHaveBeenCalled(); expect(f.runner.destroy).not.toHaveBeenCalled(); f.assertNoLookup();
    },
  );

  it.each(['.range-apply-started', 'terraform.tfstate.backup', 'errored.tfstate'])(
    'does not report cleanup success when only %s remains', async file => {
      const f = await fixture(); await fs.writeFile(path.join(f.workspaceDir, file), 'retained evidence');
      await expect(f.provisioner.destroy(input)).rejects.toThrow('OpenTofu state recovery is required');
      expect(await fs.readFile(path.join(f.workspaceDir, file), 'utf8')).toBe('retained evidence');
      expect(f.runner.destroy).not.toHaveBeenCalled(); f.assertNoLookup();
    },
  );

  it('rejects errored recovery state even if the main state exists', async () => {
    const f = await fixture(); await f.writeSavedFiles(); await fs.writeFile(path.join(f.workspaceDir, 'errored.tfstate'), 'newer recovery state');
    await expect(f.provisioner.destroy(input)).rejects.toThrow('OpenTofu state recovery is required');
    expect(f.runner.destroy).not.toHaveBeenCalled(); f.assertNoLookup();
  });

  it.each(['', 'broken state', '{"version":4}', '{"version":3,"resources":[]}'])(
    'rejects incomplete or unsupported main state %s instead of claiming resources are absent', async state => {
      const f = await fixture(); await f.writeSavedFiles();
      await fs.writeFile(path.join(f.workspaceDir, 'terraform.tfstate'), state);
      await fs.writeFile(path.join(f.workspaceDir, '.range-apply-started'), '');
      await expect(f.provisioner.destroy(input)).rejects.toThrow('OpenTofu state recovery is required');
      expect(await fs.readFile(path.join(f.workspaceDir, 'terraform.tfstate'), 'utf8')).toBe(state);
      expect(f.runner.destroy).not.toHaveBeenCalled(); f.assertNoLookup();
    },
  );

  it('rejects a directory in place of the main state', async () => {
    const f = await fixture(); await fs.mkdir(path.join(f.workspaceDir, 'terraform.tfstate'));
    await expect(f.provisioner.destroy(input)).rejects.toThrow('OpenTofu state recovery is required');
    expect(f.runner.destroy).not.toHaveBeenCalled(); f.assertNoLookup();
  });

  it('is a safe no-op when creation never reached apply and no state exists', async () => {
    const f = await fixture(); await fs.writeFile(path.join(f.workspaceDir, 'main.tf'), savedFiles['main.tf']);
    await f.provisioner.destroy(input);
    expect(f.runner.init).not.toHaveBeenCalled(); expect(f.runner.destroy).not.toHaveBeenCalled();
    expect(await fs.readFile(path.join(f.workspaceDir, 'main.tf'), 'utf8')).toBe(savedFiles['main.tf']); f.assertNoLookup();
  });

  const topologySpec = {
    vpcCidr: '10.0.0.0/16',
    networkZones: [{ key: 'dmz', name: 'DMZ', purpose: 'public-entry', cidr: '10.0.10.0/24' }],
    hosts: [{ key: 'entry', name: 'Entry', zoneKey: 'dmz', role: 'entry', privateIp: '10.0.10.10' }],
    publicEntry: { hostKey: 'entry', protocols: [{ protocol: 'ssh', port: 22 }] },
  };

  it.each(['terraform.tfstate', 'terraform.tfstate.backup', 'errored.tfstate', '.range-apply-started'])(
    'does not replace a fresh-create workspace containing %s', async file => {
      const f = await fixture(); await fs.mkdir(path.join(f.root, 'infra/module'), { recursive: true });
      await fs.writeFile(path.join(f.workspaceDir, file), 'retained evidence');
      await expect(f.provisioner.create({ ...input, templateModulePath: 'infra/module', topologySpec })).rejects.toThrow('Cannot replace an OpenTofu workspace');
      expect(await fs.readFile(path.join(f.workspaceDir, file), 'utf8')).toBe('retained evidence'); f.assertNoLookup();
    },
  );

  it.each(['terraform.tfstate.backup', 'errored.tfstate', '.range-apply-started', 'empty-main-state'])(
    'refuses to apply again when recovering a workspace with %s', async file => {
      const f = await fixture(); await fs.mkdir(path.join(f.root, 'infra/module'), { recursive: true });
      const evidencePath = path.join(f.workspaceDir, file === 'empty-main-state' ? 'terraform.tfstate' : file);
      const evidence = file === 'empty-main-state' ? '' : 'retained recovery evidence';
      await fs.writeFile(evidencePath, evidence);
      await expect(f.provisioner.create({ ...input, templateModulePath: 'infra/module', topologySpec,
        preserveWorkspaceState: true,
      })).rejects.toThrow('OpenTofu state recovery is required');
      expect(await fs.readFile(evidencePath, 'utf8')).toBe(evidence);
      expect(f.runner.apply).not.toHaveBeenCalled(); f.assertNoLookup();
    },
  );

  it('persists apply-attempt evidence before invoking apply and reuses partial state for compensation', async () => {
    const f = await fixture(); await fs.mkdir(path.join(f.root, 'infra/module'), { recursive: true });
    const onApplyStart = jest.fn(async () => undefined);
    f.runner.apply.mockImplementation(async () => {
      expect(onApplyStart).toHaveBeenCalledTimes(1);
      expect(JSON.parse(await fs.readFile(path.join(f.workspaceDir, '.range-apply-started'), 'utf8')).addresses).toEqual(['terraform_data.fixture']);
      await fs.writeFile(path.join(f.workspaceDir, 'terraform.tfstate'), savedFiles['terraform.tfstate']);
      throw new Error('apply failed after partial state');
    });
    const create = new OpenTofuRangeProvisioner({ ...f.options, env: {
      OPENTOFU_INSTANCE_TYPE: 'ecs.saved.large', OPENTOFU_IMAGE_ID: 'mock.vhd',
    } });
    await expect(create.create({ ...input, templateModulePath: 'infra/module', topologySpec,
      onApplyStart,
      runtimeCredentials: { entry: { username: 'root', password: 'TestPassword123!' } },
    })).rejects.toThrow('apply failed after partial state');
    const originalVars = await fs.readFile(path.join(f.workspaceDir, 'range.auto.tfvars.json'), 'utf8');
    await expect(f.provisioner.destroy(input)).rejects.toThrow('previous apply outcome is unknown');
    expect(f.runner.destroy).toHaveBeenCalled();
    expect(await fs.readFile(path.join(f.workspaceDir, 'range.auto.tfvars.json'), 'utf8')).toBe(originalVars); f.assertNoLookup();
  });
});

it('returns only owned whitelisted resource IDs for partial-state cleanup and billing', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'range-inspect-'));
  const dir = path.join(root, instanceId);
  await fs.mkdir(dir);
  const make = (type: string, name: string, id: string, extra = {}) => ({ module: 'module.range', type, name, mode: 'managed', instances: [{ index_key: 'entry', attributes: { id, tags: { range_instance_id: instanceId }, password: 'never-return-this', ...extra } }] });
  const state = { version: 4, lineage: 'inspection', serial: 2, resources: [
    make('alicloud_instance', 'hosts', 'i-known', { system_disk_id: 'd-known' }),
    make('alicloud_eip_address', 'addresses', 'eip-known'),
  ] };
  await fs.writeFile(path.join(dir, 'terraform.tfstate'), JSON.stringify(state));
  await fs.writeFile(path.join(dir, '.range-apply-started'), 'unknown old attempt');
  const provisioner = new OpenTofuRangeProvisioner({ workspacesRootDir: root });
  const summary = await provisioner.inspectResources(input);
  expect(summary).toMatchObject({ hostIds: { entry: 'i-known' }, systemDiskIds: { entry: 'd-known' }, eipAllocationIds: { entry: 'eip-known' } });
  expect(JSON.stringify(summary)).not.toContain('never-return-this');
  const oldCopies = [1, 2].map(index => ({ ...structuredClone(state.resources[0].instances[0]), deposed: `old-${index}`, attributes: { ...state.resources[0].instances[0].attributes, id: `i-old-${index}`, system_disk_id: `d-old-${index}` } }));
  state.resources[0].instances.push(...oldCopies);
  await fs.writeFile(path.join(dir, 'terraform.tfstate'), JSON.stringify(state));
  const withReplacements = await provisioner.inspectResources(input);
  expect(Object.values(withReplacements!.hostIds!)).toEqual(['i-known', 'i-old-1', 'i-old-2']);
  expect(Object.values(withReplacements!.systemDiskIds!)).toEqual(['d-known', 'd-old-1', 'd-old-2']);
  state.resources[0].instances[0].attributes.tags.range_instance_id = 'another-range';
  await fs.writeFile(path.join(dir, 'terraform.tfstate'), JSON.stringify(state));
  await expect(provisioner.inspectResources(input)).rejects.toThrow('ownership');
  await fs.rm(root, { recursive: true, force: true });
});
