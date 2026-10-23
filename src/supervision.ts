import { z } from 'zod';
import type { Named } from './directory.js';
import { type AggregateResult, avgSeconds, type Conversation, define, intervalArg, pages, round1, stat, type Stat, type ToolContext } from './kit.js';
import { maskAddress, maskText } from './redact.js';
import { resolveInterval, startOfDay } from './time.js';

// Quality, surveys, workforce management and outbound: what a supervisor looks at next to the queues.

const longIntervalArg = z.string().optional().describe('last 7d (default), last 30d, this_week, yesterday, or an ISO-8601 interval start/end');
const dayArg = z.string().optional().describe('today (default), yesterday, tomorrow, or a date YYYY-MM-DD');

type Group = { group: Record<string, string>; data?: { metrics: { metric: string; stats: Stat }[] }[] };

export const supervisionTools = [
  define({
    name: 'get_quality_summary',
    title: 'Quality evaluations summary',
    description: 'Released quality evaluations in an interval: count and average, lowest and highest score, and average critical score, per agent, queue or evaluator.',
    input: {
      interval: longIntervalArg,
      groupBy: z.enum(['agent', 'queue', 'evaluator']).optional().describe('agent (default), queue or evaluator'),
      queue: z.string().optional(),
      agent: z.string().optional(),
    },
    async run({ interval, groupBy, queue, agent }, ctx) {
      const range = resolveInterval(interval ?? 'last 7d', ctx.now(), ctx.timeZone);
      const dimension = { agent: 'userId', queue: 'queueId', evaluator: 'evaluatorId' }[groupBy ?? 'agent'];
      const predicates = await filters(ctx, queue, agent);
      const res = await ctx.client.request<{ results?: Group[] }>('POST', '/api/v2/analytics/evaluations/aggregates/query', {
        body: {
          interval: range.iso,
          groupBy: [dimension],
          ...(predicates.length ? { filter: { type: 'and', predicates } } : {}),
          metrics: ['nEvaluations', 'oTotalScore', 'oTotalCriticalScore'],
        },
      });
      const all: { metric: string; stats: Stat }[] = [];
      const rows = await Promise.all(
        (res.results ?? []).map(async (r) => {
          const metrics = (r.data ?? []).flatMap((d) => d.metrics);
          all.push(...metrics);
          const id = r.group[dimension];
          const score = stat(metrics, 'oTotalScore');
          const name = dimension === 'queueId' ? await ctx.directory.queueName(id) : await ctx.directory.userName(id);
          return {
            [groupBy ?? 'agent']: name,
            evaluations: stat(metrics, 'nEvaluations').count ?? 0,
            avgScore: average(score),
            lowestScore: score.count ? round1(minOf(metrics, 'oTotalScore')) : null,
            highestScore: score.count ? round1(score.max ?? 0) : null,
            avgCriticalScore: average(stat(metrics, 'oTotalCriticalScore')),
          };
        }),
      );
      rows.sort((a, b) => (b.avgScore ?? 0) - (a.avgScore ?? 0));
      return {
        interval: range.iso,
        total: { evaluations: stat(all, 'nEvaluations').count ?? 0, avgScore: average(stat(all, 'oTotalScore')), avgCriticalScore: average(stat(all, 'oTotalCriticalScore')) },
        rows,
        note: 'Scores are percentages. A critical score below 100 means a critical question was failed; list_evaluations shows which evaluations.',
      };
    },
  }),

  define({
    name: 'list_evaluations',
    title: 'List quality evaluations',
    description: 'Quality evaluations of conversations in an interval, newest first: agent, queue, evaluator, form, score, critical score, and whether the agent has read it.',
    input: {
      interval: longIntervalArg,
      agent: z.string().optional(),
      queue: z.string().optional(),
      evaluator: z.string().optional().describe('Evaluator name, partial match'),
      criticalFailuresOnly: z.boolean().optional().describe('Only evaluations that failed a critical question'),
      limit: z.number().int().min(1).max(100).optional().describe('Default 20'),
    },
    async run({ interval, agent, queue, evaluator, criticalFailuresOnly, limit }, ctx) {
      const range = resolveInterval(interval ?? 'last 7d', ctx.now(), ctx.timeZone);
      const query: Record<string, string> = { startTime: range.start.toISOString(), endTime: range.end.toISOString(), expandAnswerTotalScores: 'true' };
      if (agent) query.agentUserId = (await ctx.directory.resolveUsers([agent]))[0]!.id;
      if (queue) query.queueId = (await ctx.directory.resolveQueues([queue]))[0]!.id;
      type Evaluation = {
        id: string;
        conversation?: { id: string };
        agent?: Named;
        queue?: Named;
        evaluator?: Named;
        evaluationForm?: Named;
        status?: string;
        conversationDate?: string;
        releaseDate?: string;
        agentHasRead?: boolean;
        answers?: { totalScore?: number; totalCriticalScore?: number; anyFailedKillQuestions?: boolean };
      };
      const list = (await pages<Evaluation>(ctx.client, '/api/v2/quality/evaluations/query', query))
        .filter((e) => !evaluator || (e.evaluator?.name ?? '').toLowerCase().includes(evaluator.toLowerCase()))
        .filter((e) => !criticalFailuresOnly || e.answers?.anyFailedKillQuestions || (e.answers?.totalCriticalScore ?? 100) < 100);
      const finished = list.filter((e) => e.status === 'FINISHED');
      const max = limit ?? 20;
      return {
        interval: range.iso,
        total: list.length,
        released: finished.length,
        pending: list.length - finished.length,
        criticalFailures: finished.filter((e) => e.answers?.anyFailedKillQuestions || (e.answers?.totalCriticalScore ?? 100) < 100).length,
        evaluations: list.slice(0, max).map((e) => ({
          evaluationId: e.id,
          conversationId: e.conversation?.id,
          conversationDate: e.conversationDate,
          agent: e.agent?.name,
          queue: e.queue?.name,
          evaluator: e.evaluator?.name,
          form: e.evaluationForm?.name,
          status: e.status,
          score: e.answers?.totalScore,
          criticalScore: e.answers?.totalCriticalScore,
          failedCriticalQuestion: e.answers ? !!e.answers.anyFailedKillQuestions : undefined,
          released: e.releaseDate,
          agentHasRead: e.agentHasRead,
        })),
      };
    },
  }),

  define({
    name: 'get_survey_summary',
    title: 'Survey results',
    description: 'Customer surveys in an interval: sent, answered, response rate, NPS (promoters minus detractors) and average satisfaction score, per queue or agent.',
    input: {
      interval: longIntervalArg,
      groupBy: z.enum(['queue', 'agent']).optional().describe('queue (default) or agent'),
      queue: z.string().optional(),
      agent: z.string().optional(),
    },
    async run({ interval, groupBy, queue, agent }, ctx) {
      const range = resolveInterval(interval ?? 'last 7d', ctx.now(), ctx.timeZone);
      const dimension = groupBy === 'agent' ? 'userId' : 'queueId';
      const predicates = await filters(ctx, queue, agent);
      const res = await ctx.client.request<{ results?: Group[] }>('POST', '/api/v2/analytics/surveys/aggregates/query', {
        body: {
          interval: range.iso,
          groupBy: [dimension],
          ...(predicates.length ? { filter: { type: 'and', predicates } } : {}),
          metrics: ['nSurveysSent', 'nSurveyResponses', 'nSurveyNpsResponses', 'nSurveyNpsPromoters', 'nSurveyNpsDetractors', 'oSurveyTotalScore'],
        },
      });
      const summary = (metrics: { metric: string; stats: Stat }[]) => {
        const count = (m: string) => stat(metrics, m).count ?? 0;
        const nps = count('nSurveyNpsResponses');
        return {
          sent: count('nSurveysSent'),
          responses: count('nSurveyResponses'),
          responseRatePercent: count('nSurveysSent') ? round1((count('nSurveyResponses') / count('nSurveysSent')) * 100) : null,
          promoters: count('nSurveyNpsPromoters'),
          detractors: count('nSurveyNpsDetractors'),
          nps: nps ? Math.round(((count('nSurveyNpsPromoters') - count('nSurveyNpsDetractors')) / nps) * 100) : null,
          avgScore: average(stat(metrics, 'oSurveyTotalScore')),
        };
      };
      const all: { metric: string; stats: Stat }[] = [];
      const rows = await Promise.all(
        (res.results ?? []).map(async (r) => {
          const metrics = (r.data ?? []).flatMap((d) => d.metrics);
          all.push(...metrics);
          const id = r.group[dimension];
          return { [groupBy ?? 'queue']: dimension === 'queueId' ? await ctx.directory.queueName(id) : await ctx.directory.userName(id), ...summary(metrics) };
        }),
      );
      rows.sort((a, b) => b.responses - a.responses);
      return { interval: range.iso, total: summary(all), rows, note: 'NPS ranges from -100 to 100: promoters answer 9 or 10, detractors 0 to 6. avgScore is the survey total score, 0 to 100.' };
    },
  }),

  define({
    name: 'list_survey_responses',
    title: 'Survey responses',
    description:
      'Answered customer surveys in an interval, newest first, with the NPS answer, the score and the comment. Phone numbers and emails inside comments are masked. Filter to detractors to see what unhappy customers wrote.',
    input: {
      interval: longIntervalArg,
      queue: z.string().optional(),
      agent: z.string().optional(),
      only: z.enum(['detractors', 'passives', 'promoters', 'with_comments']).optional(),
      limit: z.number().int().min(1).max(50).optional().describe('Default 15'),
    },
    async run({ interval, queue, agent, only, limit }, ctx) {
      const range = resolveInterval(interval ?? 'last 7d', ctx.now(), ctx.timeZone);
      const predicates = await filters(ctx, queue, agent);
      type WithSurveys = Conversation & { surveys?: { surveyId: string; surveyStatus?: string; surveyPromoterScore?: number; oSurveyTotalScore?: number; surveyCompletedDate?: string; queueId?: string; userId?: string }[] };
      const res = await ctx.client.request<{ conversations?: WithSurveys[] }>('POST', '/api/v2/analytics/conversations/details/query', {
        body: {
          interval: range.iso,
          order: 'desc',
          orderBy: 'conversationStart',
          paging: { pageSize: 100, pageNumber: 1 },
          ...(predicates.length ? { segmentFilters: [{ type: 'and', predicates }] } : {}),
          surveyFilters: [{ type: 'and', predicates: [{ dimension: 'surveyStatus', value: 'Finished' }] }],
        },
      });
      const answered = (res.conversations ?? [])
        .flatMap((c) => (c.surveys ?? []).filter((s) => s.surveyStatus === 'Finished').map((s) => ({ c, s })))
        .filter(({ s }) => {
          const nps = s.surveyPromoterScore;
          if (only === 'detractors') return nps !== undefined && nps <= 6;
          if (only === 'passives') return nps === 7 || nps === 8;
          if (only === 'promoters') return nps !== undefined && nps >= 9;
          return true;
        })
        .sort((a, b) => String(b.s.surveyCompletedDate).localeCompare(String(a.s.surveyCompletedDate)));
      type Survey = { id: string; answers?: { questionGroupScores?: { questionScores?: { freeTextAnswer?: string; npsTextAnswer?: string }[] }[] } };
      const max = limit ?? 15;
      const out: Record<string, unknown>[] = [];
      // Comments are only in the survey itself; fetch them one conversation at a time.
      for (const { c, s } of answered) {
        if (out.length >= max) break;
        const surveys = await ctx.client.request<Survey[] | { entities?: Survey[] }>('GET', `/api/v2/quality/conversations/${encodeURIComponent(c.conversationId)}/surveys`);
        const survey = (Array.isArray(surveys) ? surveys : (surveys.entities ?? [])).find((x) => x.id === s.surveyId);
        const comment = survey?.answers?.questionGroupScores?.flatMap((g) => g.questionScores ?? []).map((q) => q.freeTextAnswer ?? q.npsTextAnswer).find(Boolean);
        if (only === 'with_comments' && !comment) continue;
        out.push({
          conversationId: c.conversationId,
          completed: s.surveyCompletedDate,
          queue: await ctx.directory.queueName(s.queueId),
          agent: await ctx.directory.userName(s.userId),
          nps: s.surveyPromoterScore,
          score: s.oSurveyTotalScore,
          comment: ctx.redact ? maskText(comment) : comment,
        });
      }
      return {
        interval: range.iso,
        // The search reads the newest 100 conversations with an answered survey.
        searched: res.conversations?.length ?? 0,
        matching: answered.length,
        returned: out.length,
        responses: out,
      };
    },
  }),

  define({
    name: 'get_adherence',
    title: 'Schedule adherence now',
    description:
      'Real-time schedule adherence from workforce management: for each agent, the activity scheduled now, what they are actually doing, whether they are in adherence and for how long. Agents out of adherence come first.',
    input: {
      queue: z.string().optional().describe('Only members of this queue'),
      agents: z.array(z.string()).optional(),
      includeOffShift: z.boolean().optional().describe('Also list agents with no shift now who are offline. Default false.'),
    },
    async run({ queue, agents, includeOffShift }, ctx) {
      const users = await targetUsers(ctx, queue, agents);
      type Adherence = {
        user: { id: string };
        scheduledActivityCategory?: string;
        actualActivityCategory?: string;
        systemPresence?: string;
        routingStatus?: string;
        adherenceState?: string;
        impact?: string;
        timeOfAdherenceChange?: string;
      };
      const results: Adherence[] = [];
      for (let i = 0; i < users.length; i += 100) {
        const ids = users.slice(i, i + 100).map((u) => u.id);
        results.push(...(await ctx.client.request<Adherence[]>('GET', '/api/v2/workforcemanagement/adherence', { query: { userId: ids } })));
      }
      const now = ctx.now().getTime();
      const rows = results
        .filter((r) => includeOffShift || !(r.scheduledActivityCategory === 'Unscheduled' && r.systemPresence === 'OFFLINE'))
        .map((r) => ({
          agent: users.find((u) => u.id === r.user.id)?.name ?? r.user.id,
          adherence: r.adherenceState,
          scheduled: r.scheduledActivityCategory,
          actual: r.actualActivityCategory,
          presence: r.systemPresence,
          routingStatus: r.routingStatus,
          impact: r.impact,
          minutesInState: r.timeOfAdherenceChange ? Math.round((now - Date.parse(r.timeOfAdherenceChange)) / 60_000) : undefined,
        }))
        .sort((a, b) => Number(a.adherence === 'InAdherence') - Number(b.adherence === 'InAdherence') || (b.minutesInState ?? 0) - (a.minutesInState ?? 0));
      const inAdherence = rows.filter((r) => r.adherence === 'InAdherence').length;
      return {
        at: new Date(now).toISOString(),
        agents: rows.length,
        inAdherence,
        outOfAdherence: rows.filter((r) => r.adherence === 'OutOfAdherence').length,
        adherencePercent: rows.length ? round1((inAdherence / rows.length) * 100) : null,
        rows,
      };
    },
  }),

  define({
    name: 'get_agent_schedule',
    title: 'Agent schedules',
    description: 'Published workforce management schedules for a day: each agent shift with its activities (on queue, breaks, lunch, meetings, training) in local time.',
    input: {
      agents: z.array(z.string()).optional(),
      queue: z.string().optional().describe('Members of this queue'),
      day: dayArg,
    },
    async run({ agents, queue, day }, ctx) {
      const users = await targetUsers(ctx, queue, agents);
      const { start, end, label } = resolveDay(day, ctx);
      const schedules = await loadSchedules(ctx, users, start, end);
      const rows = users
        .map((u) => {
          const shifts = schedules.get(u.id) ?? [];
          return {
            agent: u.name,
            shifts: shifts.map((sh) => ({
              start: localClock(sh.start, ctx.timeZone),
              end: localClock(sh.end, ctx.timeZone),
              paidMinutes: sh.activities.filter((a) => a.paid !== false).reduce((n, a) => n + a.minutes, 0),
              onQueueMinutes: sh.activities.filter((a) => a.category === 'OnQueueWork').reduce((n, a) => n + a.minutes, 0),
              activities: sh.activities.map((a) => ({ start: localClock(a.start, ctx.timeZone), end: localClock(a.start + a.minutes * 60_000, ctx.timeZone), minutes: a.minutes, activity: a.name, category: a.category })),
            })),
          };
        })
        .sort((a, b) => String(a.shifts[0]?.start ?? '99').localeCompare(String(b.shifts[0]?.start ?? '99')));
      return { day: label, timeZone: ctx.timeZone, scheduled: rows.filter((r) => r.shifts.length).length, notScheduled: rows.filter((r) => !r.shifts.length).map((r) => r.agent), agents: rows.filter((r) => r.shifts.length) };
    },
  }),

  define({
    name: 'get_staffing',
    title: 'Scheduled and actual staffing',
    description:
      'For one queue and day, in time buckets: agents scheduled on queue, agents actually on queue, and the interactions offered, abandoned and service level. Shows when the queue was short of the plan and whether it hurt.',
    input: {
      queue: z.string().describe('Queue name or id'),
      day: dayArg,
      granularity: z.enum(['PT15M', 'PT30M', 'PT1H']).optional().describe('Default PT30M'),
    },
    async run({ queue, day, granularity }, ctx) {
      const [q] = await ctx.directory.resolveQueues([queue]);
      const members = (await pages<{ id: string; name: string; user?: Named }>(ctx.client, `/api/v2/routing/queues/${q!.id}/members`, {})).map((m) => ({ id: m.user?.id ?? m.id, name: m.user?.name ?? m.name }));
      const { start, end, label } = resolveDay(day, ctx);
      const step = { PT15M: 15, PT30M: 30, PT1H: 60 }[granularity ?? 'PT30M'] * 60_000;
      const now = ctx.now().getTime();
      const until = Math.min(end, now);
      const interval = `${new Date(start).toISOString()}/${new Date(end).toISOString()}`;
      type Period = { startTime: string; endTime?: string; systemPresence?: string };
      const [schedules, details, perf] = await Promise.all([
        loadSchedules(ctx, members, start, end),
        until > start
          ? ctx.client.request<{ userDetails?: { userId: string; primaryPresence?: Period[] }[] }>('POST', '/api/v2/analytics/users/details/query', {
              body: { interval: `${new Date(start).toISOString()}/${new Date(until).toISOString()}`, order: 'asc', userFilters: [{ type: 'or', predicates: members.map((m) => ({ dimension: 'userId', value: m.id })) }], paging: { pageSize: 100, pageNumber: 1 } },
            })
          : Promise.resolve({ userDetails: [] }),
        ctx.client.request<AggregateResult>('POST', '/api/v2/analytics/conversations/aggregates/query', {
          body: { interval, granularity: granularity ?? 'PT30M', groupBy: ['queueId'], filter: { type: 'or', predicates: [{ dimension: 'queueId', value: q!.id }] }, metrics: ['nOffered', 'tAbandon', 'oServiceLevel'] },
        }),
      ]);
      const overlap = (a0: number, a1: number, b0: number, b1: number) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
      const buckets = (perf.results ?? []).flatMap((r) => r.data ?? []);
      const series: Record<string, unknown>[] = [];
      for (let t = start; t < end; t += step) {
        const scheduled = [...schedules.values()].flat().flatMap((sh) => sh.activities).filter((a) => a.category === 'OnQueueWork').reduce((n, a) => n + overlap(a.start, a.start + a.minutes * 60_000, t, t + step), 0) / step;
        const actual = t < until
          ? (details.userDetails ?? []).flatMap((u) => u.primaryPresence ?? []).filter((p) => p.systemPresence === 'ON_QUEUE').reduce((n, p) => n + overlap(Date.parse(p.startTime), p.endTime ? Date.parse(p.endTime) : until, t, Math.min(t + step, until)), 0) / (Math.min(t + step, until) - t)
          : null;
        const bucket = buckets.find((b) => Date.parse(b.interval.split('/')[0]!) === t);
        const metrics = bucket?.metrics ?? [];
        const sl = stat(metrics, 'oServiceLevel');
        if (!scheduled && !actual && !metrics.length) continue;
        series.push({
          start: localClock(t, ctx.timeZone),
          scheduledOnQueue: round1(scheduled),
          actualOnQueue: actual === null ? null : round1(actual),
          difference: actual === null ? null : round1(actual - scheduled),
          offered: stat(metrics, 'nOffered').count ?? 0,
          abandoned: stat(metrics, 'tAbandon').count ?? 0,
          serviceLevelPercent: sl.denominator ? round1(((sl.numerator ?? 0) / sl.denominator) * 100) : null,
        });
      }
      const short = series.filter((r) => typeof r.difference === 'number' && (r.difference as number) <= -1);
      return {
        queue: q!.name,
        day: label,
        timeZone: ctx.timeZone,
        members: members.length,
        note: 'Agents are averages over each bucket. Agents who work several queues count fully in each of them.',
        bucketsShortOfPlan: short.map((r) => r.start),
        series,
      };
    },
  }),

  define({
    name: 'get_callbacks',
    title: 'Callbacks',
    description: 'Callbacks waiting now in each queue (with how long the oldest has waited) and callbacks requested and completed in an interval, with the average time until the customer was called back.',
    input: { queue: z.string().optional(), interval: intervalArg },
    async run({ queue, interval }, ctx) {
      const range = resolveInterval(interval, ctx.now(), ctx.timeZone);
      const targets = queue ? await ctx.directory.resolveQueues([queue]) : await ctx.directory.queues();
      const queueFilter = { type: 'or', predicates: targets.map((q) => ({ dimension: 'queueId', value: q.id })) };
      type Obs = { results?: { group: Record<string, string>; data?: { metric: string; stats: Stat; observations?: { observationDate: string; conversationId?: string; callbackNumbers?: string[]; ani?: string }[] }[] }[] };
      const [live, history] = await Promise.all([
        ctx.client.request<Obs>('POST', '/api/v2/analytics/queues/observations/query', {
          body: { filter: { type: 'and', clauses: [queueFilter, { type: 'or', predicates: [{ dimension: 'mediaType', value: 'callback' }] }] }, metrics: ['oWaiting', 'oInteracting'], detailMetrics: ['oWaiting'] },
        }),
        ctx.client.request<AggregateResult>('POST', '/api/v2/analytics/conversations/aggregates/query', {
          body: { interval: range.iso, groupBy: ['queueId'], filter: { type: 'and', clauses: [queueFilter, { type: 'or', predicates: [{ dimension: 'mediaType', value: 'callback' }] }] }, metrics: ['nOffered', 'tAnswered', 'tAbandon'] },
        }),
      ]);
      const now = ctx.now().getTime();
      const rows = targets
        .map((q) => {
          const data = (live.results ?? []).filter((r) => r.group.queueId === q.id && r.group.mediaType === 'callback').flatMap((r) => r.data ?? []);
          const waiting = data.filter((d) => d.metric === 'oWaiting');
          const since = waiting.flatMap((d) => d.observations ?? []).map((o) => ({ at: Date.parse(o.observationDate), number: o.callbackNumbers?.[0] ?? o.ani, conversationId: o.conversationId })).sort((a, b) => a.at - b.at);
          const metrics = (history.results ?? []).filter((r) => r.group.queueId === q.id).flatMap((r) => r.data ?? []).flatMap((d) => d.metrics);
          const answered = stat(metrics, 'tAnswered');
          return {
            queue: q.name,
            waitingNow: waiting.reduce((n, d) => n + (d.stats.count ?? 0), 0),
            inProgressNow: data.filter((d) => d.metric === 'oInteracting').reduce((n, d) => n + (d.stats.count ?? 0), 0),
            oldestWaitingMinutes: since.length ? Math.round((now - since[0]!.at) / 60_000) : null,
            oldest: since.slice(0, 3).map((x) => ({ conversationId: x.conversationId, waitingMinutes: Math.round((now - x.at) / 60_000), number: ctx.redact ? maskAddress(x.number) : x.number })),
            requested: stat(metrics, 'nOffered').count ?? 0,
            completed: answered.count ?? 0,
            avgMinutesToCallback: answered.count ? round1((answered.sum ?? 0) / answered.count / 60_000) : null,
            longestMinutesToCallback: answered.count ? round1((answered.max ?? 0) / 60_000) : null,
          };
        })
        .filter((r) => queue || r.requested || r.waitingNow);
      return { interval: range.iso, at: new Date(now).toISOString(), queues: rows };
    },
  }),

  define({
    name: 'get_campaigns',
    title: 'Outbound campaigns',
    description: 'Outbound dialing campaigns: status, dialing mode, queue, contact list progress, connect rate, and in an interval the calls attempted and connected and how they were closed.',
    input: { campaign: z.string().optional().describe('Campaign name, partial match'), interval: intervalArg },
    async run({ campaign, interval }, ctx) {
      const range = resolveInterval(interval, ctx.now(), ctx.timeZone);
      type Campaign = { id: string; name: string; campaignStatus?: string; dialingMode?: string; queue?: Named; contactList?: Named; abandonRate?: number };
      const all = await pages<Campaign>(ctx.client, '/api/v2/outbound/campaigns', {});
      const list = all.filter((c) => !campaign || c.name.toLowerCase().includes(campaign.toLowerCase()));
      if (campaign && !list.length) throw new Error(`No campaign matches '${campaign}'. Known campaigns: ${all.map((c) => c.name).join(', ')}.`);
      const [totals, byWrapup] = await Promise.all([
        ctx.client.request<AggregateResult>('POST', '/api/v2/analytics/conversations/aggregates/query', {
          body: { interval: range.iso, groupBy: ['outboundCampaignId'], filter: { type: 'or', predicates: list.map((c) => ({ dimension: 'outboundCampaignId', value: c.id })) }, metrics: ['nOutboundAttempted', 'nOutboundConnected', 'tHandle'] },
        }),
        ctx.client.request<AggregateResult>('POST', '/api/v2/analytics/conversations/aggregates/query', {
          body: { interval: range.iso, groupBy: ['outboundCampaignId', 'wrapUpCode'], filter: { type: 'or', predicates: list.map((c) => ({ dimension: 'outboundCampaignId', value: c.id })) }, metrics: ['tHandle'] },
        }),
      ]);
      const rows = await Promise.all(
        list.map(async (c) => {
          type Stats = { contactRate?: { attempts?: number; connects?: number; connectRatio?: number }; idleAgents?: number; outstandingCalls?: number; scheduledCalls?: number };
          type Progress = { numberOfContactsCalled?: number; totalNumberOfContacts?: number; percentage?: number };
          const [stats, progress] = await Promise.all([
            ctx.client.request<Stats>('GET', `/api/v2/outbound/campaigns/${c.id}/stats`),
            ctx.client.request<Progress>('GET', `/api/v2/outbound/campaigns/${c.id}/progress`),
          ]);
          const metrics = (totals.results ?? []).filter((r) => r.group.outboundCampaignId === c.id).flatMap((r) => r.data ?? []).flatMap((d) => d.metrics);
          const attempted = stat(metrics, 'nOutboundAttempted').count ?? 0;
          const connected = stat(metrics, 'nOutboundConnected').count ?? 0;
          const wrapups = await Promise.all(
            (byWrapup.results ?? [])
              .filter((r) => r.group.outboundCampaignId === c.id && r.group.wrapUpCode)
              .map(async (r) => ({ wrapUp: (await ctx.directory.wrapupName(r.group.wrapUpCode))!, count: stat((r.data ?? []).flatMap((d) => d.metrics), 'tHandle').count ?? 0 })),
          );
          return {
            campaign: c.name,
            status: c.campaignStatus,
            dialingMode: c.dialingMode,
            queue: c.queue?.name,
            contactList: c.contactList?.name,
            progress: { contactsCalled: progress.numberOfContactsCalled, totalContacts: progress.totalNumberOfContacts, percent: progress.percentage },
            now: { idleAgents: stats.idleAgents, outstandingCalls: stats.outstandingCalls, scheduledCallbacks: stats.scheduledCalls },
            inInterval: {
              attempted,
              connected,
              connectRatePercent: attempted ? round1((connected / attempted) * 100) : null,
              avgHandleSeconds: avgSeconds(stat(metrics, 'tHandle')),
              wrapUps: wrapups.sort((a, b) => b.count - a.count),
            },
          };
        }),
      );
      return { interval: range.iso, campaigns: rows };
    },
  }),
];

