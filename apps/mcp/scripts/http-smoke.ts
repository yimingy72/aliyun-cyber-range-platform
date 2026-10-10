import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

async function main() {
  const mcpUrl = requireEnv('MCP_URL');
  const token = requireEnv('MCP_BEARER_TOKEN');
  const toolName = process.env.MCP_SMOKE_TOOL?.trim() || 'range_template_list';
  const rawArgs = process.env.MCP_SMOKE_ARGS?.trim() || '{"view":"platform"}';
  const args = JSON.parse(rawArgs) as Record<string, unknown>;

  const client = new Client({ name: 'mcp-http-smoke', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
    requestInit: {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  });

  try {
    await client.connect(transport);

    const tools = await client.listTools();
    const tool = tools.tools.find(candidate => candidate.name === toolName);
    if (!tool || tool.annotations?.readOnlyHint !== true || /(?:credentials?|_get_access$|_open_vnc$|_batch_export_csv$)/.test(toolName)) {
      throw new Error('MCP smoke only permits an exposed read-only tool');
    }
    const result = await client.callTool({
      name: toolName,
      arguments: args,
    });

    if (result.isError) throw new Error('MCP smoke read operation was rejected');

    process.stdout.write(
      `${JSON.stringify({
        toolCount: tools.tools.length,
        toolNames: tools.tools.map((tool) => tool.name).sort(),
        toolName,
        ok: true,
      }, null, 2)}\n`,
    );
  } finally {
    await transport.close();
    await client.close();
  }
}

function requireEnv(name: string) {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

void main().catch(() => {
  process.stderr.write('MCP read-only smoke failed; check token, gateway availability and tool permissions.\n');
  process.exitCode = 1;
});
