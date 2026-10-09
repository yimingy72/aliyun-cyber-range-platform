import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const value = process.env.CLOUD_WORKSPACE_MIGRATION_TEST_DATABASE_URL;
if (!value) throw new Error('A dedicated Docker workspace migration test database is required');
const url = new URL(value);
if (!['postgres:', 'postgresql:'].includes(url.protocol)
  || !['postgres', '127.0.0.1', 'localhost'].includes(url.hostname)
  || !/^\/[a-z0-9_]+_workspace_migration_test$/.test(url.pathname)) {
  throw new Error('Workspace migration smoke only accepts an isolated *_workspace_migration_test Docker database');
}
const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratch = mkdtempSync(path.join(tmpdir(), 'cloud-workspace-migration-'));
const schema = path.join(scratch, 'prisma', 'schema.prisma');
const env = { ...process.env, DATABASE_URL: value };
function prisma(...args) {
  const result = spawnSync('pnpm', ['exec', 'prisma', ...args], { cwd: packageDir, env, encoding: 'utf8' });
  if (result.status !== 0) {
    // Never echo a datasource URL or supplied credentials in a failed verification report.
    throw new Error(`Workspace migration check failed: ${args[0]} ${args[1]}`);
  }
}
try {
  cpSync(path.join(packageDir, 'prisma'), path.join(scratch, 'prisma'), { recursive: true });
  const baselineMigrations = path.join(scratch, 'prisma', 'migrations');
  // Build the legacy schema before this checkpoint; its later migrations require workspace columns.
  for (const entry of readdirSync(baselineMigrations, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name >= '20261009230000_cloud_workspaces')
      rmSync(path.join(baselineMigrations, entry.name), { recursive: true });
  }
  prisma('migrate', 'deploy', '--schema', schema);
  prisma('db', 'execute', '--schema', schema, '--file', path.join(packageDir, 'test', 'fixtures', 'cloud-workspaces-legacy.seed.sql'));
  prisma('migrate', 'deploy', '--schema', path.join(packageDir, 'prisma', 'schema.prisma'));
  prisma('db', 'execute', '--schema', schema, '--file', path.join(packageDir, 'test', 'fixtures', 'cloud-workspaces-legacy.verify.sql'));
  process.stdout.write('Cloud workspace migration preserves source identities and isolates known, unknown and conflicting histories.\n');
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
