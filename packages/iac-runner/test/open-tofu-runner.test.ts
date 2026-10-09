import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { OpenTofuRunner } from '../src/open-tofu-runner';
import {
  createOpenTofuWorkspaceLayout,
  ensureOpenTofuWorkspace,
  writeOpenTofuAutoVariablesFile,
} from '../src/workspace-layout';

describe('createOpenTofuWorkspaceLayout', () => {
  it('builds deterministic workspace file paths for a job', () => {
    const layout = createOpenTofuWorkspaceLayout({
      jobId: 'job-123',
      workspacesRootDir: '/tmp/opentofu-workspaces',
    });

    expect(layout.workspaceDir).toBe(path.join('/tmp/opentofu-workspaces', 'job-123'));
    expect(layout.planFilePath).toBe(path.join('/tmp/opentofu-workspaces', 'job-123', 'range.tfplan'));
    expect(layout.outputsFilePath).toBe(path.join('/tmp/opentofu-workspaces', 'job-123', 'outputs.json'));
    expect(layout.varsFilePath).toBe(path.join('/tmp/opentofu-workspaces', 'job-123', 'range.auto.tfvars.json'));
  });

  it('creates the workspace directory and writes a JSON auto tfvars file', async () => {
    const tempRootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'iac-runner-'));
    const layout = createOpenTofuWorkspaceLayout({
      jobId: 'job-456',
      workspacesRootDir: tempRootDir,
    });

    await ensureOpenTofuWorkspace(layout);
    await writeOpenTofuAutoVariablesFile(layout, {
      region: 'cn-hangzhou',
      resource_name_prefix: 'range-team-1',
    });

    const fileContent = await fs.readFile(layout.varsFilePath, 'utf8');

    expect(JSON.parse(fileContent)).toEqual({
      region: 'cn-hangzhou',
      resource_name_prefix: 'range-team-1',
    });
  });
});

