import fs from 'node:fs/promises';
import path from 'node:path';

export type OpenTofuWorkspaceLayout = {
  workspaceDir: string;
  planFilePath: string;
  outputsFilePath: string;
  varsFilePath: string;
};

export type CreateOpenTofuWorkspaceLayoutOptions = {
  jobId: string;
  workspacesRootDir: string;
};

export function createOpenTofuWorkspaceLayout(
  options: CreateOpenTofuWorkspaceLayoutOptions,
): OpenTofuWorkspaceLayout {
  const workspaceDir = path.join(options.workspacesRootDir, options.jobId);

  return {
    workspaceDir,
    planFilePath: path.join(workspaceDir, 'range.tfplan'),
    outputsFilePath: path.join(workspaceDir, 'outputs.json'),
    varsFilePath: path.join(workspaceDir, 'range.auto.tfvars.json'),
  };
}

export async function ensureOpenTofuWorkspace(layout: OpenTofuWorkspaceLayout): Promise<void> {
  await fs.mkdir(layout.workspaceDir, { recursive: true });
}

export async function writeOpenTofuAutoVariablesFile(
  layout: OpenTofuWorkspaceLayout,
  variables: Record<string, unknown>,
): Promise<string> {
  await ensureOpenTofuWorkspace(layout);
  await fs.writeFile(layout.varsFilePath, `${JSON.stringify(variables, null, 2)}\n`, 'utf8');

  return layout.varsFilePath;
}
