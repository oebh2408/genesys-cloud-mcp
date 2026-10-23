import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { createServer, DemoPlatformClient } from '../src/index.js';

// Wednesday 11:00 in the demo center's time zone.
const now = () => new Date('2026-10-21T16:00:00Z');
let client: Client;

async function call(name: string, args: Record<string, unknown> = {}) {
  const res = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
  if (res.isError) throw new Error(res.content[0]!.text);
  return JSON.parse(res.content[0]!.text);
}

beforeAll(async () => {
  const server = createServer({ client: new DemoPlatformClient(now), now, timeZone: 'America/Bogota', demo: true });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(b);
});

describe('server', () => {
  it('exposes read-only tools and a prompt', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([
      'list_queues',
      'get_queue_status',
      'get_queue_performance',
      'list_agents',
      'get_agent_performance',
      'search_conversations',
      'get_conversation',
    ]);
    for (const t of tools) expect(t.annotations?.readOnlyHint).toBe(true);
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name)).toEqual(['queue_health_report']);
    expect(client.getInstructions()).toContain('fictional demo contact center');
  });

  it('lists queues', async () => {
    const res = await call('list_queues');
    expect(res.queues.map((q: { name: string }) => q.name)).toEqual(['Support', 'Billing', 'Sales', 'Retention', 'Spanish Support', 'Chat Support']);
    expect((await call('list_queues', { name: 'support' })).count).toBe(3);
  });

  it('live status adds up with the agent list', async () => {
    const status = await call('get_queue_status', { queues: ['Billing'] });
    const agents = await call('list_agents', { queue: 'Billing' });
    const row = status.queues[0];
    const onQueue = agents.agents.filter((a: { presence: string }) => a.presence === 'On Queue').length;
    expect(row.agentsOnQueue).toBe(onQueue);
    expect(row.agentsIdle + row.agentsInteracting + row.agentsNotResponding).toBe(row.agentsOnQueue);
  });

  it('queue performance matches the conversations behind it', async () => {
    const perf = await call('get_queue_performance', { queues: ['Billing'], interval: 'yesterday' });
    const row = perf.queues[0];
    expect(row.offered).toBeGreaterThan(50);
    expect(row.answered + row.abandoned).toBe(row.offered);
    expect(row.serviceLevelPercent).toBeGreaterThan(0);
    expect(row.serviceLevelPercent).toBeLessThanOrEqual(100);

    const inbound = await call('search_conversations', { queue: 'Billing', interval: 'yesterday', direction: 'inbound', limit: 1 });
    expect(inbound.totalHits).toBe(row.offered);
    const abandoned = await call('search_conversations', { queue: 'Billing', interval: 'yesterday', outcome: 'abandoned', limit: 1 });
    expect(abandoned.totalHits).toBe(row.abandoned);
  });

  it('splits performance into hourly buckets', async () => {
    const perf = await call('get_queue_performance', { queues: ['Support'], interval: 'yesterday', granularity: 'PT1H' });
    const row = perf.queues[0];
    const total = row.series.reduce((n: number, b: { offered: number }) => n + b.offered, 0);
    expect(total).toBe(row.offered);
    // the center opens at 08:00 local time (13:00 UTC)
    expect(row.series[0].start).toBe('2026-10-20T13:00:00.000Z');
  });

  it('agent performance is sorted and filtered by queue', async () => {
    const all = await call('get_agent_performance', { interval: 'yesterday', limit: 50 });
    const handled = all.agents.map((a: { handled: number }) => a.handled);
    expect(handled).toEqual([...handled].sort((a, b) => b - a));
    const billing = await call('get_agent_performance', { interval: 'yesterday', queue: 'Billing', limit: 50 });
    const names = billing.agents.map((a: { agent: string }) => a.agent);
    expect(names).toContain('Isabel Gómez');
    expect(names).not.toContain('Liam Brooks');
  });

  it('search returns masked customer data and get_conversation a timeline', async () => {
    const res = await call('search_conversations', { queue: 'Support', interval: 'yesterday', outcome: 'answered', minWaitSeconds: 1, limit: 5 });
    expect(res.conversations.length).toBeGreaterThan(0);
    for (const c of res.conversations) {
      expect(c.from).toMatch(/^\+1•••\d{4}$/);
      expect(c.customer).toMatch(/^[A-Z]\. [A-Z]\.$/);
      expect(c.queue).toBe('Support');
      expect(c.waitSeconds).toBeGreaterThanOrEqual(1);
    }
    const detail = await call('get_conversation', { conversationId: res.conversations[0].conversationId });
    const steps = detail.timeline.map((t: { what: string }) => t.what);
    expect(steps[0]).toBe('waiting in queue');
    expect(steps).toContain('talking');
    expect(steps.at(-1)).toBe('after-call work');
    expect(detail.timeline.at(-1).wrapUp).toBeTypeOf('string');
  });

  it('reports unknown names as tool errors', async () => {
    const res = (await client.callTool({ name: 'get_queue_status', arguments: { queues: ['Nope'] } })) as { isError?: boolean; content: { text: string }[] };
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("No queue matches 'Nope'");
  });
});

describe('demo org', () => {
  it('is deterministic', async () => {
    const a = new DemoPlatformClient(now);
    const b = new DemoPlatformClient(now);
    const body = { interval: '2026-10-20T00:00:00Z/2026-10-21T00:00:00Z', groupBy: ['queueId'], metrics: ['nOffered', 'tAnswered'] };
    const path = '/api/v2/analytics/conversations/aggregates/query';
    expect(await a.request('POST', path, { body })).toEqual(await b.request('POST', path, { body }));
  });
});
