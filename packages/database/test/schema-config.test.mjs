import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('database bootstrap exposes postgres + prisma contract', () => {
  const envExample = fs.readFileSync(new URL('../../../.env.example', import.meta.url), 'utf8');
  const schema = fs.readFileSync(new URL('../prisma/schema.prisma', import.meta.url), 'utf8');
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

  assert.match(envExample, /^DATABASE_URL=/m);
  assert.match(schema, /provider\s*=\s*"postgresql"/);
  assert.equal(typeof pkg.scripts['prisma:generate'], 'string');
});
