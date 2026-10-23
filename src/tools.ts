import { z } from 'zod';
import type { PlatformClient } from './client/types.js';
import { Directory, type Named } from './directory.js';
import { maskAddress, maskName } from './redact.js';
import { resolveInterval } from './time.js';

export interface ToolContext {
  client: PlatformClient;
  directory: Directory;
  now: () => Date;
  timeZone: string;
  /** Mask customer phone numbers, emails and names. */
  redact: boolean;
}

export interface ToolDefinition<S extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  title: string;
  description: string;
  input: S;
  run(args: z.infer<z.ZodObject<S>>, ctx: ToolContext): Promise<unknown>;
}

const define = <S extends z.ZodRawShape>(t: ToolDefinition<S>) => t;

const intervalArg = z
  .string()
  .optional()
  .describe('today (default), yesterday, this_week, last 30m, last 4h, last 7d, or an ISO-8601 interval start/end');
const queuesArg = z.array(z.string()).optional().describe('Queue names or ids. Partial names work. Omit for all queues.');

// ---- API shapes --------------------------------------------------------------------------

interface Stat {
  count?: number;
  sum?: number;
  max?: number;
  ratio?: number;
  numerator?: number;
  denominator?: number;
}
interface AggregateResult {
  results?: { group: Record<string, string>; data?: { interval: string; metrics: { metric: string; stats: Stat }[] }[] }[];
}
interface ObservationResult {
  results?: { group: Record<string, string>; data?: { metric: string; qualifier?: string; stats: Stat; observations?: { observationDate: string }[] }[] }[];
}
interface Segment {
  segmentStart: string;
  segmentEnd?: string;
  segmentType: string;
  queueId?: string;
  wrapUpCode?: string;
  disconnectType?: string;
}
interface Session {
  mediaType: string;
  direction?: string;
  ani?: string;
  dnis?: string;
  segments?: Segment[];
  metrics?: { name: string; value: number }[];
}
interface Participant {
  participantId?: string;
  participantName?: string;
  purpose: string;
  userId?: string;
  sessions?: Session[];
}
interface Conversation {
  conversationId: string;
  conversationStart: string;
  conversationEnd?: string;
  originatingDirection?: string;
  participants?: Participant[];
}

// ---- tools -------------------------------------------------------------------------------