describe('OpenTofuRunner', () => {
  it('runs init, validate, plan, apply, output, and destroy with stable CLI arguments', async () => {
    const executor = vi
      .fn()
      .mockResolvedValueOnce({ stdout: 'init ok', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'validate ok', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'plan ok', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'apply ok', stderr: '' })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          instance_id: {
            sensitive: false,
            type: 'string',
            value: 'i-1234567890',
          },
        }),
        stderr: '',
      })
      .mockResolvedValueOnce({ stdout: 'destroy ok', stderr: '' });
    const runner = new OpenTofuRunner({
      binaryPath: 'tofu',
      executor,
    });
    const workspaceDir = '/tmp/opentofu-workspaces/job-789';
    const planFilePath = path.join(workspaceDir, 'range.tfplan');
    const varsFilePath = path.join(workspaceDir, 'range.auto.tfvars.json');

    await runner.init({ workspaceDir });
    await runner.validate({ workspaceDir, varsFilePath });
    await runner.plan({ workspaceDir, planFilePath, varsFilePath });
    await runner.apply({ workspaceDir, planFilePath });
    const outputs = await runner.output<{ instance_id: { value: string } }>({ workspaceDir });
    await runner.destroy({ workspaceDir, varsFilePath });

    expect(outputs.instance_id.value).toBe('i-1234567890');
    expect(executor).toHaveBeenNthCalledWith(
      1,
      'tofu',
      ['init', '-input=false', '-no-color'],
      expect.objectContaining({ cwd: workspaceDir, timeout: 600_000 }),
    );
    expect(executor).toHaveBeenNthCalledWith(
      2,
      'tofu',
      ['validate', '-no-color', '-var-file', varsFilePath],
      expect.objectContaining({ cwd: workspaceDir }),
    );
    expect(executor).toHaveBeenNthCalledWith(
      3,
      'tofu',
      ['plan', '-input=false', '-no-color', '-parallelism=10', '-out', planFilePath, '-var-file', varsFilePath],
      expect.objectContaining({ cwd: workspaceDir }),
    );
    expect(executor).toHaveBeenNthCalledWith(
      4,
      'tofu',
      ['apply', '-input=false', '-no-color', '-auto-approve', '-parallelism=10', planFilePath],
      expect.objectContaining({ cwd: workspaceDir }),
    );
    expect(executor).toHaveBeenNthCalledWith(
      5,
      'tofu',
      ['output', '-json'],
      expect.objectContaining({ cwd: workspaceDir }),
    );
    expect(executor).toHaveBeenNthCalledWith(
      6,
      'tofu',
      ['destroy', '-input=false', '-no-color', '-auto-approve', '-parallelism=10', '-var-file', varsFilePath],
      expect.objectContaining({ cwd: workspaceDir }),
    );
  });

  it('keeps stdio open and waits for graceful state persistence before reporting a timeout', async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'iac-runner-interrupt-'));
    const binaryPath = path.join(workspaceDir, 'graceful-runner');
    await fs.writeFile(binaryPath, `#!/usr/bin/env node
const fs = require('node:fs');
process.on('SIGTERM', () => {
  console.log('Graceful shutdown');
  setTimeout(() => { fs.writeFileSync('persisted-state', 'complete'); process.exit(0); }, 100);
});
setInterval(() => {}, 1000);
`, { mode: 0o755 });
    const runner = new OpenTofuRunner({ binaryPath, commandTimeoutMs: 500 });
    const error = await runner.init({ workspaceDir }).catch(error => error);
    expect(error.message).toContain('timed out after 500 ms');
    expect(error.stdout).toContain('Graceful shutdown');
    expect(await fs.readFile(path.join(workspaceDir, 'persisted-state'), 'utf8')).toBe('complete');
  });

  it.skipIf(!existsSync('/usr/local/bin/tofu'))('soft-interrupts real OpenTofu and destroys its persisted partial state without a cloud provider', async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'iac-runner-tofu-interrupt-'));
    await fs.writeFile(path.join(workspaceDir, 'main.tf'), `
resource "terraform_data" "ready" { input = "ready" }
resource "terraform_data" "slow" {
  depends_on = [terraform_data.ready]
  provisioner "local-exec" { command = "sleep 60" }
}
`);
    const runner = new OpenTofuRunner({ binaryPath: '/usr/local/bin/tofu', commandTimeoutMs: 3000 });
    const planFilePath = path.join(workspaceDir, 'local.tfplan');
    await runner.init({ workspaceDir });
    await runner.plan({ workspaceDir, planFilePath });
    await expect(runner.apply({ workspaceDir, planFilePath })).rejects.toThrow('timed out after 3000 ms');
    const partialState = JSON.parse(await fs.readFile(path.join(workspaceDir, 'terraform.tfstate'), 'utf8'));
    expect(partialState.resources.map((resource: { name: string }) => resource.name)).toEqual(expect.arrayContaining(['ready', 'slow']));
    await runner.destroy({ workspaceDir });
    expect(JSON.parse(await fs.readFile(path.join(workspaceDir, 'terraform.tfstate'), 'utf8')).resources).toEqual([]);
  }, 20_000);

  it.skipIf(!existsSync('/usr/local/bin/tofu'))('reads a 1.12.3 state without replacement, applies changes, and destroys it with the current binary', async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'iac-runner-upgrade-'));
    const configuration = (value: string) => `
resource "terraform_data" "compatibility" { input = "${value}" }
output "compatibility" { value = terraform_data.compatibility.output }
`;
    const runner = new OpenTofuRunner({ binaryPath: '/usr/local/bin/tofu' });
    const planFilePath = path.join(workspaceDir, 'upgrade.tfplan');
    try {
      // Generated by real OpenTofu 1.12.3 using only its built-in provider; contains no cloud resources.
      await fs.copyFile(new URL('./fixtures/opentofu-1.12.3.tfstate.json', import.meta.url), path.join(workspaceDir, 'terraform.tfstate'));
      await fs.writeFile(path.join(workspaceDir, 'main.tf'), configuration('upgrade-fixture'));
      await runner.init({ workspaceDir });
      await runner.validate({ workspaceDir });
      await runner.plan({ workspaceDir, planFilePath });
      const { stdout } = await promisify(execFile)('/usr/local/bin/tofu', ['show', '-json', planFilePath], { cwd: workspaceDir });
      const plan = JSON.parse(stdout);
      expect(plan.resource_changes.map((change: { change: { actions: string[] } }) => change.change.actions)).toEqual([['no-op']]);
      await fs.writeFile(path.join(workspaceDir, 'main.tf'), configuration('upgraded-fixture'));
      await runner.plan({ workspaceDir, planFilePath });
      await runner.apply({ workspaceDir, planFilePath });
      expect(await runner.output({ workspaceDir })).toMatchObject({ compatibility: { value: 'upgraded-fixture' } });
      await runner.destroy({ workspaceDir });
      expect(JSON.parse(await fs.readFile(path.join(workspaceDir, 'terraform.tfstate'), 'utf8')).resources).toEqual([]);
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  }, 20_000);

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648])('rejects invalid command timeout %s', commandTimeoutMs => {
    expect(() => new OpenTofuRunner({ commandTimeoutMs })).toThrow('timeout must be a positive number');
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 33])('rejects invalid parallelism %s', parallelism => {
    expect(() => new OpenTofuRunner({ parallelism })).toThrow('parallelism must be an integer');
  });

  it('forwards cancellation to a custom executor and uses configured parallelism', async () => {
    const signal = new AbortController().signal;
    const executor = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });
    const runner = new OpenTofuRunner({ executor, parallelism: 2 });
    await runner.plan({ workspaceDir: '/tmp/fixture', planFilePath: 'fixture.tfplan', signal });
    expect(executor).toHaveBeenCalledWith('tofu', expect.arrayContaining(['-parallelism=2']), expect.objectContaining({ signal }));
  });

  it('uses default parallelism for an empty optional environment setting', async () => {
    vi.stubEnv('OPENTOFU_PARALLELISM', ' ');
    try {
      const executor = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });
      await new OpenTofuRunner({ executor }).destroy({ workspaceDir: '/tmp/fixture' });
      expect(executor.mock.calls[0][1]).toContain('-parallelism=10');
    } finally { vi.unstubAllEnvs(); }
  });

  it('does not start an already-aborted command', async () => {
    const controller = new AbortController();
    controller.abort();
    const executor = vi.fn();
    const runner = new OpenTofuRunner({ executor });
    await expect(runner.init({ workspaceDir: '/tmp/fixture', signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(executor).not.toHaveBeenCalled();
  });

  it('uses stable targeted destroy-plan, JSON inspection and import arguments', async () => {
    const executor = vi.fn().mockResolvedValue({ stdout: JSON.stringify({ resource_changes: [] }), stderr: '' });
    const runner = new OpenTofuRunner({ executor });
    const base = { workspaceDir: '/tmp/fixture', planFilePath: 'fixture.tfplan' };
    const address = 'module.batch.alicloud_instance.member["member-1"]';
    await runner.plan({ ...base, targets: [address], destroy: true, varsFilePath: 'fixture.tfvars.json' });
    expect(executor.mock.calls[0][1]).toEqual(['plan', '-input=false', '-no-color', '-parallelism=10', '-out', 'fixture.tfplan', '-destroy', `-target=${address}`, '-var-file', 'fixture.tfvars.json']);
    await expect(runner.showPlan(base)).resolves.toEqual({ resource_changes: [] });
    expect(executor.mock.calls[1][1]).toEqual(['show', '-json', 'fixture.tfplan']);
    await expect(runner.showPlanJson(base)).resolves.toEqual({ resource_changes: [] });
    await runner.importResource({ workspaceDir: base.workspaceDir, address, resourceId: 'i-owned', varsFilePath: 'fixture.tfvars.json' });
    expect(executor.mock.calls[3][1]).toEqual(['import', '-input=false', '-no-color', '-var-file', 'fixture.tfvars.json', address, 'i-owned']);
    await runner.destroy({ workspaceDir: base.workspaceDir, targets: [address] });
    expect(executor.mock.calls[4][1]).toEqual(['destroy', '-input=false', '-no-color', '-auto-approve', '-parallelism=10', `-target=${address}`]);
    await expect(runner.plan({ ...base, targets: [''] })).rejects.toThrow('target address');
    await expect(runner.importResource({ workspaceDir: base.workspaceDir, address, resourceId: '-lock=false' })).rejects.toThrow('exact resource');
    expect(executor).toHaveBeenCalledTimes(5);
  });

  it.skipIf(!existsSync('/usr/local/bin/tofu'))('imports a lost builtin member, inspects a targeted destroy plan and preserves the healthy sibling', async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'iac-runner-targeted-import-'));
    const runner = new OpenTofuRunner({ binaryPath: '/usr/local/bin/tofu' });
    const planFilePath = path.join(workspaceDir, 'fixture.tfplan');
    const stateFile = path.join(workspaceDir, 'terraform.tfstate');
    const address = 'terraform_data.fixture[1]';
    try {
      await fs.writeFile(path.join(workspaceDir, 'main.tf'), 'resource "terraform_data" "fixture" {\n count = 2\n input = count.index\n}\n');
      await runner.init({ workspaceDir });
      await runner.plan({ workspaceDir, planFilePath });
      await runner.apply({ workspaceDir, planFilePath });
      const original = JSON.parse(await fs.readFile(stateFile, 'utf8'));
      const members = original.resources[0].instances;
      const ownedId = members.find((item: { index_key: number }) => item.index_key === 1).attributes.id;
      const healthy = JSON.parse(JSON.stringify(members.find((item: { index_key: number }) => item.index_key === 0)));
      original.resources[0].instances = members.filter((item: { index_key: number }) => item.index_key !== 1);
      original.serial++;
      await fs.writeFile(stateFile, JSON.stringify(original));
      await runner.importResource({ workspaceDir, address, resourceId: ownedId });
      await runner.plan({ workspaceDir, planFilePath });
      const recoveryPlan = await runner.showPlan<{ resource_changes: Array<{ address: string; change: { actions: string[] } }> }>({ workspaceDir, planFilePath });
      expect(recoveryPlan.resource_changes.find(change => change.address === 'terraform_data.fixture[0]')?.change.actions).toEqual(['no-op']);
      await runner.plan({ workspaceDir, planFilePath, destroy: true, targets: [address] });
      const targeted = await runner.showPlanJson<{ resource_changes: Array<{ address: string; change: { actions: string[] } }> }>({ workspaceDir, planFilePath });
      expect(targeted.resource_changes.filter(change => change.change.actions.some(action => action !== 'no-op')).map(change => [change.address, change.change.actions])).toEqual([[address, ['delete']]]);
      await runner.apply({ workspaceDir, planFilePath });
      const after = JSON.parse(await fs.readFile(stateFile, 'utf8'));
      expect(after.resources[0].instances).toEqual([healthy]);
      await runner.destroy({ workspaceDir });
      expect(JSON.parse(await fs.readFile(stateFile, 'utf8')).resources).toEqual([]);
    } finally { await fs.rm(workspaceDir, { recursive: true, force: true }); }
  }, 20_000);

  it('keeps stdio open until graceful state persistence after an external abort', async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'iac-runner-abort-'));
    const binaryPath = path.join(workspaceDir, 'graceful-runner');
    await fs.writeFile(binaryPath, `#!/usr/bin/env node
const fs = require('node:fs');
process.on('SIGTERM', () => {
  console.log('Graceful abort');
  setTimeout(() => { fs.writeFileSync('persisted-state', 'complete'); process.exit(0); }, 100);
});
setInterval(() => {}, 1000);
`, { mode: 0o755 });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 500);
    try {
      const error = await new OpenTofuRunner({ binaryPath }).init({ workspaceDir, signal: controller.signal }).catch(error => error);
      expect(error.name).toBe('AbortError');
      expect(error.stdout).toContain('Graceful abort');
      expect(await fs.readFile(path.join(workspaceDir, 'persisted-state'), 'utf8')).toBe('complete');
    } finally {
      clearTimeout(timer);
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it.skipIf(!existsSync('/usr/local/bin/tofu'))('externally aborts real OpenTofu and retains partial state for subsequent destroy', async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'iac-runner-tofu-abort-'));
    await fs.writeFile(path.join(workspaceDir, 'main.tf'), `
resource "terraform_data" "ready" { input = "ready" }
resource "terraform_data" "slow" {
  depends_on = [terraform_data.ready]
  provisioner "local-exec" { command = "sleep 60" }
}
`);
    const runner = new OpenTofuRunner({ binaryPath: '/usr/local/bin/tofu' });
    const planFilePath = path.join(workspaceDir, 'local.tfplan');
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await runner.init({ workspaceDir });
      await runner.plan({ workspaceDir, planFilePath });
      timer = setTimeout(() => controller.abort(), 1500);
      await expect(runner.apply({ workspaceDir, planFilePath, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
      const state = JSON.parse(await fs.readFile(path.join(workspaceDir, 'terraform.tfstate'), 'utf8'));
      expect(state.resources.map((resource: { name: string }) => resource.name)).toEqual(expect.arrayContaining(['ready', 'slow']));
      await runner.destroy({ workspaceDir });
      expect(JSON.parse(await fs.readFile(path.join(workspaceDir, 'terraform.tfstate'), 'utf8')).resources).toEqual([]);
    } finally {
      clearTimeout(timer);
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  }, 20_000);

  it.skipIf(!existsSync('/usr/local/bin/tofu'))('plan still rejects invalid input without a standalone validate command', async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'iac-runner-plan-validation-'));
    try {
      await fs.writeFile(path.join(workspaceDir, 'main.tf'), 'variable "value" { type = number }\nresource "terraform_data" "fixture" { input = var.value }\n');
      const varsFilePath = path.join(workspaceDir, 'fixture.tfvars.json');
      await fs.writeFile(varsFilePath, JSON.stringify({ value: 'invalid-number' }));
      const runner = new OpenTofuRunner({ binaryPath: '/usr/local/bin/tofu' });
      await runner.init({ workspaceDir });
      await expect(runner.plan({ workspaceDir, varsFilePath, planFilePath: path.join(workspaceDir, 'fixture.tfplan') })).rejects.toThrow();
      expect(existsSync(path.join(workspaceDir, 'terraform.tfstate'))).toBe(false);
    } finally { await fs.rm(workspaceDir, { recursive: true, force: true }); }
  });
});