// ---- helpers -----------------------------------------------------------------------------

async function filters(ctx: ToolContext, queue: string | undefined, agent: string | undefined) {
  const predicates: { dimension: string; value: string }[] = [];
  if (queue) predicates.push({ dimension: 'queueId', value: (await ctx.directory.resolveQueues([queue]))[0]!.id });
  if (agent) predicates.push({ dimension: 'userId', value: (await ctx.directory.resolveUsers([agent]))[0]!.id });
  return predicates;
}

async function targetUsers(ctx: ToolContext, queue: string | undefined, agents: string[] | undefined): Promise<Named[]> {
  if (agents?.length) return ctx.directory.resolveUsers(agents);
  if (queue) {
    const [q] = await ctx.directory.resolveQueues([queue]);
    return (await pages<{ id: string; name: string; user?: Named }>(ctx.client, `/api/v2/routing/queues/${q!.id}/members`, {})).map((m) => ({ id: m.user?.id ?? m.id, name: m.user?.name ?? m.name }));
  }
  return ctx.directory.users();
}

function average(s: Stat): number | null {
  return s.count ? round1((s.sum ?? 0) / s.count) : null;
}

function minOf(metrics: { metric: string; stats: Stat & { min?: number } }[], name: string): number {
  return Math.min(...metrics.filter((m) => m.metric === name && m.stats.min !== undefined).map((m) => m.stats.min!));
}

