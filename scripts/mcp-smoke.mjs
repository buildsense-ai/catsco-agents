#!/usr/bin/env node
// 联调/冒烟：对平台 MCP 端点执行 tools/list（可选 tools/call）。
// 用法：node scripts/mcp-smoke.mjs <mcp-url> <jwt> [tool] [input-json]
// 例：node scripts/mcp-smoke.mjs https://app.catsco.cc/api/mcp "$TOKEN" catsco_hello '{"input":{"text":"hi"},"client_token":"smoke-1"}'
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const [url, token, tool, inputJson] = process.argv.slice(2);
if (!url || !token) {
  console.error('usage: node scripts/mcp-smoke.mjs <mcp-url> <jwt> [tool] [input-json]');
  process.exit(2);
}

const client = new Client({ name: 'catsco-mcp-smoke', version: '0.1.0' });
const transport = new StreamableHTTPClientTransport(new URL(url), {
  requestInit: { headers: { authorization: `Bearer ${token}` } },
});

await client.connect(transport);
const tools = await client.listTools();
console.log('tools:', tools.tools.map((t) => t.name).join(', '));

if (tool) {
  const result = await client.callTool({
    name: tool,
    arguments: inputJson ? JSON.parse(inputJson) : {},
  });
  console.log(JSON.stringify(result, null, 2));
}

await client.close();
