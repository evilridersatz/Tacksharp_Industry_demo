/**
 * MCP server tools and keys, DB-backed (real MySQL TEST database). Proves: keys are shown once and stored only as a
 * SHA-256 hash; unknown / revoked keys and suspended organizations are refused; initialize negotiates versions;
 * tools/list hides write tools from read keys; every tool returns this organization's data only with phones masked;
 * write tools need a write key and really change the records; no tool can contact a customer; tool errors come back as
 * isError results; JSON-RPC errors for bad requests / unknown methods; notifications get no answer; rate limit; audit.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const enabled = Boolean(process.env.TEST_DB_NAME);
if (enabled) {
  process.env.DB_NAME = process.env.TEST_DB_NAME;
  process.env.DB_HOST ??= '127.0.0.1';
}
const run = Date.now().toString(36);
const ORG = `org_mcp_a_${run}`;
const ORG_B = `org_mcp_b_${run}`;

describe.skipIf(!enabled)('MCP server (integration)', () => {
  let prisma: any, svc: any, readKey: any, writeKey: any, cust: any, other: any, conv: any, outlet: any;
  const admin = { sub: `mcp-admin-${run}`, org: ORG };
  const call = async (raw: string, method: string, params: Record<string, unknown> = {}, id: number = 1) => {
    const key = await svc.authenticate(`Bearer ${raw}`);
    return svc.handle(key, { jsonrpc: '2.0', id, method, params });
  };
  const tool = async (raw: string, name: string, args: Record<string, unknown> = {}) => (await call(raw, 'tools/call', { name, arguments: args })).result;

  beforeAll(async () => {
    const { PrismaService } = await import('../src/prisma/prisma.service.js');
    const { McpService } = await import('../src/mcp/mcp.service.js');
    const { CustomersService } = await import('../src/customers/customers.service.js');
    const { AnalyticsService } = await import('../src/analytics/analytics.service.js');
    prisma = new PrismaService();
    await prisma.$connect();
    for (const id of [ORG, ORG_B]) await prisma.organization.create({ data: { id, name: id, vertical: 'restaurant' } });
    outlet = await prisma.outlet.create({ data: { organizationId: ORG, name: 'Mcp outlet', address: 'Chennai' } });
    svc = new McpService(prisma, new CustomersService(prisma), new AnalyticsService(prisma));
    readKey = await svc.createKey(admin, { name: 'Claude read', scope: 'read' });
    writeKey = await svc.createKey(admin, { name: 'Claude write', scope: 'write' });
    cust = await prisma.customer.create({ data: { organizationId: ORG, name: `Meena Mcp ${run}`, phone: `9190${String(Date.now()).slice(-8)}`, messagingConsent: true } });
    other = await prisma.customer.create({ data: { organizationId: ORG_B, name: `Meena Mcp ${run} other`, phone: `9189${String(Date.now()).slice(-8)}` } });
    conv = await prisma.conversation.create({ data: { id: `conv_mcp_${run}`, organizationId: ORG, channel: 'whatsapp', externalId: cust.phone, customerId: cust.id, status: 'active', updatedAt: new Date() } });
    await prisma.message.create({ data: { id: `msg_mcp_${run}_1`, organizationId: ORG, conversationId: conv.id, role: 'user', content: '1 kg broiler for 6 pm' } });
    await prisma.message.create({ data: { id: `msg_mcp_${run}_2`, organizationId: ORG, conversationId: conv.id, role: 'assistant', content: 'Ready at 6 pm. ₹220.' } });
    await prisma.order.create({ data: { organizationId: ORG, orderNumber: `MCP-${run}`, customerId: cust.id, outletId: outlet.id, channel: 'whatsapp', status: 'confirmed', pickupAt: new Date(), subtotal: 220, total: 220, paymentMethod: 'cash', idempotencyKey: `mcp-${run}` } });
  }, 60_000);

  afterAll(async () => {
    if (!prisma) return;
    for (const org of [ORG, ORG_B]) {
      await prisma.order.deleteMany({ where: { organizationId: org } });
      await prisma.mcpAccessKey.deleteMany({ where: { organizationId: org } });
      await prisma.workTask.deleteMany({ where: { organizationId: org } });
    }
    await prisma.organization.deleteMany({ where: { id: { in: [ORG, ORG_B] } } });
    await prisma.$disconnect();
  });

  it('keys: shown once, only the hash stored; bad / revoked / suspended refused', async () => {
    expect(readKey.key).toMatch(/^tsk_mcp_[A-Za-z0-9_-]{32}$/);
    const row = await prisma.mcpAccessKey.findUnique({ where: { id: readKey.id } });
    expect(row.keyHash).toHaveLength(64);
    expect(JSON.stringify(row)).not.toContain(readKey.key);
    expect((await svc.listKeys(ORG)).every((k: any) => !('keyHash' in k) && !('key' in k))).toBe(true);
    expect(await svc.authenticate(undefined)).toBeNull();
    expect(await svc.authenticate(`Bearer ${readKey.key}x`)).toBeNull();
    expect(await svc.authenticate(readKey.key)).toBeNull(); // no "Bearer"
    expect(await svc.authenticate(`Bearer ${readKey.key}`)).toMatchObject({ organizationId: ORG, scope: 'read' });
    const tmp = await svc.createKey(admin, { name: 'temp' });
    await expect(svc.revokeKey({ sub: 'x', org: ORG_B }, tmp.id)).rejects.toThrow(/not found/);
    await svc.revokeKey(admin, tmp.id);
    expect(await svc.authenticate(`Bearer ${tmp.key}`)).toBeNull();
    await prisma.organization.update({ where: { id: ORG }, data: { status: 'suspended' } });
    expect(await svc.authenticate(`Bearer ${readKey.key}`)).toBeNull();
    await prisma.organization.update({ where: { id: ORG }, data: { status: 'active' } });
    await expect(svc.createKey(admin, { name: '' })).rejects.toThrow(/name/);
  });

  it('protocol: initialize negotiates, ping, tools/list by scope, unknown method, invalid request, notification', async () => {
    expect((await call(readKey.key, 'initialize', { protocolVersion: '2025-06-18' })).result.protocolVersion).toBe('2025-06-18');
    expect((await call(readKey.key, 'initialize', { protocolVersion: '1999-01-01' })).result.protocolVersion).toBe('2025-11-25');
    expect((await call(readKey.key, 'ping')).result).toEqual({});
    const readTools = (await call(readKey.key, 'tools/list')).result.tools.map((t: any) => t.name);
    const writeTools = (await call(writeKey.key, 'tools/list')).result.tools.map((t: any) => t.name);
    expect(readTools).toEqual(['search_customers', 'get_customer', 'list_conversations', 'get_conversation', 'list_orders', 'analytics_summary']);
    expect(writeTools).toEqual([...readTools, 'add_customer_note', 'set_customer_stage', 'create_task']);
    expect(writeTools.some((n: string) => /send|call|message_customer|whatsapp/.test(n))).toBe(false);
    expect((await call(readKey.key, 'nope/method')).error).toMatchObject({ code: -32601 });
    const key = await svc.authenticate(`Bearer ${readKey.key}`);
    expect(await svc.handle(key, { jsonrpc: '1.0', id: 3, method: 'ping' })).toMatchObject({ error: { code: -32600 } });
    expect(await svc.handle(key, { jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull();
    expect((await call(readKey.key, 'tools/call', { name: 'drop_database' })).error).toMatchObject({ code: -32602 });
  });

  it('read tools: this organization only, phones masked', async () => {
    const found = await tool(readKey.key, 'search_customers', { query: `Meena Mcp ${run}` });
    expect(found.isError).toBe(false);
    expect(found.structuredContent.items).toEqual([expect.objectContaining({ id: cust.id, phone: `••••${cust.phone.slice(-4)}`, stage: 'new' })]);
    expect(found.content[0].text).not.toContain(cust.phone);
    expect((await tool(readKey.key, 'search_customers', { query: cust.phone.slice(-6) })).structuredContent.items.map((c: any) => c.id)).toEqual([cust.id]);
    expect((await tool(readKey.key, 'search_customers', { query: 'a' })).isError).toBe(true);
    const detail = await tool(readKey.key, 'get_customer', { customerId: cust.id });
    expect(detail.structuredContent).toMatchObject({ name: `Meena Mcp ${run}`, consent: { whatsapp: true }, orders: [expect.objectContaining({ orderNumber: `MCP-${run}`, total: 220 })], lastConversation: { messages: [{ from: 'customer', text: '1 kg broiler for 6 pm' }, { from: 'business', text: 'Ready at 6 pm. ₹220.' }] } });
    expect(await tool(readKey.key, 'get_customer', { customerId: other.id })).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/not found/) }] });
    expect((await tool(readKey.key, 'list_conversations', { status: 'all' })).structuredContent.items.map((c: any) => c.id)).toEqual([conv.id]);
    expect((await tool(readKey.key, 'get_conversation', { conversationId: conv.id })).structuredContent.messages).toHaveLength(2);
    expect((await tool(readKey.key, 'list_orders', { days: 7 })).structuredContent.items.map((o: any) => o.orderNumber)).toEqual([`MCP-${run}`]);
    const a = await tool(readKey.key, 'analytics_summary', { days: 7 });
    expect(a.structuredContent.kpis.inboundMessages.value).toBe(1);
  });

  it('write tools: refused with a read key; with a write key they change the records; audited', async () => {
    expect(await tool(readKey.key, 'add_customer_note', { customerId: cust.id, note: 'x' })).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/write access/) }] });
    expect((await tool(writeKey.key, 'add_customer_note', { customerId: cust.id, note: 'Prefers pickup after 6 pm' })).isError).toBe(false);
    expect(await prisma.customerNote.findFirst({ where: { customerId: cust.id } })).toMatchObject({ body: 'Prefers pickup after 6 pm', authorName: 'AI assistant (Claude write)' });
    expect((await tool(writeKey.key, 'set_customer_stage', { customerId: cust.id, stage: 'qualified' })).structuredContent).toEqual({ customerId: cust.id, stage: 'qualified' });
    expect((await prisma.customer.findUnique({ where: { id: cust.id } })).stage).toBe('qualified');
    expect((await tool(writeKey.key, 'set_customer_stage', { customerId: cust.id, stage: 'vip' })).isError).toBe(true);
    expect((await tool(writeKey.key, 'set_customer_stage', { customerId: other.id, stage: 'lost' })).isError).toBe(true);
    expect((await prisma.customer.findUnique({ where: { id: other.id } })).stage).toBeNull();
    const t = await tool(writeKey.key, 'create_task', { customerId: cust.id, title: 'Call back about bulk order', dueInDays: 1 });
    expect(t.structuredContent).toMatchObject({ title: 'Call back about bulk order' });
    expect(await prisma.workTask.count({ where: { organizationId: ORG, entityId: cust.id } })).toBe(1);
    const audits = await prisma.auditEvent.findMany({ where: { organizationId: ORG, entityType: 'mcp', action: 'mcp.tool_called' } });
    expect(audits.length).toBeGreaterThanOrEqual(10);
    expect(audits.some((x: any) => x.data.tool === 'set_customer_stage' && x.data.write === true && x.actor === `mcp:${writeKey.id}`)).toBe(true);
  });

  it('rate limit per key', () => {
    const id = `rl-${run}`;
    let limited = false;
    for (let i = 0; i < 121; i++) limited = svc.rateLimited(id);
    expect(limited).toBe(true);
    expect(svc.rateLimited(`other-${run}`)).toBe(false);
  });
});
