import { z } from 'zod';
import type { Named } from './directory.js';
import {
  type AggregateResult,
  avgSeconds,
  cursorPages,
  define,
  intervalArg,
  pages,
  queuesArg,
  round1,
  stat,
  type Stat,
  statusTimes,
  type ToolContext,
  type UserEntity,
} from './kit.js';
import { maskText } from './redact.js';
import { formatLocal } from './schedule.js';
import { resolveInterval } from './time.js';

// Channels and bots, routing setup, teams, and the change history of the configuration.

const longIntervalArg = z.string().optional().describe('last 7d (default), last 30d, this_week, yesterday, or an ISO-8601 interval start/end');

type Metrics = { metric: string; stats: Stat }[];
type Group = { group: Record<string, string>; data?: { metrics: Metrics }[] };
type Person = UserEntity & { division?: Named; manager?: { id: string } };

const CHANNELS: Record<string, string> = {
  webmessaging: 'Web messaging',
  whatsapp: 'WhatsApp',
  facebook: 'Facebook Messenger',
  instagram: 'Instagram',
  sms: 'SMS',
  twitter: 'X',
  line: 'LINE',
  open: 'Open messaging',
};

const AREAS = {
  queues: [{ service: 'Routing', types: ['Queue'] }],
  wrapup_codes: [{ service: 'Routing', types: ['WrapupCode'] }],
  skills: [{ service: 'Routing', types: ['Skill', 'Language'] }],
  flows: [{ service: 'Architect', types: ['Flow'] }],
  schedules: [{ service: 'Architect', types: ['Schedule', 'ScheduleGroup'] }],
  users: [{ service: 'Directory', types: ['User'] }],
} as const;

