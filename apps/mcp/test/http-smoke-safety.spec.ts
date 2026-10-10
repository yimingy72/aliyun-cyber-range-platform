import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import * as z from 'zod/v4';

const exec = promisify(execFile);
const calls: string[] = [];
const canary = 'fixture-only-secret-result';
const tools = [
  ['range_template_list', true], ['fixture_rejected_read', true], ['range_instance_launch', false],
  ['single_instance_get_access', true], ['range_instance_get_access', true],
  ['single_instance_batch_export_csv', true], ['range_instance_node_open_vnc', true],
] as const;
const app = createServer(async (req, res) => {
  const server = new McpServer({ name: 'offline-smoke-fixture', version: '1' });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  try {
    for (const [name, readOnlyHint] of tools) {
      server.registerTool(name, { inputSchema: z.object({ view: z.string().optional() }), annotations: { readOnlyHint } }, async () => {
        calls.push(name); return { ...(name === 'fixture_rejected_read' ? { isError: true } : {}), content: [{ type: 'text', text: canary }], structuredContent: { result: { password: canary } } };
      });
    }
    await server.connect(transport); await transport.handleRequest(req, res);
  } finally { await transport.close(); await server.close(); }
});
let url = '';
beforeAll(async () => {
  app.listen(0, '127.0.0.1'); await once(app, 'listening');
  url = `http://127.0.0.1:${(app.address() as import('node:net').AddressInfo).port}/mcp`;
});
afterAll(async () => { await new Promise<void>((resolve, reject) => app.close(error => error ? reject(error) : resolve())); });
async function run(tool: string, entry = 'http-smoke.ts') {
  calls.length = 0;
  try {
    const result = await exec(process.execPath, ['--import', 'tsx', path.resolve('scripts', entry)], {
      cwd: path.resolve('.'), env: { ...process.env, MCP_URL: url, MCP_BEARER_TOKEN: 'fixture-token', MCP_SMOKE_TOOL: tool, MCP_SMOKE_ARGS: '{"view":"platform"}' },
    });
    return { ...result, code: 0 };
  } catch (error) {
    const result = error as { stdout: string; stderr: string; code: number };
    return { stdout: result.stdout, stderr: result.stderr, code: result.code };
  }
}
describe('read-only SDK smoke', () => {
  it.each(['http-smoke.ts', 'smoke.ts'])('uses the existing gateway through %s without printing business results', async entry => {
    const result = await run('range_template_list', entry);
    expect(result.code).toBe(0); expect(calls).toEqual(['range_template_list']);
    expect(JSON.parse(result.stdout)).toMatchObject({ toolName: 'range_template_list', ok: true });
    expect(result.stdout + result.stderr).not.toContain(canary);
  });
  it('fails on a rejected read without printing its error payload', async () => {
    const result = await run('fixture_rejected_read');
    expect(result.code).toBe(1); expect(calls).toEqual(['fixture_rejected_read']);
    expect(result.stdout + result.stderr).not.toContain(canary);
  });
  it.each(tools.slice(2).map(([name]) => name))('rejects %s before a sensitive read or mutation', async tool => {
    const result = await run(tool);
    expect(result.code).toBe(1); expect(calls).toEqual([]);
    expect(result.stdout + result.stderr).not.toContain(canary);
  });
});
