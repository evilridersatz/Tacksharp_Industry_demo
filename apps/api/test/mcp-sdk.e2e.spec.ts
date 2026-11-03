/**
 * Interoperability with the OFFICIAL MCP TypeScript SDK client (@modelcontextprotocol/sdk, devDependency) over real
 * HTTP against a running API: initialize / version negotiation, tools/list, tools/call with structured results, a tool
 * error, a write tool refused for a read key, and a wrong key refused. Needs a running API and a key:
 *
 *   MCP_E2E_URL=http://localhost:3000/mcp MCP_E2E_KEY=tsk_mcp_... npx vitest run test/mcp-sdk.e2e.spec.ts
 */
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const URL_ = process.env.MCP_E2E_URL;
const KEY = process.env.MCP_E2E_KEY;

async function connect(key: string) {
  const client = new Client({ name: 'tacksharp-e2e', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(URL_!), { requestInit: { headers: { Authorization: `Bearer ${key}` } } });
  await client.connect(transport);
  return client;
}

describe.skipIf(!URL_ || !KEY)('MCP server with the official SDK client (e2e)', () => {
  it('connects, negotiates, lists and calls tools', async () => {
    const client = await connect(KEY!);
    expect(client.getServerVersion()).toMatchObject({ name: 'tacksharp' });
    expect(client.getServerCapabilities()).toMatchObject({ tools: {} });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(['search_customers', 'get_customer', 'list_conversations', 'list_orders', 'analytics_summary']));
    expect(tools.every((t) => t.inputSchema.type === 'object')).toBe(true);
    const a = await client.callTool({ name: 'analytics_summary', arguments: { days: 7 } });
    expect(a.isError).toBe(false);
    expect((a.structuredContent as { days: number }).days).toBe(7);
    const s = await client.callTool({ name: 'search_customers', arguments: { query: 'zz-no-such-customer-zz' } });
    expect((s.structuredContent as { items: unknown[] }).items).toEqual([]);
    const bad = await client.callTool({ name: 'search_customers', arguments: { query: 'a' } });
    expect(bad.isError).toBe(true);
    await expect(client.callTool({ name: 'no_such_tool', arguments: {} })).rejects.toThrow();
    expect(await client.ping()).toEqual({});
    await client.close();
  }, 30_000);

  it('a wrong key cannot connect', async () => {
    await expect(connect('tsk_mcp_wrongwrongwrongwrongwrongwrongwr')).rejects.toThrow();
  }, 30_000);
});
