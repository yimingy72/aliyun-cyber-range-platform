import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const template = fs.readFileSync(
  new URL('../infra/keycloak/themes/cyber-range/login/template.ftl', import.meta.url),
  'utf8',
);
const loginTemplate = fs.readFileSync(
  new URL('../infra/keycloak/themes/cyber-range/login/login.ftl', import.meta.url),
  'utf8',
);
const stylesheet = fs.readFileSync(
  new URL('../infra/keycloak/themes/cyber-range/login/resources/css/styles.css', import.meta.url),
  'utf8',
);
const platformMark = new URL('../apps/web/public/brand/platform-mark.svg', import.meta.url);
const themeMark = new URL(
  '../infra/keycloak/themes/cyber-range/login/resources/img/platform-mark.svg',
  import.meta.url,
);

test('packages the canonical platform mark inside the Keycloak login theme', () => {
  assert.ok(fs.existsSync(themeMark), 'Keycloak theme should package its own platform mark');
  assert.equal(fs.readFileSync(themeMark, 'utf8'), fs.readFileSync(platformMark, 'utf8'));
  assert.match(template, /src="\$\{url\.resourcesPath\}\/img\/platform-mark\.svg"/);
  assert.doesNotMatch(template, /(localhost:3000|https?:\/\/|data:image)/);
});

test('keeps the Keycloak title and credential form semantics inside the login card', () => {
  assert.match(template, /class="cr-login-card"/);
  assert.match(template, /平台账号认证/);
  assert.match(template, /<#nested "header">/);
  assert.match(template, /<#nested "form">/);
  assert.match(loginTemplate, /name="username"/);
  assert.match(loginTemplate, /name="password"/);
  assert.match(loginTemplate, /autocomplete="username"/);
  assert.match(loginTemplate, /autocomplete="current-password"/);
  assert.match(loginTemplate, /id="kc-login"[^>]*type="submit"/);
  assert.match(loginTemplate, /messagesPerField\.existsError\('username','password'\)/);
});

test('uses the blue workbench login treatment instead of the retired green gradient', () => {
  assert.match(stylesheet, /\.cr-login-shell\s*\{[^}]*background: #f5f7fb/s);
  assert.match(stylesheet, /\.cr-login-card\s*\{[^}]*border-radius: 6px;[^}]*background: #ffffff/s);
  assert.match(stylesheet, /\.cr-form-input\s*\{[^}]*border-radius: 6px;/s);
  assert.match(stylesheet, /\.cr-login-button\s*\{[^}]*border-radius: 6px;[^}]*background: #1d56a7;/s);
  assert.match(stylesheet, /\.cr-form-input:focus[\s\S]*border-color: #1d56a7;/);
  assert.match(stylesheet, /\.cr-login-copy\s*\{[^}]*text-align: start;/s);
  assert.match(stylesheet, /\.cr-login-info\s*\{[^}]*text-align: start;/s);
  assert.doesNotMatch(stylesheet, /linear-gradient\(|#214d46|#183230|border-radius: 24px|border-radius: 14px/);
});
