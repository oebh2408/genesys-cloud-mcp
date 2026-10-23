import { z } from 'zod';
import type { Named } from './directory.js';
import {
  avgSeconds,
  define,
  emptyStatus,
  intervalArg,
  pages,
  presenceLabel,
  queuesArg,
  round1,
  stat,
  statusTimes,
  type AggregateResult,
  type Conversation,
  type ObservationResult,
  type Participant,
  type Segment,
  type Session,
  type Stat,
  type ToolContext,
  type ToolDefinition,
  type UserEntity,
} from './kit.js';
import { maskAddress, maskName } from './redact.js';
import { organizationTools } from './organization.js';
import { supervisionTools } from './supervision.js';
import { evaluate, formatLocal, nextChange, upcomingHolidays, type Schedule, type ScheduleGroup } from './schedule.js';
import { resolveInterval, type ResolvedInterval } from './time.js';

export type { ToolContext, ToolDefinition } from './kit.js';

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
    name: 'get_queue',
    title: 'Queue configuration',
    description:
      'Configuration of one queue: media, service level target, alerting timeout, after-call work, skill evaluation, wrap-up codes, and its members with their skills and current status.',
    input: { queue: z.string().describe('Queue name or id') },
    async run({ queue }, ctx) {
      const [target] = await ctx.directory.resolveQueues([queue]);
      type QueueEntity = {
        id: string;
        name: string;
        description?: string;
        memberCount?: number;
        joinedMemberCount?: number;
        mediaSettings?: Record<string, { alertingTimeoutSeconds?: number; serviceLevel?: { percentage?: number; durationMs?: number } }>;
        acwSettings?: { wrapupPrompt?: string; timeoutMs?: number };
        skillEvaluationMethod?: string;
        dateModified?: string;
      };
      type Member = { id: string; name: string; joined?: boolean; user?: UserEntity; routingStatus?: { status?: string } };
      const [q, wrapups, members] = await Promise.all([
        ctx.client.request<QueueEntity>('GET', `/api/v2/routing/queues/${target!.id}`),
        pages<Named>(ctx.client, `/api/v2/routing/queues/${target!.id}/wrapupcodes`, {}),
        pages<Member>(ctx.client, `/api/v2/routing/queues/${target!.id}/members`, { expand: 'presence,routingStatus,skills' }),
      ]);
      const agents = members
        .map((m) => ({
          name: m.user?.name ?? m.name,
          joined: m.joined ?? true,
          presence: m.user?.presence?.presenceDefinition?.systemPresence ?? 'Unknown',
          routingStatus: m.routingStatus?.status ?? m.user?.routingStatus?.status ?? 'OFF_QUEUE',
          skills: (m.user?.skills ?? []).map((k) => `${k.name} ${k.proficiency ?? ''}`.trim()),
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return {
        queue: q.name,
        description: q.description,
        media: Object.entries(q.mediaSettings ?? {}).map(([media, m]) => ({
          media,
          serviceLevelPercent: m.serviceLevel?.percentage !== undefined ? Math.round(m.serviceLevel.percentage * 100) : undefined,
          serviceLevelSeconds: m.serviceLevel?.durationMs !== undefined ? Math.round(m.serviceLevel.durationMs / 1000) : undefined,
          alertingTimeoutSeconds: m.alertingTimeoutSeconds,
        })),
        afterCallWork: q.acwSettings ? { mode: q.acwSettings.wrapupPrompt, timeoutSeconds: q.acwSettings.timeoutMs !== undefined ? Math.round(q.acwSettings.timeoutMs / 1000) : undefined } : undefined,
        skillEvaluation: q.skillEvaluationMethod,
        lastModified: q.dateModified,
        wrapUpCodes: wrapups.map((w) => w.name),
        members: { total: agents.length, joined: agents.filter((a) => a.joined).length, onQueueNow: agents.filter((a) => a.presence === 'On Queue').length },
        agents,
      };
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
      const rows = await queuePerformance(ctx, targets, range.iso, granularity);
      return { interval: range.iso, timeZone: ctx.timeZone, serviceLevelTargetSeconds: 20, queues: rows.sort((a, b) => b.offered - a.offered) };
    },
  }),

  define({
    name: 'compare_queue_performance',
    title: 'Compare queue performance',
    description:
      'Queue metrics for an interval next to the same metrics for an earlier one, with the change. By default compares with the same interval a week earlier, which keeps the day of the week and the time of day.',
    input: {
      queues: queuesArg,
      interval: intervalArg,
      compareTo: z
        .string()
        .optional()
        .describe('last_week (default): same interval 7 days earlier; previous: the interval of the same length just before; or an ISO-8601 interval'),
    },
    async run({ queues, interval, compareTo }, ctx) {
      const range = resolveInterval(interval, ctx.now(), ctx.timeZone);
      const base = comparisonInterval(range, compareTo ?? 'last_week', ctx);
      const targets = queues?.length ? await ctx.directory.resolveQueues(queues) : await ctx.directory.queues();
      const [current, previous] = await Promise.all([queuePerformance(ctx, targets, range.iso), queuePerformance(ctx, targets, base)]);
      const keys = ['offered', 'answered', 'abandoned', 'abandonRatePercent', 'serviceLevelPercent', 'avgSpeedOfAnswerSeconds', 'avgHandleSeconds', 'avgHoldSeconds', 'avgAcwSeconds'] as const;
      const rows = targets.map((q, i) => {
        const a = current[i]!;
        const b = previous[i]!;
        return {
          queue: q.name,
          ...(Object.fromEntries(
            keys.map((k) => {
              const now = a[k];
              const before = b[k];
              const change = now === null || before === null ? null : round1(now - before);
              const percent = typeof now === 'number' && typeof before === 'number' && before !== 0 && !k.endsWith('Percent') ? round1(((now - before) / before) * 100) : undefined;
              return [k, { current: now, previous: before, change, ...(percent !== undefined ? { changePercent: percent } : {}) }];
            }),
          ) as Record<(typeof keys)[number], { current: number | null; previous: number | null; change: number | null; changePercent?: number }>),
        };
      });
      return { interval: range.iso, comparedWith: base, timeZone: ctx.timeZone, queues: rows.sort((x, y) => (y.offered.current ?? 0) - (x.offered.current ?? 0)) };
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
    name: 'get_agent',
    title: 'Agent profile',
    description: 'One agent: department, current presence and routing status, queues, skills and languages, and a summary of today: interactions handled and time by status.',
    input: { agent: z.string().describe('Agent name or id') },
    async run({ agent }, ctx) {
      const [u] = await ctx.directory.resolveUsers([agent]);
      const today = resolveInterval('today', ctx.now(), ctx.timeZone);
      const [user, queues, handled, status] = await Promise.all([
        ctx.client.request<UserEntity & { email?: string; title?: string }>('GET', `/api/v2/users/${u!.id}`, { query: { expand: 'presence,routingStatus,skills,languages' } }),
        pages<Named & { joined?: boolean }>(ctx.client, `/api/v2/users/${u!.id}/queues`, {}),
        ctx.client.request<AggregateResult>('POST', '/api/v2/analytics/conversations/aggregates/query', {
          body: { interval: today.iso, groupBy: ['userId'], filter: { type: 'or', predicates: [{ dimension: 'userId', value: u!.id }] }, metrics: ['tHandle', 'tTalk', 'tHeld', 'tAcw'] },
        }),
        statusTimes(ctx, [u!.id], today.iso),
      ]);
      const metrics = (handled.results ?? []).flatMap((r) => r.data ?? []).flatMap((d) => d.metrics);
      const handle = stat(metrics, 'tHandle');
      return {
        agent: user.name,
        title: user.title,
        department: user.department,
        presence: user.presence?.presenceDefinition?.systemPresence ?? 'Unknown',
        routingStatus: user.routingStatus?.status ?? 'OFF_QUEUE',
        queues: queues.map((q) => ({ queue: q.name, joined: q.joined ?? true })),
        skills: (user.skills ?? []).map((k) => ({ skill: k.name, proficiency: k.proficiency })),
        languages: (user.languages ?? []).map((l) => ({ language: l.name, proficiency: l.proficiency })),
        today: {
          interval: today.iso,
          handled: handle.count ?? 0,
          avgHandleSeconds: avgSeconds(handle),
          avgHoldSeconds: avgSeconds(stat(metrics, 'tHeld')),
          avgAcwSeconds: avgSeconds(stat(metrics, 'tAcw')),
          ...(status.get(u!.id) ?? emptyStatus()),
        },
      };
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
    name: 'get_agent_status_summary',
    title: 'Agent status summary',
    description:
      'Time each agent spent logged in, on queue, idle, interacting, and off queue by presence (break, meal, meeting, away...) in an interval, with occupancy (interacting time over on-queue time). Use it for adherence and staffing questions.',
    input: {
      agents: z.array(z.string()).optional().describe('Agent names or ids'),
      queue: z.string().optional().describe('Only members of this queue'),
      interval: intervalArg,
      limit: z.number().int().min(1).max(200).optional().describe('Default 50'),
    },
    async run({ agents, queue, interval, limit }, ctx) {
      const range = resolveInterval(interval, ctx.now(), ctx.timeZone);
      let users: Named[];
      if (agents?.length) users = await ctx.directory.resolveUsers(agents);
      else if (queue) {
        const [q] = await ctx.directory.resolveQueues([queue]);
        users = (await pages<{ id: string; name: string; user?: Named }>(ctx.client, `/api/v2/routing/queues/${q!.id}/members`, {})).map((m) => ({ id: m.user?.id ?? m.id, name: m.user?.name ?? m.name }));
      } else users = await ctx.directory.users();
      const times = await statusTimes(ctx, users.map((u) => u.id), range.iso);
      const rows = users
        .map((u) => ({ agent: u.name, ...(times.get(u.id) ?? emptyStatus()) }))
        .filter((r) => r.loggedInMinutes > 0)
        .sort((a, b) => a.agent.localeCompare(b.agent));
      const max = limit ?? 50;
      const total = (k: 'onQueueMinutes' | 'interactingMinutes' | 'idleMinutes') => rows.reduce((n, r) => n + r[k], 0);
      return {
        interval: range.iso,
        timeZone: ctx.timeZone,
        team: {
          agentsLoggedIn: rows.length,
          onQueueMinutes: total('onQueueMinutes'),
          occupancyPercent: total('interactingMinutes') + total('idleMinutes') ? round1((total('interactingMinutes') / (total('interactingMinutes') + total('idleMinutes'))) * 100) : null,
        },
        count: rows.length,
        ...(rows.length > max ? { truncated: true } : {}),
        agents: rows.slice(0, max),
      };
    },
  }),

  define({
    name: 'get_agent_timeline',
    title: 'Agent timeline',
    description:
      'Status changes of one agent in an interval, with durations, and the interactions they handled. Use it to see what an agent was doing at a given time. By default on-queue time is one block; detail "routing" splits it into idle and interacting.',
    input: {
      agent: z.string().describe('Agent name or id'),
      interval: intervalArg,
      detail: z.enum(['presence', 'routing']).optional().describe('presence (default) or routing'),
    },
    async run({ agent, interval, detail }, ctx) {
      const range = resolveInterval(interval, ctx.now(), ctx.timeZone);
      if (range.end.getTime() - range.start.getTime() > 7 * 86_400_000) throw new Error('The timeline covers at most 7 days. Use get_agent_status_summary for longer intervals.');
      const [u] = await ctx.directory.resolveUsers([agent]);
      type Period = { startTime: string; endTime?: string; systemPresence?: string; routingStatus?: string };
      const [details, convs] = await Promise.all([
        ctx.client.request<{ userDetails?: { userId: string; primaryPresence?: Period[]; routingStatus?: Period[] }[] }>('POST', '/api/v2/analytics/users/details/query', {
          body: { interval: range.iso, order: 'asc', userFilters: [{ type: 'or', predicates: [{ dimension: 'userId', value: u!.id }] }], paging: { pageSize: 100, pageNumber: 1 } },
        }),
        ctx.client.request<{ conversations?: Conversation[]; totalHits?: number }>('POST', '/api/v2/analytics/conversations/details/query', {
          body: { interval: range.iso, order: 'asc', orderBy: 'conversationStart', paging: { pageSize: 100, pageNumber: 1 }, segmentFilters: [{ type: 'and', predicates: [{ dimension: 'userId', value: u!.id }] }] },
        }),
      ]);
      const d = details.userDetails?.find((x) => x.userId === u!.id);
      const end = Math.min(range.end.getTime(), ctx.now().getTime());
      const presence = (d?.primaryPresence ?? []).map((p) => ({ start: Date.parse(p.startTime), end: p.endTime ? Date.parse(p.endTime) : end, value: presenceLabel(p.systemPresence) }));
      const routing = (d?.routingStatus ?? []).map((p) => ({ start: Date.parse(p.startTime), end: p.endTime ? Date.parse(p.endTime) : end, value: p.routingStatus ?? 'OFF_QUEUE' }));
      const cuts = [...new Set([...presence, ...routing].flatMap((p) => [p.start, p.end]))].sort((a, b) => a - b);
      const at = (list: { start: number; end: number; value: string }[], t: number) => list.find((p) => p.start <= t && t < p.end)?.value;
      const timeline: { start: string; end: string; minutes: number; presence: string; routingStatus: string }[] = [];
      for (let i = 0; i < cuts.length - 1; i++) {
        const p = at(presence, cuts[i]!) ?? 'Offline';
        const r = p !== 'On Queue' ? 'OFF_QUEUE' : detail === 'routing' ? (at(routing, cuts[i]!) ?? 'OFF_QUEUE') : 'ON_QUEUE';
        const last = timeline.at(-1);
        if (last && last.presence === p && last.routingStatus === r) {
          last.end = new Date(cuts[i + 1]!).toISOString();
        } else timeline.push({ start: new Date(cuts[i]!).toISOString(), end: new Date(cuts[i + 1]!).toISOString(), minutes: 0, presence: p, routingStatus: r });
      }
      for (const t of timeline) {
        t.minutes = round1((Date.parse(t.end) - Date.parse(t.start)) / 60_000);
        t.start = t.start.replace(/\.\d{3}Z$/, 'Z');
        t.end = t.end.replace(/\.\d{3}Z$/, 'Z');
      }
      const conversations = await Promise.all((convs.conversations ?? []).map((c) => summarizeConversation(c, ctx)));
      return {
        agent: u!.name,
        interval: range.iso,
        timeZone: ctx.timeZone,
        // Offline stretches at the edges say nothing; keep the ones between logins.
        timeline: trimOffline(timeline).map(({ routingStatus, ...t }) => (detail === 'routing' ? { ...t, routingStatus } : t)),
        interactions: {
          total: convs.totalHits ?? conversations.length,
          list: conversations.map((c) => ({ conversationId: c.conversationId, start: c.start, queue: c.queue, mediaType: c.mediaType, direction: c.direction, handleSeconds: c.handleSeconds, wrapUp: c.wrapUp })),
        },
      };
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

  define({
    name: 'get_wrapup_summary',
    title: 'Wrap-up codes',
    description: 'How handled interactions were closed: count, share and average handle time per wrap-up code, for a queue, an agent or the whole center.',
    input: {
      queue: z.string().optional(),
      agent: z.string().optional(),
      interval: intervalArg,
    },
    async run({ queue, agent, interval }, ctx) {
      const range = resolveInterval(interval, ctx.now(), ctx.timeZone);
      const predicates: unknown[] = [];
      if (queue) {
        const [q] = await ctx.directory.resolveQueues([queue]);
        predicates.push({ dimension: 'queueId', value: q!.id });
      }
      if (agent) {
        const [u] = await ctx.directory.resolveUsers([agent]);
        predicates.push({ dimension: 'userId', value: u!.id });
      }
      const res = await ctx.client.request<AggregateResult>('POST', '/api/v2/analytics/conversations/aggregates/query', {
        body: { interval: range.iso, groupBy: ['wrapUpCode'], ...(predicates.length ? { filter: { type: 'and', predicates } } : {}), metrics: ['tHandle'] },
      });
      const groups = (res.results ?? []).filter((r) => r.group.wrapUpCode);
      const rows = await Promise.all(
        groups.map(async (r) => {
          const handle = stat((r.data ?? []).flatMap((d) => d.metrics), 'tHandle');
          return { wrapUp: (await ctx.directory.wrapupName(r.group.wrapUpCode)) ?? r.group.wrapUpCode!, count: handle.count ?? 0, avgHandleSeconds: avgSeconds(handle) };
        }),
      );
      const total = rows.reduce((n, r) => n + r.count, 0);
      return {
        interval: range.iso,
        ...(queue ? { queue: await ctx.directory.queueName((predicates[0] as { value: string }).value) } : {}),
        ...(agent ? { agent: await ctx.directory.userName((predicates.at(-1) as { value: string }).value) } : {}),
        total,
        wrapUps: rows.map((r) => ({ ...r, percent: total ? round1((r.count / total) * 100) : 0 })).sort((a, b) => b.count - a.count),
      };
    },
  }),

  define({
    name: 'get_flow_performance',
    title: 'IVR and flow performance',
    description:
      'Architect inbound flows (IVR, bots) for an interval: how many entered, how many were transferred out to a queue, how many ended inside the flow (self-service, hang-ups in the menus, closed messages), average time in the flow and flow outcomes. Optionally split into time buckets.',
    input: {
      flows: z.array(z.string()).optional().describe('Flow names or ids. Omit for all inbound flows.'),
      interval: intervalArg,
      granularity: z.enum(['PT15M', 'PT30M', 'PT1H', 'P1D']).optional(),
    },
    async run({ flows, interval, granularity }, ctx) {
      const range = resolveInterval(interval, ctx.now(), ctx.timeZone);
      const all = await ctx.directory.flows();
      const targets = flows?.length ? await ctx.directory.resolveFlows(flows) : all.filter((f) => !f.type || /^inbound|bot$/i.test(f.type));
      if (!targets.length) return { interval: range.iso, flows: [] };
      const res = await ctx.client.request<AggregateResult>('POST', '/api/v2/analytics/flows/aggregates/query', {
        body: {
          interval: range.iso,
          groupBy: ['flowId'],
          ...(granularity ? { granularity } : {}),
          filter: { type: 'or', predicates: targets.map((f) => ({ dimension: 'flowId', value: f.id })) },
          metrics: ['nFlow', 'tFlow', 'tFlowExit', 'tFlowDisconnect', 'nFlowOutcome', 'nFlowOutcomeFailed'],
        },
      });
      const sum = (metrics: { metric: string; stats: Stat }[]) => {
        const entered = stat(metrics, 'nFlow').count ?? 0;
        const exit = stat(metrics, 'tFlowExit');
        const disconnect = stat(metrics, 'tFlowDisconnect');
        return {
          entered,
          transferredOut: exit.count ?? 0,
          endedInFlow: disconnect.count ?? 0,
          endedInFlowPercent: entered ? round1(((disconnect.count ?? 0) / entered) * 100) : null,
          avgSecondsInFlow: avgSeconds(stat(metrics, 'tFlow')),
          avgSecondsBeforeTransfer: avgSeconds(exit),
          outcomesSucceeded: stat(metrics, 'nFlowOutcome').count ?? 0,
          outcomesFailed: stat(metrics, 'nFlowOutcomeFailed').count ?? 0,
        };
      };
      const rows = targets.map((f) => {
        const buckets = (res.results ?? []).filter((r) => r.group.flowId === f.id).flatMap((r) => r.data ?? []);
        return {
          flow: f.name,
          type: all.find((x) => x.id === f.id)?.type,
          ...sum(buckets.flatMap((b) => b.metrics)),
          ...(granularity ? { series: buckets.map((b) => ({ start: b.interval.split('/')[0], ...sum(b.metrics) })) } : {}),
        };
      });
      return {
        interval: range.iso,
        timeZone: ctx.timeZone,
        note: 'endedInFlow counts every session that ended inside the flow: finished in self-service, hung up in the menus, or heard a closed message. outcomesSucceeded counts flow outcomes marked as successful, usually self-service.',
        flows: rows.sort((a, b) => b.entered - a.entered),
      };
    },
  }),

  define({
    name: 'get_schedule_status',
    title: 'Opening hours',
    description:
      'Whether each Architect schedule group is open, closed or on a holiday at a given time (now by default), which schedule decides it, when it changes next, and the holidays in the next 60 days.',
    input: {
      scheduleGroup: z.string().optional().describe('Schedule group name, partial match. Omit for all.'),
      at: z.string().optional().describe('ISO-8601 date-time to check instead of now'),
    },
    async run({ scheduleGroup, at }, ctx) {
      const when = at ? Date.parse(at) : ctx.now().getTime();
      if (Number.isNaN(when)) throw new Error(`Invalid date-time '${at}'.`);
      const [groups, schedules] = await Promise.all([
        pages<ScheduleGroup>(ctx.client, '/api/v2/architect/schedulegroups', {}),
        pages<Schedule>(ctx.client, '/api/v2/architect/schedules', {}),
      ]);
      const byId = new Map(schedules.map((x) => [x.id, x]));
      const needle = scheduleGroup?.toLowerCase();
      const selected = groups.filter((g) => !needle || g.name.toLowerCase().includes(needle));
      if (needle && !selected.length) throw new Error(`No schedule group matches '${scheduleGroup}'. Known schedule groups: ${groups.map((g) => g.name).join(', ')}.`);
      return {
        at: new Date(when).toISOString(),
        scheduleGroups: selected.map((g) => {
          const tz = g.timeZone ?? ctx.timeZone;
          const now = evaluate(g, byId, when, tz);
          const next = nextChange(g, byId, when, tz);
          return {
            scheduleGroup: g.name,
            timeZone: tz,
            localTime: formatLocal(when, tz),
            status: now.state,
            schedule: now.schedule,
            nextChange: next ? { at: new Date(next.at).toISOString(), localTime: formatLocal(next.at, tz), status: next.state, schedule: next.schedule } : null,
            upcomingHolidays: upcomingHolidays(g, byId, when, tz),
          };
        }),
      };
    },
  }),

  ...supervisionTools,
  ...organizationTools,
];

// ---- helpers -----------------------------------------------------------------------------

async function queuePerformance(ctx: ToolContext, targets: Named[], interval: string, granularity?: string) {
  const res = await ctx.client.request<AggregateResult>('POST', '/api/v2/analytics/conversations/aggregates/query', {
    body: {
      interval,
      groupBy: ['queueId'],
      ...(granularity ? { granularity } : {}),
      filter: { type: 'or', predicates: targets.map((q) => ({ dimension: 'queueId', value: q.id })) },
      metrics: ['nOffered', 'tAnswered', 'tAbandon', 'tWait', 'tHandle', 'tTalk', 'tHeld', 'tAcw', 'nTransferred', 'oServiceLevel', 'tFlowOut'],
    },
  });
  return targets.map((q) => {
    const buckets = (res.results ?? []).filter((r) => r.group.queueId === q.id).flatMap((r) => r.data ?? []);
    return {
      queue: q.name,
      ...summarize(buckets.flatMap((b) => b.metrics)),
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
}

function comparisonInterval(range: ResolvedInterval, compareTo: string, ctx: ToolContext): string {
  const length = range.end.getTime() - range.start.getTime();
  const shift = (ms: number) => `${new Date(range.start.getTime() - ms).toISOString()}/${new Date(range.end.getTime() - ms).toISOString()}`;
  if (/^last[\s_-]?week$/i.test(compareTo)) return shift(7 * 86_400_000);
  if (/^previous$/i.test(compareTo)) return shift(length);
  return resolveInterval(compareTo, ctx.now(), ctx.timeZone).iso;
}





function trimOffline<T extends { presence: string }>(list: T[]): T[] {
  let a = 0;
  let b = list.length;
  while (a < b && list[a]!.presence === 'Offline') a++;
  while (b > a && list[b - 1]!.presence === 'Offline') b--;
  return list.slice(a, b);
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
    leftForCallback: stat(metrics, 'tFlowOut').count ?? 0,
  };
}



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
  const flowOut = metric(acd, 'tFlowOut');
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
    outcome: abandon !== undefined ? 'abandoned' : flowOut !== undefined ? 'left for a callback' : agents.length ? 'answered' : c.conversationEnd ? 'no agent' : 'in progress',
    waitSeconds:
      abandon !== undefined ? Math.round(abandon / 1000) : flowOut !== undefined ? Math.round(flowOut / 1000) : answeredAfter !== undefined ? Math.round(answeredAfter / 1000) : undefined,
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
