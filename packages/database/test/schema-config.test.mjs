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

function extractSchemaBlock(schema, kind, name) {
  const match = schema.match(new RegExp(`${kind}\\s+${name}\\s*\\{([\\s\\S]*?)\\n\\}`, 'm'));

  assert.ok(match, `expected ${kind} ${name} block`);

  return match[1];
}

test('database bootstrap exposes postgres + prisma contract', () => {
  const envExample = fs.readFileSync(new URL('../../../.env.example', import.meta.url), 'utf8');
  const schema = fs.readFileSync(new URL('../prisma/schema.prisma', import.meta.url), 'utf8');
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const env = readEnvAssignments(envExample);
  const platformUser = extractSchemaBlock(schema, 'model', 'PlatformUser');
  const operationConfirmation = extractSchemaBlock(schema, 'model', 'OperationConfirmation');
  const idempotentOperation = extractSchemaBlock(schema, 'model', 'IdempotentOperation');
  const operationAuditEvent = extractSchemaBlock(schema, 'model', 'OperationAuditEvent');
  const platformImageAsset = extractSchemaBlock(schema, 'model', 'PlatformImageAsset');
  const rangeTemplate = extractSchemaBlock(schema, 'model', 'RangeTemplate');
  const rangeInstance = extractSchemaBlock(schema, 'model', 'RangeInstance');
  const singleInstanceBatch = extractSchemaBlock(schema, 'model', 'SingleInstanceBatch');

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
  assert.match(schema, /enum OperationSource/);
  assert.match(schema, /enum OperationAuditPhase/);
  assert.match(schema, /enum IdempotentOperationStatus/);
  assert.match(schema, /model PlatformImageAsset/);
  assert.match(schema, /model RangeTemplate/);
  assert.match(schema, /topologySpec\s+Json\?/);
  assert.match(schema, /model RangeInstance/);
  assert.match(schema, /model SingleInstanceBatch/);
  assert.match(schema, /model ProvisionJob/);
  assert.match(schema, /model ProvisionJobStepLog/);
  assert.match(schema, /enum RangeInstanceStatus/);
  assert.match(schema, /enum ProvisionJobStatus/);
  assert.match(platformUser, /username\s+String\s+@unique/);
  assert.match(platformUser, /role\s+UserRole\s+@default\(user\)/);
  assert.match(platformUser, /status\s+UserStatus\s+@default\(active\)/);
  assert.match(operationConfirmation, /argumentsHash\s+String/);
  assert.match(operationConfirmation, /consumedAt\s+DateTime\?/);
  assert.match(idempotentOperation, /@@unique\(\[actorUserId,\s*toolName,\s*idempotencyKey\]\)/);
  assert.match(operationAuditEvent, /source\s+OperationSource/);
  assert.match(operationAuditEvent, /sanitizedInput\s+Json\?/);
  assert.match(platformImageAsset, /ownerUserId\s+String\?/);
  assert.match(platformImageAsset, /visibility\s+ResourceVisibility\s+@default\(private\)/);
  assert.match(platformImageAsset, /ownerUser\s+PlatformUser\?/);
  assert.match(platformImageAsset, /@@index\(\[visibility,\s*enabled\]\)/);
  assert.match(rangeTemplate, /ownerUserId\s+String\?/);
  assert.match(rangeTemplate, /visibility\s+ResourceVisibility\s+@default\(private\)/);
  assert.match(rangeTemplate, /ownerUser\s+PlatformUser\?/);
  assert.match(rangeTemplate, /@@index\(\[visibility,\s*updatedAt\]\)/);
  assert.match(rangeInstance, /ownerUserId\s+String\?/);
  assert.match(rangeInstance, /ownerUser\s+PlatformUser\?/);
  assert.match(rangeInstance, /@@index\(\[ownerUserId,\s*createdAt\]\)/);
  assert.match(singleInstanceBatch, /ownerUserId\s+String\?/);
  assert.match(singleInstanceBatch, /ownerUser\s+PlatformUser\?/);
  assert.match(singleInstanceBatch, /@@index\(\[ownerUserId,\s*createdAt\]\)/);
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
