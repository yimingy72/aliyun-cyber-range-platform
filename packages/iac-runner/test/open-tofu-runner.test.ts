import fs from 'node:fs/promises';
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
      ['plan', '-input=false', '-no-color', '-out', planFilePath, '-var-file', varsFilePath],
      expect.objectContaining({ cwd: workspaceDir }),
    );
    expect(executor).toHaveBeenNthCalledWith(
      4,
      'tofu',
      ['apply', '-input=false', '-no-color', '-auto-approve', planFilePath],
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
      ['destroy', '-input=false', '-no-color', '-auto-approve', '-var-file', varsFilePath],
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

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648])('rejects invalid command timeout %s', commandTimeoutMs => {
    expect(() => new OpenTofuRunner({ commandTimeoutMs })).toThrow('timeout must be a positive number');
  });
});
