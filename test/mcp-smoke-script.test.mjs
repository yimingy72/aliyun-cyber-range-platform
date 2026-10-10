import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const source = new URL('../scripts/dev/smoke-mcp-compose.sh', import.meta.url);
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-smoke-safe-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const script = path.join(root, 'scripts/dev/smoke-mcp-compose.sh');
  const bin = path.join(root, 'bin'); const log = path.join(root, 'invocation.json');
  fs.mkdirSync(path.dirname(script), { recursive: true }); fs.mkdirSync(bin);
  fs.copyFileSync(source, script);
  fs.writeFileSync(path.join(bin, 'docker'), `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(process.env.FIXTURE_LOG, JSON.stringify({ args: process.argv.slice(2), url: process.env.MCP_URL, tool: process.env.MCP_SMOKE_TOOL, input: process.env.MCP_SMOKE_ARGS, tokenPresent: Boolean(process.env.MCP_BEARER_TOKEN) }));
process.exit(Number(process.env.FIXTURE_EXIT || 0));
`, { mode: 0o755 });
  const run = env => spawnSync('bash', [script], { encoding: 'utf8', env: { ...process.env, MCP_BEARER_TOKEN: '', PATH: `${bin}:${process.env.PATH}`, FIXTURE_LOG: log, ...env } });
  return { log, run };
}

test('requires an existing token without invoking Docker or bootstrap commands', t => {
  const s = fixture(t);
  for (const token of ['', '   \n']) {
    const result = s.run({ MCP_BEARER_TOKEN: token }); assert.equal(result.status, 1);
    assert.match(result.stderr, /MCP_BEARER_TOKEN is required/); assert.equal(fs.existsSync(s.log), false);
  }
});
test('uses only an existing container and keeps tokens out of arguments and output', t => {
  const s = fixture(t); const token = 'fixture-only-opaque-token';
  const result = s.run({ MCP_BEARER_TOKEN: token, MCP_URL: 'https://untrusted.invalid/mcp' });
  assert.equal(result.status, 0);
  const call = JSON.parse(fs.readFileSync(s.log, 'utf8'));
  assert.deepEqual(call.args, ['compose', 'exec', '-T', '-e', 'MCP_URL', '-e', 'MCP_BEARER_TOKEN', '-e', 'MCP_SMOKE_TOOL', '-e', 'MCP_SMOKE_ARGS', 'mcp', 'pnpm', '--filter', '@aliyun-cyber-range/mcp', 'smoke:http']);
  assert.equal(call.url, 'http://127.0.0.1:8787/mcp'); assert.equal(call.tool, 'range_template_list');
  assert.deepEqual(JSON.parse(call.input), { view: 'platform' }); assert.equal(call.tokenPresent, true);
  assert.equal(JSON.stringify(call).includes(token), false); assert.equal((result.stdout + result.stderr).includes(token), false);
});
test('preserves chosen read arguments exactly and propagates SDK failures', t => {
  const s = fixture(t);
  const result = s.run({ MCP_BEARER_TOKEN: 'fixture', MCP_SMOKE_TOOL: 'platform_image_list', MCP_SMOKE_ARGS: '{"view":"mine"}', FIXTURE_EXIT: '23' });
  assert.equal(result.status, 23); const call = JSON.parse(fs.readFileSync(s.log, 'utf8'));
  assert.equal(call.tool, 'platform_image_list'); assert.equal(call.input, '{"view":"mine"}');
});
