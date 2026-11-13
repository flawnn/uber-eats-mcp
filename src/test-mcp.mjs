// Spawns the MCP server over stdio (mock mode) and calls every tool through a
// real MCP client, verifying the wire protocol end to end.
// Usage: node src/test-mcp.mjs
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['--import', 'tsx', path.join(root, 'src', 'server.ts')],
  env: { ...process.env, UE_MOCK: '1' },
  stderr: 'pipe',
});

const client = new Client({ name: 'test-client', version: '0.0.1' });
await client.connect(transport);

const tools = await client.listTools();
console.log('TOOLS:', tools.tools.map((t) => t.name).join(', '));

for (const call of [
  { name: 'browse_feed', arguments: { maxStores: 3 } },
  { name: 'find_deals', arguments: { limit: 5, pages: 1 } },
  { name: 'best_value', arguments: { limit: 5, pages: 1 } },
  { name: 'search_stores', arguments: { query: 'pizza', limit: 3 } },
]) {
  const res = await client.callTool(call);
  const text = res.content?.[0]?.text ?? '';
  console.log(`\n===== ${call.name} -> ${text.length} bytes, isError=${!!res.isError} =====`);
  console.log(text.slice(0, 900));
}

await client.close();
console.log('\nMCP WIRE TEST DONE');
process.exit(0);