/** A local calendar day as a UTC interval. */
function resolveDay(day: string | undefined, ctx: ToolContext): { start: number; end: number; label: string } {
  const now = ctx.now();
  const text = (day ?? 'today').trim().toLowerCase();
  const shift = text === 'today' ? 0 : text === 'yesterday' ? -1 : text === 'tomorrow' ? 1 : undefined;
  let start: number;
  if (shift !== undefined) start = startOfDay(new Date(now.getTime() + shift * 86_400_000), ctx.timeZone).getTime();
  else if (/^\d{4}-\d{2}-\d{2}$/.test(text)) start = startOfDay(new Date(Date.parse(`${text}T12:00:00Z`)), ctx.timeZone).getTime();
  else throw new Error(`Unrecognised day '${day}'. Use today, yesterday, tomorrow or YYYY-MM-DD.`);
  const end = startOfDay(new Date(start + 36 * 3_600_000), ctx.timeZone).getTime();
  return { start, end, label: new Date(start + 12 * 3_600_000).toISOString().slice(0, 10) };
}

function localClock(t: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(t));
}

interface ScheduledShift {
  start: number;
  end: number;
  activities: { start: number; minutes: number; name: string; category: string; paid?: boolean }[];
}

/** Published schedules for the given users, grouped by management unit, keyed by user id. */
async function loadSchedules(ctx: ToolContext, users: Named[], start: number, end: number): Promise<Map<string, ScheduledShift[]>> {
  type Unit = { managementUnit?: { id: string }; businessUnit?: { id: string } };
  const units = new Map<string, { businessUnitId?: string; userIds: string[] }>();
  for (const u of users) {
    let unit: Unit;
    try {
      unit = await ctx.client.request<Unit>('GET', `/api/v2/workforcemanagement/agents/${u.id}/managementunit`);
    } catch {
      continue; // not in workforce management
    }
    if (!unit.managementUnit) continue;
    const entry = units.get(unit.managementUnit.id) ?? { businessUnitId: unit.businessUnit?.id, userIds: [] };
    entry.userIds.push(u.id);
    units.set(unit.managementUnit.id, entry);
  }
  const out = new Map<string, ScheduledShift[]>();
  for (const [muId, unit] of units) {
    const codes = unit.businessUnitId
      ? ((await ctx.client.request<{ entities?: { id: string; name?: string; category?: string }[] }>('GET', `/api/v2/workforcemanagement/businessunits/${unit.businessUnitId}/activitycodes`)).entities ?? [])
      : [];
    type Search = {
      status?: string;
      result?: { agentSchedules?: { user: { id: string }; shifts?: { startDate: string; lengthMinutes: number; activities?: { activityCodeId?: string; startDate: string; lengthMinutes: number; description?: string; paid?: boolean }[] }[] }[] };
    };
    const res = await ctx.client.request<Search>('POST', `/api/v2/workforcemanagement/managementunits/${muId}/agentschedules/search`, {
      body: { startDate: new Date(start).toISOString(), endDate: new Date(end).toISOString(), userIds: unit.userIds },
    });
    if (!res.result) throw new Error('The schedule search was answered asynchronously, which this server does not support yet. Ask for fewer agents or a shorter period.');
    for (const a of res.result.agentSchedules ?? []) {
      out.set(
        a.user.id,
        (a.shifts ?? []).map((sh) => ({
          start: Date.parse(sh.startDate),
          end: Date.parse(sh.startDate) + sh.lengthMinutes * 60_000,
          activities: (sh.activities ?? []).map((act) => {
            const code = codes.find((c) => c.id === act.activityCodeId);
            return { start: Date.parse(act.startDate), minutes: act.lengthMinutes, name: act.description ?? code?.name ?? 'Activity', category: code?.category ?? 'Unknown', paid: act.paid };
          }),
        })),
      );
    }
  }
  return out;
}