export const tools = [
  define({
    name: 'list_queues',
    title: 'List queues',
    description: 'List routing queues with their member counts. Use this to find the exact queue names before asking for metrics.',
    input: { name: z.string().optional().describe('Filter by name, case-insensitive, partial match') },
    async run({ name }, { directory }) {
      const needle = name?.toLowerCase();
      const queues = (await directory.queues()).filter((q) => !needle || q.name.toLowerCase().includes(needle));
      return { count: queues.length, queues: queues.map((q) => ({ id: q.id, name: q.name, description: q.description, members: q.memberCount })) };
    },
  }),

  define({
    name: 'get_queue_status',
    title: 'Live queue status',
    description: 'Current state of queues: interactions waiting, longest wait, interactions in progress, and agents on queue by routing status.',
    input: { queues: queuesArg },
    async run({ queues }, ctx) {
      const targets = queues?.length ? await ctx.directory.resolveQueues(queues) : await ctx.directory.queues();
      if (!targets.length) return { queues: [] };
      const res = await ctx.client.request<ObservationResult>('POST', '/api/v2/analytics/queues/observations/query', {
        body: {
          filter: { type: 'or', predicates: targets.map((q) => ({ dimension: 'queueId', value: q.id })) },
          metrics: ['oWaiting', 'oInteracting', 'oOnQueueUsers', 'oOffQueueUsers'],
          detailMetrics: ['oWaiting'],
        },
      });
      const now = ctx.now().getTime();
      const rows = targets.map((q) => {
        const data = (res.results ?? []).filter((r) => r.group.queueId === q.id).flatMap((r) => r.data ?? []);
        const count = (metric: string, qualifier?: string) =>
          data.filter((d) => d.metric === metric && (qualifier === undefined || d.qualifier === qualifier)).reduce((n, d) => n + (d.stats.count ?? 0), 0);
        const waitingSince = data
          .filter((d) => d.metric === 'oWaiting')
          .flatMap((d) => d.observations ?? [])
          .map((o) => Date.parse(o.observationDate));
        return {
          queue: q.name,
          waiting: count('oWaiting'),
          longestWaitSeconds: waitingSince.length ? Math.round((now - Math.min(...waitingSince)) / 1000) : 0,
          interacting: count('oInteracting'),
          agentsOnQueue: count('oOnQueueUsers'),
          agentsIdle: count('oOnQueueUsers', 'IDLE'),
          agentsInteracting: count('oOnQueueUsers', 'INTERACTING') + count('oOnQueueUsers', 'COMMUNICATING'),
          agentsNotResponding: count('oOnQueueUsers', 'NOT_RESPONDING'),
          agentsOffQueue: count('oOffQueueUsers'),
        };
      });
      return { at: new Date(now).toISOString(), queues: rows };
    },
  }),

  define({
    name: 'get_queue_performance',
    title: 'Queue performance',
    description:
      'Historical queue metrics for an interval: offered, answered, abandoned, abandon rate, service level, average speed of answer and handle time. Optionally split into time buckets.',
    input: {
      queues: queuesArg,
      interval: intervalArg,
      granularity: z.enum(['PT15M', 'PT30M', 'PT1H', 'P1D']).optional().describe('Split the interval into buckets of this size'),
    },
    async run({ queues, interval, granularity }, ctx) {
      const range = resolveInterval(interval, ctx.now(), ctx.timeZone);
      const targets = queues?.length ? await ctx.directory.resolveQueues(queues) : await ctx.directory.queues();
      const res = await ctx.client.request<AggregateResult>('POST', '/api/v2/analytics/conversations/aggregates/query', {
        body: {
          interval: range.iso,
          groupBy: ['queueId'],
          ...(granularity ? { granularity } : {}),
          filter: { type: 'or', predicates: targets.map((q) => ({ dimension: 'queueId', value: q.id })) },
          metrics: ['nOffered', 'tAnswered', 'tAbandon', 'tWait', 'tHandle', 'tTalk', 'tHeld', 'tAcw', 'nTransferred', 'oServiceLevel'],
        },
      });

      const rows = targets.map((q) => {
        const buckets = (res.results ?? []).filter((r) => r.group.queueId === q.id).flatMap((r) => r.data ?? []);
        const summary = summarize(buckets.flatMap((b) => b.metrics));
        return {
          queue: q.name,
          ...summary,
          ...(granularity
            ? {
                series: buckets.map((b) => {
                  const s = summarize(b.metrics);
                  return { start: b.interval.split('/')[0], offered: s.offered, answered: s.answered, abandoned: s.abandoned, serviceLevelPercent: s.serviceLevelPercent };
                }),
              }
            : {}),
        };
      });
      return { interval: range.iso, timeZone: ctx.timeZone, serviceLevelTargetSeconds: 20, queues: rows.sort((a, b) => b.offered - a.offered) };
    },
  }),

  define({
    name: 'list_agents',
    title: 'List agents',
    description: 'Agents with their current presence and routing status. Filter by queue, status or name.',
    input: {
      queue: z.string().optional().describe('Only members of this queue'),
      status: z
        .enum(['on_queue', 'idle', 'interacting', 'not_responding', 'off_queue', 'offline'])
        .optional()
        .describe('on_queue includes idle, interacting and not_responding'),
      name: z.string().optional().describe('Filter by name, partial match'),
      limit: z.number().int().min(1).max(500).optional().describe('Default 100'),
    },
    async run({ queue, status, name, limit }, ctx) {
      type UserEntity = Named & { department?: string; presence?: { presenceDefinition?: { systemPresence?: string } }; routingStatus?: { status?: string } };
      let users: UserEntity[];
      if (queue) {
        const [q] = await ctx.directory.resolveQueues([queue]);
        const members = await pages<{ id: string; name: string; user?: UserEntity; routingStatus?: { status?: string } }>(ctx.client, `/api/v2/routing/queues/${q!.id}/members`, {
          expand: 'presence,routingStatus',
        });
        users = members.map((m) => ({ ...(m.user ?? { id: m.id, name: m.name }), routingStatus: m.routingStatus ?? m.user?.routingStatus }));
      } else {
        users = await pages<UserEntity>(ctx.client, '/api/v2/users', { expand: 'presence,routingStatus', state: 'active' });
      }
      const rows = users
        .map((u) => ({
          id: u.id,
          name: u.name,
          department: u.department,
          presence: u.presence?.presenceDefinition?.systemPresence ?? 'Unknown',
          routingStatus: u.routingStatus?.status ?? 'OFF_QUEUE',
        }))
        .filter((u) => !name || u.name.toLowerCase().includes(name.toLowerCase()))
        .filter((u) => matchesStatus(u, status))
        .sort((a, b) => a.name.localeCompare(b.name));
      const max = limit ?? 100;
      return { count: rows.length, ...(rows.length > max ? { truncated: true } : {}), agents: rows.slice(0, max) };
    },
  }),

  define({
    name: 'get_agent_performance',
    title: 'Agent performance',
    description: 'Handled interactions and average talk, hold, after-call work and handle time per agent for an interval.',
    input: {
      agents: z.array(z.string()).optional().describe('Agent names or ids. Omit for everyone.'),
      queue: z.string().optional().describe('Only interactions from this queue'),
      interval: intervalArg,
      limit: z.number().int().min(1).max(200).optional().describe('Default 25, sorted by interactions handled'),
    },
    async run({ agents, queue, interval, limit }, ctx) {
      const range = resolveInterval(interval, ctx.now(), ctx.timeZone);
      const clauses: unknown[] = [];
      if (agents?.length) {
        const users = await ctx.directory.resolveUsers(agents);
        clauses.push({ type: 'or', predicates: users.map((u) => ({ dimension: 'userId', value: u.id })) });
      }
      if (queue) {
        const [q] = await ctx.directory.resolveQueues([queue]);
        clauses.push({ type: 'or', predicates: [{ dimension: 'queueId', value: q!.id }] });
      }
      const res = await ctx.client.request<AggregateResult>('POST', '/api/v2/analytics/conversations/aggregates/query', {
        body: {
          interval: range.iso,
          groupBy: ['userId'],
          ...(clauses.length ? { filter: { type: 'and', clauses } } : {}),
          metrics: ['tHandle', 'tTalk', 'tHeld', 'tAcw', 'nTransferred', 'tAnswered'],
        },
      });
      const rows = await Promise.all(
        (res.results ?? [])
          .filter((r) => r.group.userId)
          .map(async (r) => {
            const metrics = (r.data ?? []).flatMap((d) => d.metrics);
            const handle = stat(metrics, 'tHandle');
            const talk = stat(metrics, 'tTalk');
            const held = stat(metrics, 'tHeld');
            const acw = stat(metrics, 'tAcw');
            return {
              agent: await ctx.directory.userName(r.group.userId),
              handled: handle.count ?? 0,
              avgHandleSeconds: avgSeconds(handle),
              avgTalkSeconds: avgSeconds(talk),
              avgHoldSeconds: avgSeconds(held),
              holdRatePercent: handle.count ? round1(((held.count ?? 0) / handle.count) * 100) : null,
              avgAcwSeconds: avgSeconds(acw),
              transferred: stat(metrics, 'nTransferred').count ?? 0,
              totalHandleMinutes: Math.round((handle.sum ?? 0) / 60_000),
            };
          }),
      );
      rows.sort((a, b) => b.handled - a.handled);
      const max = limit ?? 25;
      return { interval: range.iso, timeZone: ctx.timeZone, count: rows.length, agents: rows.slice(0, max) };
    },
  }),

  define({
    name: 'search_conversations',
    title: 'Search conversations',
    description:
      'Find conversations in an interval by queue, agent, media type, direction, outcome or wait time. Returns one line per conversation; use get_conversation for the full timeline.',
    input: {
      interval: intervalArg,
      queue: z.string().optional(),
      agent: z.string().optional(),
      mediaType: z.enum(['voice', 'chat', 'email', 'message', 'callback']).optional(),
      direction: z.enum(['inbound', 'outbound']).optional(),
      outcome: z.enum(['answered', 'abandoned']).optional(),
      minWaitSeconds: z.number().min(0).optional().describe('Only conversations that waited in queue at least this long'),
      minDurationSeconds: z.number().min(0).optional(),
      limit: z.number().int().min(1).max(100).optional().describe('Default 20, newest first'),
    },
    async run(args, ctx) {
      const range = resolveInterval(args.interval, ctx.now(), ctx.timeZone);
      const predicates: unknown[] = [];
      if (args.queue) {
        const [q] = await ctx.directory.resolveQueues([args.queue]);
        predicates.push({ dimension: 'queueId', value: q!.id });
      }
      if (args.agent) {
        const [u] = await ctx.directory.resolveUsers([args.agent]);
        predicates.push({ dimension: 'userId', value: u!.id });
      }
      if (args.mediaType) predicates.push({ dimension: 'mediaType', value: args.mediaType });
      if (args.direction) predicates.push({ dimension: 'direction', value: args.direction });

      const metricPredicates: unknown[] = [];
      if (args.outcome === 'abandoned') metricPredicates.push({ type: 'metric', metric: 'tAbandon', operator: 'exists' });
      if (args.outcome === 'answered') metricPredicates.push({ type: 'metric', metric: 'tAnswered', operator: 'exists' });
      if (args.minWaitSeconds) metricPredicates.push({ type: 'metric', metric: 'tWait', range: { gte: args.minWaitSeconds * 1000 } });
      if (args.minDurationSeconds) metricPredicates.push({ type: 'metric', metric: 'tConversationDuration', range: { gte: args.minDurationSeconds * 1000 } });

      const res = await ctx.client.request<{ conversations?: Conversation[]; totalHits?: number }>('POST', '/api/v2/analytics/conversations/details/query', {
        body: {
          interval: range.iso,
          order: 'desc',
          orderBy: 'conversationStart',
          paging: { pageSize: args.limit ?? 20, pageNumber: 1 },
          ...(predicates.length ? { segmentFilters: [{ type: 'and', predicates }] } : {}),
          ...(metricPredicates.length ? { conversationFilters: [{ type: 'and', predicates: metricPredicates }] } : {}),
        },
      });
      const conversations = await Promise.all((res.conversations ?? []).map((c) => summarizeConversation(c, ctx)));
      return { interval: range.iso, totalHits: res.totalHits ?? conversations.length, returned: conversations.length, conversations };
    },
  }),

  define({
    name: 'get_conversation',
    title: 'Conversation details',
    description: 'Full timeline of one conversation: queue time, agents, holds, transfers, wrap-up and who disconnected.',
    input: { conversationId: z.string().describe('Conversation id') },
    async run({ conversationId }, ctx) {
      const c = await ctx.client.request<Conversation>('GET', `/api/v2/analytics/conversations/${encodeURIComponent(conversationId)}/details`);
      const summary = await summarizeConversation(c, ctx);
      const timeline: Record<string, unknown>[] = [];
      for (const p of c.participants ?? []) {
        const who =
          p.purpose === 'customer' || p.purpose === 'external'
            ? 'customer'
            : p.purpose === 'agent'
              ? `agent ${p.participantName ?? (await ctx.directory.userName(p.userId))}`
              : p.purpose === 'acd'
                ? `queue ${p.participantName ?? ''}`.trim()
                : p.purpose;
        for (const s of p.sessions ?? []) {
          for (const seg of s.segments ?? []) {
            if (p.purpose === 'customer' || p.purpose === 'external') continue; // the customer leg spans the whole call
            timeline.push({
              start: seg.segmentStart,
              end: seg.segmentEnd,
              seconds: seg.segmentEnd ? Math.round((Date.parse(seg.segmentEnd) - Date.parse(seg.segmentStart)) / 1000) : undefined,
              who,
              what: describeSegment(p.purpose, seg.segmentType),
              ...(seg.wrapUpCode ? { wrapUp: await ctx.directory.wrapupName(seg.wrapUpCode) } : {}),
            });
          }
        }
      }
      timeline.sort((a, b) => String(a.start).localeCompare(String(b.start)));
      const customer = (c.participants ?? []).find((p) => p.purpose === 'customer' || p.purpose === 'external');
      const disconnect = customer?.sessions?.[0]?.segments?.slice(-1)[0]?.disconnectType;
      return {
        ...summary,
        disconnectedBy: disconnect === 'client' ? 'customer' : disconnect === 'peer' ? 'agent or system' : disconnect,
        timeline,
      };
    },
  }),
];

