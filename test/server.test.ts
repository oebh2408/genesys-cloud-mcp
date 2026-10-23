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
      'get_queue',
      'get_queue_status',
      'get_queue_performance',
      'compare_queue_performance',
      'list_agents',
      'get_agent',
      'get_agent_performance',
      'get_agent_status_summary',
      'get_agent_timeline',
      'search_conversations',
      'get_conversation',
      'get_wrapup_summary',
      'get_flow_performance',
      'get_schedule_status',
    ]);
    for (const t of tools) expect(t.annotations?.readOnlyHint).toBe(true);
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name)).toEqual(['queue_health_report', 'daily_summary', 'agent_review', 'abandon_investigation']);
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

  it('queue configuration lists the queue wrap-up codes and members', async () => {
    const q = await call('get_queue', { queue: 'Retention' });
    expect(q.media[0]).toMatchObject({ media: 'call', serviceLevelPercent: 80, serviceLevelSeconds: 20 });
    expect(q.wrapUpCodes).toContain('Cancellation saved');
    expect(q.wrapUpCodes).not.toContain('Payment taken');
    const members = await call('list_agents', { queue: 'Retention' });
    expect(q.members.total).toBe(members.count);
    expect(q.agents.find((a: { name: string }) => a.name === 'Pablo Vega').skills.join(' ')).toMatch(/Retention \d/);
  });

  it('compares with the same interval a week earlier', async () => {
    const cmp = await call('compare_queue_performance', { queues: ['Support'], interval: 'yesterday' });
    expect(cmp.comparedWith).toBe('2026-10-13T05:00:00.000Z/2026-10-14T05:00:00.000Z');
    const now = await call('get_queue_performance', { queues: ['Support'], interval: 'yesterday' });
    const before = await call('get_queue_performance', { queues: ['Support'], interval: cmp.comparedWith });
    const row = cmp.queues[0];
    expect(row.offered).toMatchObject({ current: now.queues[0].offered, previous: before.queues[0].offered, change: now.queues[0].offered - before.queues[0].offered });
    expect(row.serviceLevelPercent.changePercent).toBeUndefined();
  });

  it('agent profile shows queues, skills and today', async () => {
    const a = await call('get_agent', { agent: 'Daniel' });
    expect(a.agent).toBe('Daniel Ruiz');
    expect(a.queues.map((q: { queue: string }) => q.queue).sort()).toEqual(['Spanish Support', 'Support']);
    expect(a.skills.map((s: { skill: string }) => s.skill)).toEqual(['Spanish', 'Technical']);
    expect(a.languages.map((l: { language: string }) => l.language)).toContain('Spanish');
    // Daniel starts at 11:00 local, the clock is at 11:00
    expect(a.today.handled).toBe(0);
  });

  it('status summary adds up and includes lunch', async () => {
    const res = await call('get_agent_status_summary', { queue: 'Billing', interval: 'yesterday' });
    expect(res.count).toBe(5);
    for (const a of res.agents) {
      expect(a.loggedInMinutes).toBe(540);
      expect(a.onQueueMinutes + a.offQueueMinutes).toBe(a.loggedInMinutes);
      expect(Math.abs(a.idleMinutes + a.interactingMinutes - a.onQueueMinutes)).toBeLessThanOrEqual(2);
      // lunch is 30 minutes, shorter when an interaction runs into it
      expect(a.offQueueBy.mealMinutes).toBeGreaterThan(10);
      expect(a.offQueueBy.mealMinutes).toBeLessThanOrEqual(30);
      expect(a.occupancyPercent).toBeGreaterThan(20);
    }
  });

  it('timeline covers the shift and lists the interactions handled', async () => {
    const tl = await call('get_agent_timeline', { agent: 'Karen Diaz', interval: 'yesterday' });
    expect(tl.timeline[0].start).toBe('2026-10-20T16:00:00Z');
    expect(tl.timeline.at(-1).end).toBe('2026-10-21T01:00:00Z');
    for (let i = 1; i < tl.timeline.length; i++) expect(tl.timeline[i].start).toBe(tl.timeline[i - 1].end);
    expect(tl.timeline.map((t: { presence: string }) => t.presence)).toContain('Meal');
    const perf = await call('get_agent_performance', { agents: ['Karen Diaz'], interval: 'yesterday' });
    expect(tl.interactions.total).toBe(perf.agents[0].handled);
    const detailed = await call('get_agent_timeline', { agent: 'Karen Diaz', interval: 'yesterday', detail: 'routing' });
    expect(detailed.timeline.map((t: { routingStatus: string }) => t.routingStatus)).toContain('INTERACTING');
    await expect(call('get_agent_timeline', { agent: 'Karen Diaz', interval: 'last 30d' })).rejects.toThrow(/at most 7 days/);
  });

  it('wrap-up codes add up to the interactions handled', async () => {
    const w = await call('get_wrapup_summary', { queue: 'Billing', interval: 'yesterday' });
    const perf = await call('get_agent_performance', { queue: 'Billing', interval: 'yesterday', limit: 50 });
    expect(w.total).toBe(perf.agents.reduce((n: number, a: { handled: number }) => n + a.handled, 0));
    expect(w.wrapUps[0].count).toBeGreaterThanOrEqual(w.wrapUps.at(-1).count);
    expect(Math.round(w.wrapUps.reduce((n: number, x: { percent: number }) => n + x.percent, 0))).toBe(100);
  });

  it('IVR transfers match what the queues were offered', async () => {
    const flows = await call('get_flow_performance', { interval: 'yesterday' });
    const main = flows.flows.find((f: { flow: string }) => f.flow === 'Main IVR');
    const perf = await call('get_queue_performance', { queues: ['Support', 'Billing', 'Sales', 'Retention'], interval: 'yesterday' });
    expect(main.transferredOut).toBe(perf.queues.reduce((n: number, q: { offered: number }) => n + q.offered, 0));
    expect(main.entered).toBe(main.transferredOut + main.endedInFlow);
    expect(main.outcomesSucceeded).toBeGreaterThan(0);
    const hourly = await call('get_flow_performance', { flows: ['chat bot'], interval: 'yesterday', granularity: 'PT1H' });
    expect(hourly.flows[0].series.reduce((n: number, b: { entered: number }) => n + b.entered, 0)).toBe(hourly.flows[0].entered);
  });

  it('opening hours, holidays and the next change', async () => {
    const now = await call('get_schedule_status');
    expect(now.scheduleGroups[0]).toMatchObject({ status: 'open', localTime: '2026-10-21 11:00', nextChange: { localTime: '2026-10-21 20:00', status: 'closed' } });
    expect(now.scheduleGroups[0].upcomingHolidays[0]).toEqual({ name: "All Saints' Day", date: '2026-11-02' });
    const holiday = await call('get_schedule_status', { at: '2026-11-02T15:00:00Z' });
    expect(holiday.scheduleGroups[0]).toMatchObject({ status: 'holiday', schedule: "All Saints' Day", nextChange: { localTime: '2026-11-03 00:00' } });
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