export const organizationTools = [
  define({
    name: 'get_channel_mix',
    title: 'Channels',
    description:
      'Interactions per channel in an interval: voice in and out, callbacks, web messaging, WhatsApp, Facebook and other messaging, with share of the total, answered, abandon rate, service level, speed of answer and handle time.',
    input: { interval: intervalArg, queues: queuesArg },
    async run({ interval, queues }, ctx) {
      const range = resolveInterval(interval, ctx.now(), ctx.timeZone);
      const targets = queues?.length ? await ctx.directory.resolveQueues(queues) : [];
      const res = await ctx.client.request<AggregateResult>('POST', '/api/v2/analytics/conversations/aggregates/query', {
        body: {
          interval: range.iso,
          groupBy: ['mediaType', 'messageType', 'direction'],
          ...(targets.length ? { filter: { type: 'or', predicates: targets.map((q) => ({ dimension: 'queueId', value: q.id })) } } : {}),
          metrics: ['nOffered', 'nOutbound', 'tAnswered', 'tAbandon', 'tHandle', 'oServiceLevel'],
        },
      });
      const rows = (res.results ?? []).map((r) => {
        const metrics = (r.data ?? []).flatMap((d) => d.metrics);
        const outbound = r.group.direction === 'outbound';
        const offered = stat(metrics, 'nOffered').count ?? 0;
        const answered = stat(metrics, 'tAnswered');
        const abandoned = stat(metrics, 'tAbandon').count ?? 0;
        const sl = stat(metrics, 'oServiceLevel');
        const handle = stat(metrics, 'tHandle');
        return {
          channel: channelName(r.group.mediaType, r.group.messageType),
          direction: r.group.direction ?? 'inbound',
          interactions: outbound ? (stat(metrics, 'nOutbound').count ?? handle.count ?? 0) : offered,
          ...(outbound
            ? {}
            : {
                answered: answered.count ?? 0,
                abandonRatePercent: offered ? round1((abandoned / offered) * 100) : null,
                serviceLevelPercent: sl.denominator ? round1(((sl.numerator ?? 0) / sl.denominator) * 100) : null,
                avgSpeedOfAnswerSeconds: avgSeconds(answered),
              }),
          handled: handle.count ?? 0,
          avgHandleSeconds: avgSeconds(handle),
        };
      });
      const total = rows.reduce((n, r) => n + r.interactions, 0);
      return {
        interval: range.iso,
        ...(targets.length ? { queues: targets.map((q) => q.name) } : {}),
        total,
        channels: rows.map((r) => ({ ...r, sharePercent: total ? round1((r.interactions / total) * 100) : 0 })).sort((a, b) => b.interactions - a.interactions),
      };
    },
  }),

  define({
    name: 'get_bot_performance',
    title: 'Bot performance',
    description:
      'Bot flows in an interval: sessions, how many ended in the bot and how many went to an agent, the intents customers asked for, how often the bot did not understand, and the messages it did not understand most often.',
    input: {
      bot: z.string().optional().describe('Bot flow name, partial match. Omit for all bot flows.'),
      interval: intervalArg,
    },
    async run({ bot, interval }, ctx) {
      const range = resolveInterval(interval, ctx.now(), ctx.timeZone);
      const all = await ctx.directory.flows();
      const bots = bot ? await ctx.directory.resolveFlows([bot]) : all.filter((f) => /bot$/i.test(f.type ?? ''));
      if (!bots.length) return { interval: range.iso, bots: [], note: 'No bot flows found. get_flow_performance covers IVR and other inbound flows.' };
      const res = await ctx.client.request<AggregateResult>('POST', '/api/v2/analytics/flows/aggregates/query', {
        body: {
          interval: range.iso,
          groupBy: ['flowId'],
          filter: { type: 'or', predicates: bots.map((f) => ({ dimension: 'flowId', value: f.id })) },
          metrics: ['nFlow', 'tFlowExit', 'tFlowDisconnect', 'nFlowOutcome'],
        },
      });
      type Turn = { sessionId: string; userInput?: string; intent?: { name?: string }; askActionResult?: string };
      const rows = await Promise.all(
        bots.map(async (f) => {
          const metrics = (res.results ?? []).filter((r) => r.group.flowId === f.id).flatMap((r) => r.data ?? []).flatMap((d) => d.metrics);
          const sessions = stat(metrics, 'nFlow').count ?? 0;
          const toAgent = stat(metrics, 'tFlowExit').count ?? 0;
          const ended = stat(metrics, 'tFlowDisconnect').count ?? 0;
          const resolved = stat(metrics, 'nFlowOutcome').count ?? 0;
          const { items: turns, truncated } = await cursorPages<Turn>(ctx.client, `/api/v2/analytics/botflows/${f.id}/reportingturns`, { interval: range.iso }, 50);
          const bySession = new Map<string, Turn[]>();
          for (const t of turns) bySession.set(t.sessionId, [...(bySession.get(t.sessionId) ?? []), t]);
          const intents = new Map<string, { sessions: number; askedForAgent: number }>();
          let askedForAgent = 0;
          for (const list of bySession.values()) {
            const intent = list.find((t) => t.intent?.name)?.intent?.name ?? '(no intent recognised)';
            const agent = list.some((t) => t.askActionResult === 'AgentRequestedByUser');
            if (agent) askedForAgent++;
            const entry = intents.get(intent) ?? { sessions: 0, askedForAgent: 0 };
            entry.sessions++;
            if (agent) entry.askedForAgent++;
            intents.set(intent, entry);
          }
          const noMatch = turns.filter((t) => t.askActionResult === 'NoMatchCollection');
          const noInput = turns.filter((t) => t.askActionResult === 'NoInputCollection').length;
          const unrecognised = new Map<string, number>();
          for (const t of noMatch) {
            const text = (t.userInput ?? '').trim().toLowerCase();
            if (text) unrecognised.set(text, (unrecognised.get(text) ?? 0) + 1);
          }
          return {
            bot: f.name,
            sessions,
            endedInBot: ended,
            endedInBotPercent: sessions ? round1((ended / sessions) * 100) : null,
            resolvedInBot: resolved,
            resolvedPercent: sessions ? round1((resolved / sessions) * 100) : null,
            sentToAgent: toAgent,
            sentToAgentPercent: sessions ? round1((toAgent / sessions) * 100) : null,
            turns: {
              total: turns.length,
              ...(truncated ? { truncated: true } : {}),
              notUnderstoodPercent: turns.length ? round1((noMatch.length / turns.length) * 100) : null,
              noInputPercent: turns.length ? round1((noInput / turns.length) * 100) : null,
              sessionsAskingForAgent: askedForAgent,
            },
            intents: [...intents.entries()]
              .map(([intent, x]) => ({ intent, sessions: x.sessions, percent: round1((x.sessions / bySession.size) * 100), askedForAgentPercent: round1((x.askedForAgent / x.sessions) * 100) }))
              .sort((a, b) => b.sessions - a.sessions),
            notUnderstood: [...unrecognised.entries()]
              .sort((a, b) => b[1] - a[1])
              .slice(0, 10)
              .map(([text, count]) => ({ message: ctx.redact ? maskText(text) : text, count })),
          };
        }),
      );
      return {
        interval: range.iso,
        note: 'endedInBot includes customers who left without an answer; resolvedInBot counts sessions with a successful flow outcome. Intents and messages come from the bot turns.',
        bots: rows,
      };
    },
  }),

  define({
    name: 'find_agents',
    title: 'Find agents by skill or language',
    description:
      'Agents who have a skill or language, optionally in one queue and above a proficiency, with their current status. Answers questions like who can take Spanish calls right now.',
    input: {
      skill: z.string().optional().describe('Routing skill, partial match'),
      language: z.string().optional().describe('Language skill, partial match'),
      queue: z.string().optional().describe('Only members of this queue'),
      minProficiency: z.number().min(0).max(5).optional().describe('Minimum proficiency, 0 to 5'),
      availableOnly: z.boolean().optional().describe('Only agents on queue and idle now'),
    },
    async run({ skill, language, queue, minProficiency, availableOnly }, ctx) {
      let users = await pages<Person>(ctx.client, '/api/v2/users', { expand: 'presence,routingStatus,skills,languages', state: 'active' });
      if (queue) {
        const [q] = await ctx.directory.resolveQueues([queue]);
        const members = new Set((await pages<{ id: string; user?: Named }>(ctx.client, `/api/v2/routing/queues/${q!.id}/members`, {})).map((m) => m.user?.id ?? m.id));
        users = users.filter((u) => members.has(u.id));
      }
      const pick = (list: { name: string; proficiency?: number }[] | undefined, needle: string | undefined) =>
        needle ? (list ?? []).find((x) => x.name.toLowerCase().includes(needle.toLowerCase())) : undefined;
      const min = minProficiency ?? 0;
      const rows = users
        .map((u) => {
          const presence = u.presence?.presenceDefinition?.systemPresence ?? 'Unknown';
          const routing = u.routingStatus?.status ?? 'OFF_QUEUE';
          const s = pick(u.skills, skill);
          const l = pick(u.languages, language);
          return {
            name: u.name,
            presence,
            routingStatus: routing,
            availableNow: /^on[ _]queue$/i.test(presence) && routing === 'IDLE',
            ...(skill ? { skill: s?.name, skillProficiency: s?.proficiency } : {}),
            ...(language ? { language: l?.name, languageProficiency: l?.proficiency } : {}),
            match: (!skill || (s && (s.proficiency ?? 0) >= min)) && (!language || (l && (l.proficiency ?? 0) >= min)),
          };
        })
        .filter((r) => r.match)
        .map(({ match: _match, ...r }) => r);
      const onQueue = rows.filter((r) => /^on[ _]queue$/i.test(r.presence));
      const order = (r: (typeof rows)[number]) => (r.availableNow ? 0 : /^on[ _]queue$/i.test(r.presence) ? 1 : r.presence.toLowerCase() === 'offline' ? 3 : 2);
      const shown = rows
        .filter((r) => !availableOnly || r.availableNow)
        .sort((a, b) => order(a) - order(b) || (b.skillProficiency ?? b.languageProficiency ?? 0) - (a.skillProficiency ?? a.languageProficiency ?? 0) || a.name.localeCompare(b.name));
      return { matching: rows.length, onQueueNow: onQueue.length, availableNow: rows.filter((r) => r.availableNow).length, agents: shown };
    },
  }),

  define({
    name: 'get_routing_overview',
    title: 'Routing setup across queues',
    description:
      'Routing configuration of several queues side by side: service level target, alerting timeout, after-call work, skill evaluation, members joined and on queue now, how many members hold each skill and language, and setup problems such as members who are not joined or optional after-call work.',
    input: { queues: queuesArg },
    async run({ queues }, ctx) {
      const targets = queues?.length ? await ctx.directory.resolveQueues(queues) : await ctx.directory.queues();
      type QueueEntity = {
        name: string;
        mediaSettings?: Record<string, { alertingTimeoutSeconds?: number; serviceLevel?: { percentage?: number; durationMs?: number } }>;
        acwSettings?: { wrapupPrompt?: string; timeoutMs?: number };
        skillEvaluationMethod?: string;
      };
      type Member = { id: string; name: string; joined?: boolean; user?: Person; routingStatus?: { status?: string } };
      const findings: string[] = [];
      const rows = await Promise.all(
        targets.map(async (t) => {
          const [q, members, wrapups] = await Promise.all([
            ctx.client.request<QueueEntity>('GET', `/api/v2/routing/queues/${t.id}`),
            pages<Member>(ctx.client, `/api/v2/routing/queues/${t.id}/members`, { expand: 'presence,routingStatus,skills,languages' }),
            pages<Named>(ctx.client, `/api/v2/routing/queues/${t.id}/wrapupcodes`, {}),
          ]);
          const onQueue = members.filter((m) => /^on[ _]queue$/i.test(m.user?.presence?.presenceDefinition?.systemPresence ?? ''));
          const holders = (key: 'skills' | 'languages') => {
            const out = new Map<string, { members: number; onQueueNow: number }>();
            for (const m of members) {
              for (const x of m.user?.[key] ?? []) {
                const entry = out.get(x.name) ?? { members: 0, onQueueNow: 0 };
                entry.members++;
                if (onQueue.includes(m)) entry.onQueueNow++;
                out.set(x.name, entry);
              }
            }
            return [...out.entries()].map(([name, v]) => ({ name, ...v })).sort((a, b) => a.name.localeCompare(b.name));
          };
          const skills = holders('skills');
          const languages = holders('languages');
          const joined = members.filter((m) => m.joined ?? true).length;
          if (!members.length) findings.push(`${q.name} has no members.`);
          else if (!joined) findings.push(`No member of ${q.name} is joined to the queue.`);
          else if (joined < members.length) findings.push(`${members.length - joined} of ${members.length} members of ${q.name} are not joined.`);
          if (members.length && !onQueue.length) findings.push(`No member of ${q.name} is on queue right now.`);
          if (!wrapups.length) findings.push(`${q.name} has no wrap-up codes.`);
          if (q.acwSettings?.wrapupPrompt === 'OPTIONAL') findings.push(`After-call work is optional in ${q.name}, so wrap-up codes may be missing.`);
          const media = Object.entries(q.mediaSettings ?? {})[0];
          return {
            queue: q.name,
            media: media?.[0],
            serviceLevelTarget: media?.[1].serviceLevel ? `${Math.round((media[1].serviceLevel.percentage ?? 0) * 100)}% in ${Math.round((media[1].serviceLevel.durationMs ?? 0) / 1000)}s` : undefined,
            alertingTimeoutSeconds: media?.[1].alertingTimeoutSeconds,
            afterCallWork: q.acwSettings?.wrapupPrompt,
            afterCallWorkTimeoutSeconds: q.acwSettings?.timeoutMs !== undefined ? Math.round(q.acwSettings.timeoutMs / 1000) : undefined,
            skillEvaluation: q.skillEvaluationMethod,
            wrapUpCodes: wrapups.length,
            members: members.length,
            joined,
            onQueueNow: onQueue.length,
            skills,
            languages,
          };
        }),
      );
      return { at: ctx.now().toISOString(), queues: rows, findings };
    },
  }),

  define({
    name: 'list_teams',
    title: 'Teams',
    description: 'Teams with their division, supervisor, members and how many members are on queue now.',
    input: { name: z.string().optional().describe('Filter by team name, partial match') },
    async run({ name }, ctx) {
      const [teams, people] = await Promise.all([loadTeams(ctx), loadPeople(ctx)]);
      const rows = await Promise.all(
        teams
          .filter((t) => !name || t.name.toLowerCase().includes(name.toLowerCase()))
          .map(async (t) => {
            const members = t.memberIds.map((id) => people.get(id)).filter((u): u is Person => !!u);
            return {
              team: t.name,
              description: t.description,
              division: t.division?.name,
              supervisor: await supervisorOf(ctx, members),
              members: members.length,
              onQueueNow: members.filter((u) => /^on[ _]queue$/i.test(u.presence?.presenceDefinition?.systemPresence ?? '')).length,
              memberNames: members.map((u) => u.name).sort(),
            };
          }),
      );
      return { count: rows.length, teams: rows };
    },
  }),

  define({
    name: 'get_team_performance',
    title: 'Team performance',
    description:
      'Teams, supervisors or divisions compared over an interval: members, interactions handled, average handle time, time on queue and occupancy, quality score and NPS.',
    input: {
      groupBy: z.enum(['team', 'supervisor', 'division']).optional().describe('team (default), supervisor (the manager set on each user) or division'),
      interval: longIntervalArg,
    },
    async run({ groupBy, interval }, ctx) {
      const range = resolveInterval(interval ?? 'last 7d', ctx.now(), ctx.timeZone);
      const by = groupBy ?? 'team';
      const people = await loadPeople(ctx);
      const groups = new Map<string, string[]>();
      const add = (key: string, id: string) => groups.set(key, [...(groups.get(key) ?? []), id]);
      if (by === 'team') {
        const teams = await loadTeams(ctx);
        for (const t of teams) for (const id of t.memberIds) if (people.has(id)) add(t.name, id);
        const inTeam = new Set(teams.flatMap((t) => t.memberIds));
        for (const id of people.keys()) if (!inTeam.has(id)) add('(no team)', id);
      } else {
        for (const u of people.values()) {
          if (by === 'division') add(u.division?.name ?? '(no division)', u.id);
          else add(u.manager?.id ? ((await ctx.directory.userName(u.manager.id)) ?? u.manager.id) : '(no supervisor)', u.id);
        }
      }
      const ids = [...new Set([...groups.values()].flat())];
      const [handled, status, quality, surveys] = await Promise.all([
        byUser(ctx, '/api/v2/analytics/conversations/aggregates/query', ids, range.iso, ['tHandle']),
        statusTimes(ctx, ids, range.iso),
        byUser(ctx, '/api/v2/analytics/evaluations/aggregates/query', ids, range.iso, ['nEvaluations', 'oTotalScore']),
        byUser(ctx, '/api/v2/analytics/surveys/aggregates/query', ids, range.iso, ['nSurveyNpsResponses', 'nSurveyNpsPromoters', 'nSurveyNpsDetractors']),
      ]);
      const rows = [...groups.entries()].map(([group, members]) => {
        const pick = (m: Map<string, Metrics>) => members.flatMap((id) => m.get(id) ?? []);
        const handle = stat(pick(handled), 'tHandle');
        const times = members.map((id) => status.get(id)).filter((x) => !!x);
        const total = (k: 'loggedInMinutes' | 'onQueueMinutes' | 'idleMinutes' | 'interactingMinutes') => times.reduce((n, x) => n + x[k], 0);
        const q = pick(quality);
        const score = stat(q, 'oTotalScore');
        const s = pick(surveys);
        const count = (m: string) => stat(s, m).count ?? 0;
        const responses = count('nSurveyNpsResponses');
        const busy = total('idleMinutes') + total('interactingMinutes');
        return {
          [by]: group,
          members: members.length,
          handled: handle.count ?? 0,
          handledPerMember: members.length ? round1((handle.count ?? 0) / members.length) : 0,
          avgHandleSeconds: avgSeconds(handle),
          onQueuePercent: total('loggedInMinutes') ? round1((total('onQueueMinutes') / total('loggedInMinutes')) * 100) : null,
          occupancyPercent: busy ? round1((total('interactingMinutes') / busy) * 100) : null,
          evaluations: stat(q, 'nEvaluations').count ?? 0,
          avgQualityScore: score.count ? round1((score.sum ?? 0) / score.count) : null,
          surveyResponses: responses,
          nps: responses ? Math.round(((count('nSurveyNpsPromoters') - count('nSurveyNpsDetractors')) / responses) * 100) : null,
        };
      });
      rows.sort((a, b) => b.handled - a.handled);
      return { interval: range.iso, groupBy: by, rows };
    },
  }),

  define({
    name: 'get_recent_changes',
    title: 'Recent configuration changes',
    description:
      'Who changed what in the configuration, newest first, from the audit log: queues, flows, schedules, users, wrap-up codes and skills, with old and new values. Use it when something started behaving differently.',
    input: {
      interval: z.string().optional().describe('last 7d (default), last 24h, yesterday, or an ISO-8601 interval; at most 14 days back'),
      area: z.enum(['queues', 'flows', 'schedules', 'users', 'wrapup_codes', 'skills']).optional().describe('Omit for all of them'),
      entity: z.string().optional().describe('Name of the changed object, partial match'),
      changedBy: z.string().optional().describe('Name of the person who made the change, partial match'),
      limit: z.number().int().min(1).max(200).optional().describe('Default 50'),
    },
    async run({ interval, area, entity, changedBy, limit }, ctx) {
      const range = resolveInterval(interval ?? 'last 7d', ctx.now(), ctx.timeZone);
      if (ctx.now().getTime() - range.start.getTime() > 14 * 86_400_000 + 60_000) throw new Error('The audit query covers the last 14 days. Use a shorter interval.');
      const scopes = area ? AREAS[area] : Object.values(AREAS).flat();
      type Change = { property?: string; oldValues?: string[]; newValues?: string[] };
      type AuditEntry = { id: string; eventDate: string; user?: Named; serviceName?: string; entityType?: string; entity?: Named; action?: string; propertyChanges?: Change[] };
      const queries = scopes.flatMap((s) => s.types.map((type) => ({ service: s.service, type })));
      const results = await Promise.all(
        queries.map(async ({ service, type }) => {
          const out: AuditEntry[] = [];
          for (let pageNumber = 1; pageNumber <= 5; pageNumber++) {
            const page = await ctx.client.request<{ entities?: AuditEntry[]; pageCount?: number }>('POST', '/api/v2/audits/query/realtime', {
              query: { expand: 'user' },
              body: { interval: range.iso, serviceName: service, filters: [{ property: 'EntityType', value: type }], sort: [{ name: 'Timestamp', sortOrder: 'descending' }], pageNumber, pageSize: 100 },
            });
            out.push(...(page.entities ?? []));
            if (!page.pageCount || pageNumber >= page.pageCount) break;
          }
          return out;
        }),
      );
      const seen = new Set<string>();
      const contains = (value: string | undefined, needle: string | undefined) => !needle || (value ?? '').toLowerCase().includes(needle.toLowerCase());
      const entries = results
        .flat()
        .filter((e) => !seen.has(e.id) && seen.add(e.id))
        .filter((e) => contains(e.entity?.name, entity) && contains(e.user?.name, changedBy))
        .sort((a, b) => Date.parse(b.eventDate) - Date.parse(a.eventDate));
      const max = limit ?? 50;
      return {
        interval: range.iso,
        timeZone: ctx.timeZone,
        total: entries.length,
        changes: await Promise.all(
          entries.slice(0, max).map(async (e) => ({
            at: e.eventDate,
            localTime: formatLocal(Date.parse(e.eventDate), ctx.timeZone),
            changedBy: e.user?.name ?? (await ctx.directory.userName(e.user?.id)),
            service: e.serviceName,
            type: e.entityType,
            name: e.entity?.name,
            action: e.action,
            changes: (e.propertyChanges ?? []).map((c) => ({ property: c.property, from: join(c.oldValues), to: join(c.newValues) })),
          })),
        ),
      };
    },
  }),
];