// ---- helpers -----------------------------------------------------------------------------

async function pages<T>(client: PlatformClient, path: string, query: Record<string, string>): Promise<T[]> {
  const out: T[] = [];
  for (let pageNumber = 1; pageNumber <= 20; pageNumber++) {
    const page = await client.request<{ entities?: T[]; pageCount?: number }>('GET', path, { query: { ...query, pageSize: 100, pageNumber } });
    out.push(...(page.entities ?? []));
    if (!page.pageCount || pageNumber >= page.pageCount) break;
  }
  return out;
}

function matchesStatus(u: { presence: string; routingStatus: string }, status: string | undefined): boolean {
  switch (status) {
    case undefined:
      return true;
    case 'on_queue':
      return u.presence === 'On Queue';
    case 'idle':
      return u.presence === 'On Queue' && u.routingStatus === 'IDLE';
    case 'interacting':
      return u.routingStatus === 'INTERACTING' || u.routingStatus === 'COMMUNICATING';
    case 'not_responding':
      return u.routingStatus === 'NOT_RESPONDING';
    case 'offline':
      return u.presence === 'Offline';
    case 'off_queue':
      return u.presence !== 'On Queue' && u.presence !== 'Offline';
    default:
      return true;
  }
}

function stat(metrics: { metric: string; stats: Stat }[], name: string): Stat {
  const list = metrics.filter((m) => m.metric === name).map((m) => m.stats);
  return {
    count: list.reduce((n, s) => n + (s.count ?? 0), 0),
    sum: list.reduce((n, s) => n + (s.sum ?? 0), 0),
    max: list.reduce((n, s) => Math.max(n, s.max ?? 0), 0),
    numerator: list.reduce((n, s) => n + (s.numerator ?? 0), 0),
    denominator: list.reduce((n, s) => n + (s.denominator ?? 0), 0),
  };
}

