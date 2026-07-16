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
    const result = await client.callTool({
      name: toolName,
      arguments: args,
    });

    process.stdout.write(
      `${JSON.stringify({
        toolCount: tools.tools.length,
        toolNames: tools.tools.map((tool) => tool.name).sort(),
        toolName,
        result: result.structuredContent ?? null,
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

void main();
