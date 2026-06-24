import fs from 'node:fs/promises';
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
      expect.objectContaining({ cwd: workspaceDir }),
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
});