function summarize(metrics: { metric: string; stats: Stat }[]) {
  const offered = stat(metrics, 'nOffered').count ?? 0;
  const answered = stat(metrics, 'tAnswered');
  const abandoned = stat(metrics, 'tAbandon');
  const handle = stat(metrics, 'tHandle');
  const sl = stat(metrics, 'oServiceLevel');
  return {
    offered,
    answered: answered.count ?? 0,
    abandoned: abandoned.count ?? 0,
    abandonRatePercent: offered ? round1(((abandoned.count ?? 0) / offered) * 100) : null,
    serviceLevelPercent: sl.denominator ? round1(((sl.numerator ?? 0) / sl.denominator) * 100) : null,
    avgSpeedOfAnswerSeconds: avgSeconds(answered),
    longestWaitSeconds: Math.round(Math.max(answered.max ?? 0, abandoned.max ?? 0) / 1000),
    avgAbandonSeconds: avgSeconds(abandoned),
    avgHandleSeconds: avgSeconds(handle),
    avgTalkSeconds: avgSeconds(stat(metrics, 'tTalk')),
    avgHoldSeconds: avgSeconds(stat(metrics, 'tHeld')),
    avgAcwSeconds: avgSeconds(stat(metrics, 'tAcw')),
    transferred: stat(metrics, 'nTransferred').count ?? 0,
  };
}

