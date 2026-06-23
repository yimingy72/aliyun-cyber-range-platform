import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

function readEnvAssignments(source) {
  return Object.fromEntries(
    source
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => {
        const separatorIndex = line.indexOf('=');

        return [line.slice(0, separatorIndex), line.slice(separatorIndex + 1)];
      }),
  );
}

function buildDatabaseUrlSample({ user, password, port, database }) {
  return `postgresql://${user}:${password}@localhost:${port}/${database}?schema=public`;
}

test('database bootstrap exposes postgres + prisma contract', () => {
  const envExample = fs.readFileSync(new URL('../../../.env.example', import.meta.url), 'utf8');
  const schema = fs.readFileSync(new URL('../prisma/schema.prisma', import.meta.url), 'utf8');
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const env = readEnvAssignments(envExample);

  assert.match(envExample, /^DATABASE_URL=/m);
  assert.match(schema, /provider\s*=\s*"postgresql"/);
  assert.match(schema, /url\s*=\s*env\("DATABASE_URL"\)/);
  assert.match(env.DATABASE_URL, /^postgresql:\/\//);
  assert.equal(
    env.DATABASE_URL,
    buildDatabaseUrlSample({
      user: env.POSTGRES_USER,
      password: env.POSTGRES_PASSWORD,
      port: env.POSTGRES_PORT,
      database: env.POSTGRES_DB,
    }),
  );
  assert.equal(typeof pkg.scripts['prisma:generate'], 'string');
});
