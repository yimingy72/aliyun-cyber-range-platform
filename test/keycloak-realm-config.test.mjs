import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const realmConfig = JSON.parse(
  fs.readFileSync(new URL('../infra/keycloak/realm-cyber-range.json', import.meta.url), 'utf8'),
);
const bootstrapScript = fs.readFileSync(
  new URL('../scripts/dev/bootstrap-keycloak.sh', import.meta.url),
  'utf8',
);
const imageDeploymentCompose = fs.readFileSync(
  new URL('../deploy/current-system/docker-compose.images.yml', import.meta.url),
  'utf8',
);

function getClient(clientId) {
  return realmConfig.clients.find((client) => client.clientId === clientId);
}

function getMapper(client, mapperName) {
  return client?.protocolMappers?.find((mapper) => mapper.name === mapperName);
}

function getKeycloakBootstrapBlock(composeSource) {
  const start = composeSource.indexOf('  keycloak-bootstrap:');
  const end = composeSource.indexOf('\n  api:', start);

  return start === -1 || end === -1 ? '' : composeSource.slice(start, end);
}

test('platform-web emits username and realm roles without relying on missing built-in client scopes', () => {
  const platformWeb = getClient('platform-web');

  assert.ok(platformWeb, 'platform-web client should exist');
  assert.equal(platformWeb.defaultClientScopes, undefined);
  assert.ok(getMapper(platformWeb, 'sub-direct'));
  assert.ok(getMapper(platformWeb, 'preferred-username-direct'));
  assert.ok(getMapper(platformWeb, 'realm-roles-direct'));
});

test('platform-web permits only the exact loopback login callback and logout routes', () => {
  const platformWeb = getClient('platform-web');

  assert.ok(platformWeb, 'platform-web client should exist');
  assert.deepEqual(platformWeb.redirectUris, [
    'http://localhost:3000/admin/callback', 'http://127.0.0.1:3000/admin/callback',
  ]);
  assert.deepEqual(platformWeb.webOrigins, ['http://localhost:3000', 'http://127.0.0.1:3000']);
  assert.equal(platformWeb.attributes['post.logout.redirect.uris'],
    'http://localhost:3000/admin/login##http://127.0.0.1:3000/admin/login');
  assert.equal(platformWeb.attributes['pkce.code.challenge.method'], 'S256');
  assert.equal(platformWeb.publicClient, true);
  assert.equal(platformWeb.standardFlowEnabled, true);
  assert.equal(platformWeb.directAccessGrantsEnabled, false);
});

