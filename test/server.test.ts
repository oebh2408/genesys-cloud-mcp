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
      'get_quality_summary',
      'list_evaluations',
      'get_survey_summary',
      'list_survey_responses',
      'get_adherence',
      'get_agent_schedule',
      'get_staffing',
      'get_callbacks',
      'get_campaigns',
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
    // callers who took a callback left the queue without being answered or abandoning
    expect(row.leftForCallback).toBeGreaterThan(0);
    expect(row.answered + row.abandoned + row.leftForCallback).toBe(row.offered);
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
      // nine-hour shifts, less a late login or an early finish
      expect(a.loggedInMinutes).toBeGreaterThan(500);
      expect(a.loggedInMinutes).toBeLessThanOrEqual(540);
      expect(a.onQueueMinutes + a.offQueueMinutes).toBe(a.loggedInMinutes);
      expect(Math.abs(a.idleMinutes + a.interactingMinutes - a.onQueueMinutes)).toBeLessThanOrEqual(2);
      // lunch is scheduled for 30 minutes: shorter when an interaction runs into it, longer when it runs over
      expect(a.offQueueBy.mealMinutes).toBeGreaterThan(10);
      expect(a.offQueueBy.mealMinutes).toBeLessThanOrEqual(40);
      expect(a.occupancyPercent).toBeGreaterThan(20);
    }
  });

  it('timeline covers the shift and lists the interactions handled', async () => {
    const tl = await call('get_agent_timeline', { agent: 'Karen Diaz', interval: 'yesterday' });
    // shift 11:00-20:00 local
    expect(tl.timeline[0].start >= '2026-10-20T16:00:00Z' && tl.timeline[0].start < '2026-10-20T16:15:00Z').toBe(true);
    expect(tl.timeline.at(-1).end > '2026-10-21T00:40:00Z' && tl.timeline.at(-1).end <= '2026-10-21T01:00:00Z').toBe(true);
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
    const callbacks = await call('get_callbacks', { interval: 'yesterday' });
    const requested = callbacks.queues.filter((q: { queue: string }) => q.queue !== 'Spanish Support').reduce((n: number, q: { requested: number }) => n + q.requested, 0);
    // callbacks are offered to the queue but do not go through the IVR
    expect(main.transferredOut).toBe(perf.queues.reduce((n: number, q: { offered: number }) => n + q.offered, 0) - requested);
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

  it('quality summary and evaluation list agree', async () => {
    const sum = await call('get_quality_summary', { interval: 'last 7d' });
    expect(sum.total.evaluations).toBeGreaterThan(50);
    expect(sum.total.avgScore).toBeGreaterThan(60);
    const list = await call('list_evaluations', { interval: 'last 7d', limit: 100 });
    expect(list.released).toBe(sum.total.evaluations);
    const failures = await call('list_evaluations', { interval: 'last 7d', criticalFailuresOnly: true, limit: 100 });
    expect(failures.evaluations.every((e: { criticalScore: number }) => e.criticalScore < 100)).toBe(true);
    const byEvaluator = await call('get_quality_summary', { interval: 'last 7d', groupBy: 'evaluator' });
    expect(byEvaluator.rows.map((r: { evaluator: string }) => r.evaluator).sort()).toEqual(['Laura Benítez', 'Marco Silva']);
    const isabel = await call('list_evaluations', { interval: 'last 30d', agent: 'Isabel' });
    expect(isabel.evaluations.every((e: { agent: string }) => e.agent === 'Isabel Gómez')).toBe(true);
  });

  it('survey summary, NPS and masked comments', async () => {
    const sum = await call('get_survey_summary', { interval: 'last 7d' });
    const t = sum.total;
    expect(t.responses).toBeLessThan(t.sent);
    expect(t.nps).toBe(Math.round(((t.promoters - t.detractors) / t.responses) * 100));
    const rows = sum.rows.reduce((n: number, r: { sent: number }) => n + r.sent, 0);
    expect(rows).toBe(t.sent);
    const detractors = await call('list_survey_responses', { interval: 'last 30d', only: 'detractors', limit: 50 });
    expect(detractors.responses.every((r: { nps: number }) => r.nps <= 6)).toBe(true);
    const comments = detractors.responses.map((r: { comment?: string }) => r.comment).filter(Boolean).join(' ');
    expect(comments).not.toMatch(/555-201-8890|maria\.lopez@/);
    expect(comments).toMatch(/•••8890|m•••@example\.net/);
  });

  it('adherence compares the schedule with what agents do', async () => {
    const res = await call('get_adherence', { queue: 'Support' });
    expect(res.agents).toBeGreaterThan(5);
    expect(res.inAdherence + res.outOfAdherence).toBe(res.agents);
    for (const r of res.rows) {
      if (r.adherence === 'InAdherence') expect(r.scheduled).toBe(r.actual);
      else expect(r.scheduled).not.toBe(r.actual);
    }
    // out of adherence first
    expect(res.rows[0].adherence).toBe(res.outOfAdherence ? 'OutOfAdherence' : 'InAdherence');
  });

  it('schedules have breaks and lunch, and staffing follows them', async () => {
    const sched = await call('get_agent_schedule', { agents: ['Chloe Martin'] });
    const shift = sched.agents[0].shifts[0];
    expect(shift).toMatchObject({ start: '09:00', end: '18:00', paidMinutes: 510, onQueueMinutes: 480 });
    expect(shift.activities.map((a: { category: string }) => a.category)).toEqual(['OnQueueWork', 'Break', 'OnQueueWork', 'Meal', 'OnQueueWork', 'Break', 'OnQueueWork']);
    const weekend = await call('get_agent_schedule', { queue: 'Support', day: '2026-10-24' });
    expect(weekend.notScheduled.length).toBeGreaterThan(0);
    expect(weekend.agents.every((a: { shifts: { start: string }[] }) => a.shifts[0]!.start === '09:00')).toBe(true);
    const staffing = await call('get_staffing', { queue: 'Billing', day: 'yesterday', granularity: 'PT1H' });
    const perf = await call('get_queue_performance', { queues: ['Billing'], interval: 'yesterday' });
    expect(staffing.series.reduce((n: number, r: { offered: number }) => n + r.offered, 0)).toBe(perf.queues[0].offered);
    for (const r of staffing.series) expect(r.actualOnQueue).toBeLessThanOrEqual(staffing.members);
    const holiday = await call('get_agent_schedule', { queue: 'Billing', day: '2026-11-02' });
    expect(holiday.scheduled).toBe(0);
  });

  it('callbacks and outbound campaigns', async () => {
    const cb = await call('get_callbacks', { interval: 'yesterday' });
    const billing = cb.queues.find((q: { queue: string }) => q.queue === 'Billing');
    const perf = await call('get_queue_performance', { queues: ['Billing'], interval: 'yesterday' });
    expect(billing.requested).toBe(perf.queues[0].leftForCallback);
    expect(billing.completed).toBeLessThanOrEqual(billing.requested);
    const camps = await call('get_campaigns', { interval: 'last 7d' });
    const upgrade = camps.campaigns.find((c: { campaign: string }) => c.campaign === 'Upgrade offers');
    expect(upgrade).toMatchObject({ status: 'on', queue: 'Sales', dialingMode: 'progressive' });
    expect(upgrade.inInterval.attempted).toBeGreaterThanOrEqual(upgrade.inInterval.connected);
    expect(upgrade.inInterval.wrapUps.map((w: { wrapUp: string }) => w.wrapUp)).toContain('Sale completed');
    expect(camps.campaigns.find((c: { campaign: string }) => c.campaign === 'Payment reminders').progress.percent).toBe(100);
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