function avgSeconds(s: Stat): number | null {
  return s.count ? Math.round((s.sum ?? 0) / s.count / 1000) : null;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

async function summarizeConversation(c: Conversation, ctx: ToolContext) {
  const participants = c.participants ?? [];
  const customer = participants.find((p) => p.purpose === 'customer' || p.purpose === 'external');
  const acd = participants.find((p) => p.purpose === 'acd');
  const agents = participants.filter((p) => p.purpose === 'agent');
  const session = customer?.sessions?.[0];
  const metric = (p: Participant | undefined, name: string) => p?.sessions?.flatMap((s) => s.metrics ?? []).find((m) => m.name === name)?.value;
  const queueId = acd?.sessions?.flatMap((s) => s.segments ?? []).find((s) => s.queueId)?.queueId ?? agents[0]?.sessions?.[0]?.segments?.find((s) => s.queueId)?.queueId;
  const wrapId = agents.flatMap((a) => a.sessions ?? []).flatMap((s) => s.segments ?? []).find((s) => s.wrapUpCode)?.wrapUpCode;
  const abandon = metric(acd, 'tAbandon');
  const answeredAfter = metric(agents[0], 'tAnswered') ?? metric(acd, 'tAcd');
  const handle = agents.reduce((n, a) => n + (metric(a, 'tHandle') ?? 0), 0);

  return {
    conversationId: c.conversationId,
    start: c.conversationStart,
    end: c.conversationEnd,
    durationSeconds: c.conversationEnd ? Math.round((Date.parse(c.conversationEnd) - Date.parse(c.conversationStart)) / 1000) : undefined,
    direction: c.originatingDirection,
    mediaType: session?.mediaType,
    queue: await ctx.directory.queueName(queueId),
    agents: await Promise.all(agents.map(async (a) => a.participantName ?? (await ctx.directory.userName(a.userId)))),
    outcome: abandon !== undefined ? 'abandoned' : agents.length ? 'answered' : c.conversationEnd ? 'no agent' : 'in progress',
    waitSeconds: abandon !== undefined ? Math.round(abandon / 1000) : answeredAfter !== undefined ? Math.round(answeredAfter / 1000) : undefined,
    handleSeconds: handle ? Math.round(handle / 1000) : undefined,
    wrapUp: await ctx.directory.wrapupName(wrapId),
    customer: ctx.redact ? maskName(customer?.participantName) : customer?.participantName,
    from: ctx.redact ? maskAddress(session?.ani) : session?.ani,
    to: session?.dnis,
  };
}

function describeSegment(purpose: string, type: string): string {
  if (purpose === 'acd') return 'waiting in queue';
  if (purpose === 'ivr') return 'in IVR';
  switch (type) {
    case 'interact':
      return 'talking';
    case 'hold':
      return 'on hold';
    case 'wrapup':
      return 'after-call work';
    case 'alert':
      return 'ringing';
    case 'dialing':
      return 'dialing';
    default:
      return type;
  }
}
