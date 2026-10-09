import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { OpenTofuRunner } from '@aliyun-cyber-range/iac-runner';
import { APPLY_PENDING_FILE, assertWorkspaceCanApply, readWorkspaceState, recordApplyPlan, completeApply, hasUnresolvedApply, assertDestroyComplete } from '../src/provisioning/opentofu-state-evidence';
import { fixturePlan, fixtureState } from './opentofu-state-fixture';

describe('persisted apply evidence', () => {
  let dir: string;
  beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tofu-evidence-')); });
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });
  const write = (dir: string, state: unknown) => fs.writeFile(path.join(dir, 'terraform.tfstate'), JSON.stringify(state));

  it.each(['no-state', 'empty', 'partial', 'tainted', 'deposed'])('blocks retry after an unknown apply with %s state', async scenario => {
    await recordApplyPlan(dir, { planned_values: { root_module: { resources: [
      ...fixturePlan.planned_values.root_module.resources, { mode: 'managed', address: 'terraform_data.second' },
    ] } } });
    if (scenario !== 'no-state') {
      const state = structuredClone(fixtureState) as any;
      if (scenario === 'empty') state.resources = [];
      if (scenario === 'tainted') state.resources[0].instances[0].status = 'tainted';
      if (scenario === 'deposed') state.resources[0].instances[0].deposed = 'old';
      await write(dir, state);
    }
    await expect(assertWorkspaceCanApply(dir)).rejects.toThrow('recovery is required');
    await expect(completeApply(dir)).rejects.toThrow('recovery is required');
    expect(await fs.readFile(path.join(dir, APPLY_PENDING_FILE), 'utf8')).toContain('terraform_data.second');
  });

  it('allows a failed command with fully persisted final resources to recover without discarding state', async () => {
    await recordApplyPlan(dir, fixturePlan);
    await write(dir, fixtureState);
    await expect(assertWorkspaceCanApply(dir)).resolves.toMatchObject({ lineage: 'test-lineage' });
    await completeApply(dir);
    await expect(fs.stat(path.join(dir, APPLY_PENDING_FILE))).rejects.toThrow();
    await fs.rm(path.join(dir, 'terraform.tfstate'));
    await expect(assertWorkspaceCanApply(dir)).rejects.toThrow('recovery is required');
  });

  it('does not mistake a replacement old ID for a completed replacement when the new create response was lost', async () => {
    await write(dir, fixtureState);
    await recordApplyPlan(dir, fixturePlan);
    await expect(assertWorkspaceCanApply(dir)).rejects.toThrow('recovery is required');
    const replaced = structuredClone(fixtureState);
    replaced.resources[0].instances[0].attributes.id = 'new-fixture-id';
    await write(dir, replaced);
    await expect(completeApply(dir)).resolves.toBeUndefined();
  });

  it('uses the database apply flag when the whole workspace was lost', async () => {
    await expect(readWorkspaceState(dir, true)).rejects.toThrow('recovery is required');
    await expect(assertWorkspaceCanApply(dir, true)).rejects.toThrow('recovery is required');
  });

  it.each(['empty', 'invalid', 'wrong-lineage', 'retained-resource', 'serial-backward'])('refuses false destroy success for %s state', async scenario => {
    await write(dir, fixtureState);
    const prior = (await readWorkspaceState(dir))!;
    const state = { ...fixtureState, serial: 2, resources: [] } as any;
    if (scenario === 'empty') await fs.writeFile(path.join(dir, 'terraform.tfstate'), '');
    else if (scenario === 'invalid') await write(dir, { version: 4 });
    else {
      if (scenario === 'wrong-lineage') state.lineage = 'other';
      if (scenario === 'retained-resource') state.resources = fixtureState.resources;
      if (scenario === 'serial-backward') state.serial = 0;
      await write(dir, state);
    }
    await expect(assertDestroyComplete(dir, prior, false)).rejects.toThrow();
  });

  it('retains unresolved apply evidence after known resources have been destroyed', async () => {
    await recordApplyPlan(dir, fixturePlan);
    await write(dir, { ...fixtureState, resources: [] });
    const prior = (await readWorkspaceState(dir))!;
    expect(await hasUnresolvedApply(dir, prior)).toBe(true);
    await expect(assertDestroyComplete(dir, prior, true)).rejects.toThrow('outcome is unknown');
    await expect(fs.stat(path.join(dir, APPLY_PENDING_FILE))).resolves.toBeDefined();
  });

  it('treats the old empty apply marker as unresolved', async () => {
    await write(dir, fixtureState);
    await fs.writeFile(path.join(dir, APPLY_PENDING_FILE), '');
    await expect(assertWorkspaceCanApply(dir)).rejects.toThrow('recovery is required');
  });

  it('reads actual OpenTofu plan/state and verifies a destroy using only local terraform_data', async () => {
    await fs.writeFile(path.join(dir, 'main.tf'), 'resource "terraform_data" "one" { input = "local-only" }\nresource "terraform_data" "two" { input = "local-only" }\n');
    const runner = new OpenTofuRunner();
    const options = { workspaceDir: dir };
    await runner.init(options);
    const planFilePath = path.join(dir, 'plan');
    await runner.plan({ ...options, planFilePath });
    await recordApplyPlan(dir, await runner.showPlan({ ...options, planFilePath }));
    await runner.apply({ ...options, planFilePath });
    await completeApply(dir);
    const prior = (await readWorkspaceState(dir, true))!;
    expect(prior.instances).toHaveLength(2);
    await runner.destroy(options);
    await expect(assertDestroyComplete(dir, prior, false)).resolves.toBeUndefined();
  }, 30000);
  it('blocks blind retry after a real failed provisioner, destroys tracked local resources and retains uncertainty', async () => {
    await fs.writeFile(path.join(dir, 'main.tf'), `resource "terraform_data" "broken" {
  provisioner "local-exec" { command = "exit 1" }
}
`);
    const runner = new OpenTofuRunner();
    const options = { workspaceDir: dir };
    const planFilePath = path.join(dir, 'plan');
    await runner.init(options);
    await runner.plan({ ...options, planFilePath });
    await recordApplyPlan(dir, await runner.showPlan({ ...options, planFilePath }));
    await expect(runner.apply({ ...options, planFilePath })).rejects.toThrow();
    await expect(assertWorkspaceCanApply(dir)).rejects.toThrow('recovery is required');
    const prior = (await readWorkspaceState(dir, true))!;
    expect(prior.instances.some(instance => instance.tainted)).toBe(true);
    await runner.destroy(options);
    await expect(assertDestroyComplete(dir, prior, true)).rejects.toThrow('outcome is unknown');
    expect((await readWorkspaceState(dir, true))!.instances).toEqual([]);
    await expect(fs.stat(path.join(dir, APPLY_PENDING_FILE))).resolves.toBeDefined();
  }, 30000);

});
