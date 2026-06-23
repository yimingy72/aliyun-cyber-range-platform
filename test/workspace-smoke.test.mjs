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
  assert.equal(typeof packageJson.scripts.dev, 'string');
  assert.equal(typeof packageJson.scripts.build, 'string');
  assert.equal(typeof packageJson.scripts.test, 'string');
  assert.match(workspaceYaml, /apps\/\*/);
  assert.match(workspaceYaml, /packages\/\*/);
});
