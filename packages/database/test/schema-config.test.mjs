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
  assert.equal(typeof env.ADMIN_USERNAME, 'string');
  assert.equal(typeof env.ADMIN_PASSWORD, 'string');
  assert.equal(typeof env.ADMIN_TOKEN, 'string');
  assert.equal(typeof env.NEXT_PUBLIC_API_BASE_URL, 'string');
  assert.match(schema, /model PlatformUser/);
  assert.match(schema, /enum UserRole/);
  assert.match(schema, /enum UserStatus/);
  assert.match(schema, /enum ResourceVisibility/);
  assert.match(schema, /model PlatformImageAsset/);
  assert.match(schema, /model RangeTemplate/);
  assert.match(schema, /ownerUserId\s+String\?/);
  assert.match(schema, /visibility\s+ResourceVisibility/);
  assert.match(schema, /topologySpec\s+Json\?/);
  assert.match(schema, /model RangeInstance/);
  assert.match(schema, /model SingleInstanceBatch/);
  assert.match(schema, /model ProvisionJob/);
  assert.match(schema, /model ProvisionJobStepLog/);
  assert.match(schema, /enum RangeInstanceStatus/);
  assert.match(schema, /enum ProvisionJobStatus/);
  assert.match(schema, /output\s*=\s*"\.\.\/generated\/client"/);
  assert.equal(typeof pkg.scripts['prisma:generate'], 'string');
  assert.equal(typeof pkg.scripts.test, 'string');
  assert.match(pkg.scripts.test, /\bprisma validate\b/);
  assert.match(pkg.scripts.test, /schema-config\.test\.mjs/);
});

test('database package includes a checked-in migration baseline', () => {
  const migrationsDir = new URL('../prisma/migrations', import.meta.url);

  assert.equal(fs.existsSync(migrationsDir), true);

  const entries = fs.readdirSync(migrationsDir, { withFileTypes: true });

  assert.equal(
    entries.some((entry) => entry.isDirectory()),
    true,
  );
});

test('workspace exposes real-postgres local scripts and deploy migration command', () => {
  const rootPackage = JSON.parse(fs.readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'));
  const databasePackage = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const startScriptPath = new URL('../../../scripts/dev/start-postgres.sh', import.meta.url);
  const stopScriptPath = new URL('../../../scripts/dev/stop-postgres.sh', import.meta.url);

  assert.equal(typeof rootPackage.scripts['db:local:start'], 'string');
  assert.equal(typeof rootPackage.scripts['db:local:stop'], 'string');
  assert.equal(typeof databasePackage.scripts['prisma:migrate:deploy'], 'string');
  assert.equal(fs.existsSync(startScriptPath), true);
  assert.equal(fs.existsSync(stopScriptPath), true);
});
