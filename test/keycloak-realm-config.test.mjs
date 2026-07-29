import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const realmConfig = JSON.parse(
  fs.readFileSync(new URL('../infra/keycloak/realm-cyber-range.json', import.meta.url), 'utf8'),
);
const bootstrapScript = fs.readFileSync(
  new URL('../scripts/dev/bootstrap-keycloak.sh', import.meta.url),
  'utf8',
);

function getClient(clientId) {
  return realmConfig.clients.find((client) => client.clientId === clientId);
}

function getMapper(client, mapperName) {
  return client?.protocolMappers?.find((mapper) => mapper.name === mapperName);
}

test('platform-web emits username and realm roles without relying on missing built-in client scopes', () => {
  const platformWeb = getClient('platform-web');

  assert.ok(platformWeb, 'platform-web client should exist');
  assert.equal(platformWeb.defaultClientScopes, undefined);
  assert.ok(getMapper(platformWeb, 'sub-direct'));
  assert.ok(getMapper(platformWeb, 'preferred-username-direct'));
  assert.ok(getMapper(platformWeb, 'realm-roles-direct'));
});

test('platform-web permits post-logout redirects to its configured redirect URIs', () => {
  const platformWeb = getClient('platform-web');

  assert.ok(platformWeb, 'platform-web client should exist');
  assert.equal(platformWeb.attributes['post.logout.redirect.uris'], '+');
  assert.match(bootstrapScript, /attributes\."post\.logout\.redirect\.uris"=\+/);
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