// ---- helpers -----------------------------------------------------------------------------

function channelName(media: string | undefined, messageType: string | undefined): string {
  if (media === 'message') return messageType ? (CHANNELS[messageType.toLowerCase()] ?? messageType) : 'Messaging';
  if (media === 'voice') return 'Voice';
  if (media === 'callback') return 'Callback';
  if (media === 'chat') return 'Web chat';
  if (media === 'email') return 'Email';
  return media ?? 'Unknown';
}

function join(values: string[] | undefined): string | undefined {
  return values?.length ? values.join(', ') : undefined;
}

async function loadTeams(ctx: ToolContext) {
  type Team = Named & { description?: string; division?: Named };
  const { items } = await cursorPages<Team>(ctx.client, '/api/v2/teams', {});
  return Promise.all(
    items.map(async (t) => ({ ...t, memberIds: (await cursorPages<{ id: string }>(ctx.client, `/api/v2/teams/${t.id}/members`, {})).items.map((m) => m.id) })),
  );
}

async function loadPeople(ctx: ToolContext): Promise<Map<string, Person>> {
  const users = await pages<Person>(ctx.client, '/api/v2/users', { expand: 'presence,routingStatus', state: 'active' });
  return new Map(users.map((u) => [u.id, u]));
}

/** The manager most members of a team report to. */
async function supervisorOf(ctx: ToolContext, members: Person[]): Promise<string | undefined> {
  const counts = new Map<string, number>();
  for (const u of members) if (u.manager?.id) counts.set(u.manager.id, (counts.get(u.manager.id) ?? 0) + 1);
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return top ? ctx.directory.userName(top[0]) : undefined;
}

/** An analytics aggregate grouped by user, sent in chunks of 100 users. */
async function byUser(ctx: ToolContext, path: string, ids: string[], interval: string, metrics: string[]): Promise<Map<string, Metrics>> {
  const out = new Map<string, Metrics>();
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const res = await ctx.client.request<{ results?: Group[] }>('POST', path, {
      body: { interval, groupBy: ['userId'], filter: { type: 'or', predicates: chunk.map((id) => ({ dimension: 'userId', value: id })) }, metrics },
    });
    for (const r of res.results ?? []) out.set(r.group.userId!, [...(out.get(r.group.userId!) ?? []), ...(r.data ?? []).flatMap((d) => d.metrics)]);
  }
  return out;
}