function bootstrapWebClient(webPublicUrl) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'keycloak-bootstrap-test-'));
  const commandLog = path.join(directory, 'commands.jsonl');
  const mockAdmin = path.join(directory, 'kcadm');
  const script = path.join(directory, 'bootstrap.sh');
  fs.writeFileSync(mockAdmin, `#!${process.execPath}
import fs from 'node:fs';
const args = process.argv.slice(2);
fs.appendFileSync(process.env.KEYCLOAK_TEST_COMMAND_LOG, JSON.stringify(args) + '\\n');
if (args[0] === 'get') {
  if (args[1] === 'users') console.log(JSON.stringify([{ id: 'fixture-admin' }]));
  else if (args[1] === 'clients') {
    const client = args.find(value => value.startsWith('clientId='))?.slice(9);
    console.log(JSON.stringify([{ id: client }]));
  } else if (args[1].endsWith('/management/permissions')) {
    console.log(JSON.stringify({ 'token-exchange': 'fixture-permission' }));
  } else console.log('[]');
}
`, { mode: 0o700 });
  fs.writeFileSync(script, bootstrapScript.replaceAll('/opt/keycloak/bin/kcadm.sh', mockAdmin));
  try {
    const result = spawnSync('sh', [script], {
      env: {
        PATH: process.env.PATH,
        WEB_PUBLIC_URL: webPublicUrl,
        KEYCLOAK_TEST_COMMAND_LOG: commandLog,
      },
      encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(result.status, 0, result.stderr);
    const commands = fs.readFileSync(commandLog, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const update = commands.find(args => args[0] === 'update' && args[1] === 'clients/platform-web');
    assert.ok(update, 'bootstrap must update platform-web');
    const parameter = name => update.find(value => value.startsWith(`${name}=`))?.slice(name.length + 1);
    return {
      redirectUris: JSON.parse(parameter('redirectUris')),
      webOrigins: JSON.parse(parameter('webOrigins')),
      postLogoutUris: parameter('attributes."post.logout.redirect.uris"').split('##'),
    };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

for (const [configured, origins] of [
  ['http://localhost:3000', ['http://localhost:3000', 'http://127.0.0.1:3000']],
  ['http://127.0.0.1:3000/', ['http://127.0.0.1:3000', 'http://localhost:3000']],
  ['https://localhost:8443', ['https://localhost:8443', 'https://127.0.0.1:8443']],
  ['http://127.0.0.1', ['http://127.0.0.1', 'http://localhost']],
  ['https://range.example.com', ['https://range.example.com']],
  ['http://203.0.113.10:3000', ['http://203.0.113.10:3000']],
  ['http://localhost.example.com:3000', ['http://localhost.example.com:3000']],
]) {
  test(`bootstrap limits callback, CORS and logout addresses for ${configured}`, () => {
    assert.deepEqual(bootstrapWebClient(configured), {
      redirectUris: origins.map(origin => `${origin}/admin/callback`),
      webOrigins: origins,
      postLogoutUris: origins.map(origin => `${origin}/admin/login`),
    });
  });
}

test('image deployment passes the hosted web origin to Keycloak bootstrap', () => {
  const keycloakBootstrapBlock = getKeycloakBootstrapBlock(imageDeploymentCompose);

  assert.ok(keycloakBootstrapBlock, 'image deployment keycloak-bootstrap service should exist');
  assert.match(keycloakBootstrapBlock, /WEB_PUBLIC_URL: \$\{WEB_PUBLIC_URL:-http:\/\/localhost:3000\}/);
});

test('all deployment modes pass the same administrator and OIDC client configuration to bootstrap', () => {
  const composeSources = [
    '../docker-compose.yml',
    '../deploy/current-system/docker-compose.yml',
    '../deploy/current-system/docker-compose.images.yml',
  ].map((file) => fs.readFileSync(new URL(file, import.meta.url), 'utf8'));
  const environments = composeSources.map((source) => {
    const block = getKeycloakBootstrapBlock(source);
    return block.slice(block.indexOf('    environment:'), block.indexOf('    volumes:'));
  });
  assert.equal(environments[1], environments[0]);
  assert.equal(environments[2], environments[0]);
  for (const name of [
    'PLATFORM_ADMIN_USERNAME', 'PLATFORM_ADMIN_PASSWORD',
    'KEYCLOAK_ADMIN_CLIENT_ID', 'KEYCLOAK_ADMIN_CLIENT_SECRET',
    'MCP_OIDC_CLIENT_ID', 'MCP_OIDC_CLIENT_SECRET',
    'MCP_SMOKE_CLIENT_ID', 'MCP_SMOKE_CLIENT_SECRET',
    'MCP_SMOKE_OIDC_CLIENT_ID', 'MCP_SMOKE_OIDC_CLIENT_SECRET',
  ]) {
    assert.match(environments[0], new RegExp(`\\b${name}:`));
  }
  assert.match(composeSources[0], /\.\/scripts\/dev\/bootstrap-keycloak\.sh:\/opt\/keycloak\/bootstrap-keycloak\.sh:ro/);
  for (const source of composeSources.slice(1)) {
    assert.match(source, /\.\.\/\.\.\/scripts\/dev\/bootstrap-keycloak\.sh:\/opt\/keycloak\/bootstrap-keycloak\.sh:ro/);
    assert.match(source, /\.\.\/\.\.\/infra\/keycloak:\/opt\/keycloak\/data\/import:ro/);
  }
});

test('smoke-conf emits username and realm roles without relying on missing built-in client scopes', () => {
  const smokeClient = getClient('smoke-conf');

  assert.ok(smokeClient, 'smoke-conf client should exist');
  assert.equal(smokeClient.defaultClientScopes, undefined);
  assert.ok(getMapper(smokeClient, 'sub-direct'));
  assert.ok(getMapper(smokeClient, 'preferred-username-direct'));
  assert.ok(getMapper(smokeClient, 'realm-roles-direct'));
});

test('platform-api emits the exchanged user subject', () => {
  const platformApi = getClient('platform-api');

  assert.ok(platformApi, 'platform-api client should exist');
  assert.ok(getMapper(platformApi, 'sub-direct'));
});

test('realm access tokens remain valid for seven days', () => {
  assert.equal(realmConfig.accessTokenLifespan, 604800);
  assert.match(bootstrapScript, /accessTokenLifespan=604800/);
});

test('bootstrap script resolves the seeded admin by exact username and patches token mappers', () => {
  assert.match(bootstrapScript, /get users -r "\$REALM" -q exact=true -q username="\$username"/);
  assert.match(bootstrapScript, /ensure_preferred_username_mapper "\$PLATFORM_WEB_CLIENT_ID"/);
  assert.match(bootstrapScript, /ensure_realm_roles_mapper "\$PLATFORM_WEB_CLIENT_ID"/);
  assert.match(bootstrapScript, /ensure_subject_mapper "\$PLATFORM_API_CLIENT_ID"/);
});
