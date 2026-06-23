import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('root workspace declares scripts and package globs', () => {
  const packageJson = JSON.parse(
    fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  );
  const workspaceYaml = fs.readFileSync(
    new URL('../pnpm-workspace.yaml', import.meta.url),
    'utf8',
  );

  assert.equal(packageJson.private, true);
  assert.equal(packageJson.packageManager, 'pnpm@10.32.1');
  assert.equal(typeof packageJson.scripts.dev, 'string');
  assert.equal(typeof packageJson.scripts.build, 'string');
  assert.equal(typeof packageJson.scripts.test, 'string');
  assert.equal(typeof packageJson.scripts['verify:bootstrap'], 'string');
  assert.equal(typeof packageJson.scripts['db:up'], 'string');
  assert.equal(typeof packageJson.scripts['db:down'], 'string');
  assert.equal(typeof packageJson.scripts['db:logs'], 'string');
  assert.match(packageJson.scripts.test, /\bpnpm -r test\b/);
  assert.match(packageJson.scripts.test, /workspace-smoke\.test\.mjs/);
  assert.match(packageJson.scripts['verify:bootstrap'], /\bpnpm test\b/);
  assert.match(packageJson.scripts['verify:bootstrap'], /\bpnpm build\b/);
  assert.match(packageJson.scripts['verify:bootstrap'], /\bdocker compose config\b/);
  assert.match(workspaceYaml, /apps\/\*/);
  assert.match(workspaceYaml, /packages\/\*/);
});
