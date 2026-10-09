import fs from 'node:fs/promises';
import path from 'node:path';

export const fixtureState = { version: 4, lineage: 'test-lineage', serial: 1, resources: [
  { mode: 'managed', type: 'terraform_data', name: 'fixture', instances: [{ attributes: { id: 'fixture-id' } }] },
] };
export const fixturePlan = { planned_values: { root_module: { resources: [
  { mode: 'managed', address: 'terraform_data.fixture' },
] } }, resource_changes: [{ mode: 'managed', address: 'terraform_data.fixture', change: { actions: ['create'] } }] };
export async function persistSuccessfulApply(options: { workspaceDir: string }) {
  await fs.writeFile(path.join(options.workspaceDir, 'terraform.tfstate'), JSON.stringify(fixtureState));
  return { stdout: 'apply ok', stderr: '' };
}
