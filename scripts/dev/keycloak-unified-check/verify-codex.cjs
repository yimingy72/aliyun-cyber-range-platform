// Run inside the fresh Codex test container, never against a live server.
const assert = require('node:assert/strict');
const { homedir } = require('node:os');
const { join } = require('node:path');
const url = 'http://127.0.0.1:13463/mcp';
const name = 'isolated-range';
const entries = Object.values(require(join(homedir(), '.codex/.credentials.json')));
const entry = entries.find(item => item.server_name === name && item.server_url === url);
assert(entry?.access_token, 'Complete Codex browser login first');

async function rpc(method, params, extra = {}) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
      Authorization: 'Bearer ' + entry.access_token, ...extra },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = await response.text();
  const data = body.split('\n').find(line => line.startsWith('data:'))?.slice(5) || body;
  return { status: response.status, data: JSON.parse(data) };
}
(async () => {
  const list = await rpc('tools/list', {});
  assert.equal(list.status, 200);
  const names = list.data.result.tools.map(tool => tool.name);
  assert(names.includes('range_template_list'));
  assert(!names.some(tool => /^(admin_user_|billing_)/.test(tool)));
  const call = { name: 'range_template_list', arguments: { view: 'platform' } };
  const read = await rpc('tools/call', call);
  assert.equal(read.status, 200);
  assert(!read.data.result?.isError);
  const content = JSON.stringify(read.data.result);
  assert(content.includes('fixture-template-alpha') && !content.includes('fixture-template-beta') && !content.includes('fixture-template-private'));
  assert.equal((await rpc('tools/call', call, { 'x-cloud-workspace-id': 'fixture-beta' })).status, 403);
  const denied = await rpc('tools/call', { name: 'admin_user_list', arguments: {} });
  assert(denied.data.error || denied.data.result?.isError);
  console.log('Codex OAuth credential: own-workspace shared template visible; foreign workspace and administrator tools denied.');
})().catch(error => { console.error(error.message); process.exitCode = 1; });
