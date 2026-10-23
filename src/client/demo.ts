import { assertReadOnly, PlatformError, type Method, type PlatformClient, type RequestOptions } from './types.js';

/**
 * A fictional contact center that answers the same Platform API requests as a real org.
 *
 * Arrivals follow a daily curve per queue. Each arrival is routed to the first agent on the
 * queue who is on shift and free, so waits and abandons come from the load and staffing
 * instead of being drawn at random. Data is generated per day from a fixed seed, so the same
 * day always produces the same conversations, and live observations are derived from the
 * conversations in progress at the current time.
 */
export class DemoPlatformClient implements PlatformClient {
  private readonly days = new Map<number, DemoConversation[]>();
  private readonly queues: DemoQueue[];
  private readonly agents: DemoAgent[];
  private readonly wrapups: { id: string; name: string }[];
  private readonly byId = new Map<string, DemoConversation>();
  private readonly flows: DemoFlow[];
  private readonly flowDays = new Map<number, DemoFlowSession[]>();
  private readonly skills: { id: string; name: string }[];
  private readonly scheduleGroup: { id: string; name: string; timeZone: string; open: DemoSchedule[]; closed: DemoSchedule[]; holidays: DemoSchedule[] };

  constructor(private readonly now: () => Date = () => new Date()) {
    const rng = random(7);
    this.queues = QUEUES.map((q) => ({ ...q, id: uuid(rng) }));
    this.wrapups = WRAPUPS.map((name) => ({ id: uuid(rng), name }));
    this.agents = AGENTS.map(([name, queueNames, shiftStart], i) => ({
      id: uuid(rng),
      name,
      email: `${name.toLowerCase().replace(/[^a-z]+/g, '.')}@example.com`,
      department: i % 3 === 0 ? 'Customer Care' : i % 3 === 1 ? 'Sales and Retention' : 'Customer Care',
      queueIds: queueNames.map((n) => this.queues.find((q) => q.name === n)!.id),
      shiftStart,
    }));
    this.skills = SKILLS.map((name) => ({ id: uuid(rng), name }));
    this.flows = FLOWS.map((f) => ({ ...f, id: uuid(rng), queueIds: f.queues.map((n) => this.queues.find((q) => q.name === n)!.id) }));
    const schedule = (name: string, start: string, end: string, rrule?: string): DemoSchedule => ({ id: uuid(rng), name, start, end, ...(rrule ? { rrule } : {}) });
    this.scheduleGroup = {
      id: uuid(rng),
      name: 'Contact Center Hours',
      timeZone: 'America/Bogota',
      open: [
        schedule('Weekdays 08:00-20:00', '2026-01-05T08:00:00.000', '2026-01-05T20:00:00.000', 'FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,TU,WE,TH,FR'),
        schedule('Weekends 09:00-17:00', '2026-01-03T09:00:00.000', '2026-01-03T17:00:00.000', 'FREQ=WEEKLY;INTERVAL=1;BYDAY=SA,SU'),
      ],
      closed: [schedule('Quarterly team meeting', '2026-11-27T08:00:00.000', '2026-11-27T09:30:00.000')],
      holidays: HOLIDAYS.map(([date, name]) => schedule(name, `${date}T00:00:00.000`, `${nextDate(date)}T00:00:00.000`)),
    };
  }

  async request<T>(method: Method, path: string, options: RequestOptions = {}): Promise<T> {
    assertReadOnly(method, path);
    const q = options.query ?? {};
    const body = (options.body ?? {}) as Record<string, unknown>;
    let m: RegExpExecArray | null;

    if (method === 'GET' && path === '/api/v2/routing/queues') return this.listQueues(q) as T;
    if (method === 'GET' && (m = /^\/api\/v2\/routing\/queues\/([^/]+)$/.exec(path))) return this.queueEntity(this.queue(m[1]!)) as T;
    if (method === 'GET' && (m = /^\/api\/v2\/routing\/queues\/([^/]+)\/members$/.exec(path))) return this.queueMembers(m[1]!, q) as T;
    if (method === 'GET' && (m = /^\/api\/v2\/routing\/queues\/([^/]+)\/wrapupcodes$/.exec(path))) {
      const queue = this.queue(m[1]!);
      return page(this.wrapups.filter((w) => queue.wrapups.includes(w.name)), q) as T;
    }
    if (method === 'GET' && path === '/api/v2/users') return this.listUsers(q) as T;
    if (method === 'GET' && (m = /^\/api\/v2\/users\/([^/]+)\/queues$/.exec(path))) {
      const agent = this.agent(m[1]!);
      return page(this.queues.filter((x) => agent.queueIds.includes(x.id)).map((x) => ({ id: x.id, name: x.name, joined: true })), q) as T;
    }
    if (method === 'GET' && (m = /^\/api\/v2\/users\/([^/]+)$/.exec(path))) return this.userEntity(this.agent(m[1]!), String(q.expand ?? '')) as T;
    if (method === 'GET' && path === '/api/v2/routing/wrapupcodes') return page(this.wrapups, q) as T;
    if (method === 'GET' && path === '/api/v2/routing/skills') return page(this.skills, q) as T;
    if (method === 'GET' && path === '/api/v2/flows') {
      const types = typeof q.type === 'string' ? q.type.split(',') : undefined;
      return page(this.flows.filter((f) => !types || types.includes(f.type)).map((f) => ({ id: f.id, name: f.name, type: f.type, description: f.description, publishedVersion: { id: '12' } })), q) as T;
    }
    if (method === 'GET' && path === '/api/v2/architect/schedulegroups') {
      const g = this.scheduleGroup;
      const ref = (list: DemoSchedule[]) => list.map((x) => ({ id: x.id, name: x.name }));
      return page([{ id: g.id, name: g.name, timeZone: g.timeZone, openSchedules: ref(g.open), closedSchedules: ref(g.closed), holidaySchedules: ref(g.holidays) }], q) as T;
    }
    if (method === 'GET' && path === '/api/v2/architect/schedules') {
      const g = this.scheduleGroup;
      return page([...g.open, ...g.closed, ...g.holidays], q) as T;
    }
    if (path === '/api/v2/analytics/users/aggregates/query') return this.userAggregates(body) as T;
    if (path === '/api/v2/analytics/users/details/query') return this.userDetails(body) as T;
    if (path === '/api/v2/analytics/flows/aggregates/query') return this.flowAggregates(body) as T;
    if (method === 'GET' && (m = /^\/api\/v2\/analytics\/conversations\/([^/]+)\/details$/.exec(path))) return this.conversation(m[1]!) as T;
    if (path === '/api/v2/analytics/queues/observations/query') return this.observations(body) as T;
    if (path === '/api/v2/analytics/conversations/aggregates/query') return this.aggregates(body) as T;
    if (path === '/api/v2/analytics/conversations/details/query') return this.details(body) as T;
    throw new PlatformError(`The demo org does not implement ${method} ${path}.`, 404);
  }

  // ---- directory -------------------------------------------------------------------------

  private listQueues(q: RequestOptions['query'] & object) {
    const pattern = typeof q.name === 'string' ? wildcard(q.name) : undefined;
    return page(
      this.queues.filter((x) => !pattern || pattern.test(x.name)).map((x) => this.queueEntity(x)),
      q,
    );
  }

  private wrapupId(name: string): string {
    return this.wrapups.find((w) => w.name === name)!.id;
  }

  private queue(id: string): DemoQueue {
    const queue = this.queues.find((x) => x.id === id);
    if (!queue) throw new PlatformError(`Queue ${id} not found.`, 404);
    return queue;
  }

  private agent(id: string): DemoAgent {
    const agent = this.agents.find((a) => a.id === id);
    if (!agent) throw new PlatformError(`User ${id} not found.`, 404);
    return agent;
  }

  private queueEntity(x: DemoQueue) {
    const members = this.agents.filter((a) => a.queueIds.includes(x.id));
    const media = x.mediaType === 'voice' ? 'call' : x.mediaType;
    return {
      id: x.id,
      name: x.name,
      description: x.description,
      memberCount: members.length,
      joinedMemberCount: members.length,
      mediaSettings: { [media]: { alertingTimeoutSeconds: x.mediaType === 'voice' ? 8 : 30, serviceLevel: { percentage: 0.8, durationMs: SL_TARGET_MS } } },
      acwSettings: { wrapupPrompt: 'MANDATORY_TIMEOUT', timeoutMs: 60_000 },
      skillEvaluationMethod: 'BEST',
      callingPartyName: x.mediaType === 'voice' ? 'Demo Contact Center' : undefined,
      dateModified: '2026-09-14T15:20:00.000Z',
    };
  }

  private queueMembers(queueId: string, q: RequestOptions['query'] & object) {
    if (!this.queues.some((x) => x.id === queueId)) throw new PlatformError(`Queue ${queueId} not found.`, 404);
    const members = this.agents
      .filter((a) => a.queueIds.includes(queueId))
      .map((a) => {
        const s = this.agentState(a);
        return { id: a.id, name: a.name, joined: true, routingStatus: { status: s.routing }, user: this.userEntity(a, String(q.expand ?? 'presence,routingStatus')) };
      });
    return page(members, q);
  }

  private listUsers(q: RequestOptions['query'] & object) {
    return page(
      this.agents.map((a) => this.userEntity(a)),
      q,
    );
  }

  private userEntity(a: DemoAgent, expand = 'presence,routingStatus') {
    const s = this.agentState(a);
    const want = new Set(expand.split(','));
    const skills = this.agentSkills(a);
    return {
      id: a.id,
      name: a.name,
      email: a.email,
      department: a.department,
      title: 'Contact Center Agent',
      state: 'active',
      presence: { presenceDefinition: { systemPresence: s.presence } },
      routingStatus: { status: s.routing },
      ...(want.has('skills') ? { skills: skills.map((k) => ({ id: this.skills.find((x) => x.name === k.name)!.id, name: k.name, proficiency: k.proficiency, state: 'active' })) } : {}),
      ...(want.has('languages') ? { languages: this.agentLanguages(a) } : {}),
    };
  }

  /** Skills follow the queues an agent works, with a fixed proficiency per agent and skill. */
  private agentSkills(a: DemoAgent): { name: string; proficiency: number }[] {
    const names = new Set(a.queueIds.flatMap((id) => QUEUE_SKILLS[this.queues.find((q) => q.id === id)!.name] ?? []));
    return [...names].sort().map((name) => ({ name, proficiency: 2 + (hash(`${a.id}:${name}`) % 4) }));
  }

  private agentLanguages(a: DemoAgent): { name: string; proficiency: number }[] {
    const spanish = a.queueIds.some((id) => this.queues.find((q) => q.id === id)!.name === 'Spanish Support');
    return [{ name: 'English', proficiency: 5 }, ...(spanish ? [{ name: 'Spanish', proficiency: 5 }] : [])];
  }

  /** Presence and routing status at the current time. */
  private agentState(a: DemoAgent): { presence: string; routing: string } {
    const now = this.now().getTime();
    return stateAt(a, now, this.conversationsAround(now).filter((c) => c.agentId === a.id));
  }

  // ---- analytics -------------------------------------------------------------------------

  private observations(body: Record<string, unknown>) {
    const now = this.now().getTime();
    const ids = predicateValues(body.filter, 'queueId');
    const queues = this.queues.filter((x) => !ids.length || ids.includes(x.id));
    const metrics = (body.metrics as string[] | undefined) ?? ['oWaiting', 'oInteracting'];
    const detail = new Set((body.detailMetrics as string[] | undefined) ?? []);
    const active = this.conversationsAround(now);

    return {
      results: queues.map((queue) => {
        const waiting = active.filter((c) => c.queueId === queue.id && c.start <= now && now < (c.answeredAt ?? c.abandonedAt!));
        const interacting = active.filter((c) => c.queueId === queue.id && c.answeredAt !== undefined && c.answeredAt <= now && now < c.endAt);
        const members = this.agents.filter((a) => a.queueIds.includes(queue.id)).map((a) => this.agentState(a));
        const data: Record<string, unknown>[] = [];
        for (const metric of metrics) {
          if (metric === 'oWaiting' || metric === 'oInteracting') {
            const list = metric === 'oWaiting' ? waiting : interacting;
            const entry: Record<string, unknown> = { metric, stats: { count: list.length } };
            if (detail.has(metric)) {
              entry.observations = list.map((c) => ({
                observationDate: new Date(metric === 'oWaiting' ? c.start : c.answeredAt!).toISOString(),
                conversationId: c.id,
                sessionId: c.id,
                ani: `tel:${c.ani}`,
                ...(c.agentId && metric === 'oInteracting' ? { userId: c.agentId } : {}),
              }));
            }
            data.push(entry);
          } else if (metric === 'oOnQueueUsers') {
            for (const status of ['IDLE', 'INTERACTING', 'NOT_RESPONDING', 'COMMUNICATING']) {
              const count = members.filter((s) => s.presence === 'On Queue' && s.routing === status).length;
              if (count) data.push({ metric, qualifier: status, stats: { count } });
            }
          } else if (metric === 'oOffQueueUsers') {
            const count = members.filter((s) => s.presence !== 'On Queue' && s.presence !== 'Offline').length;
            data.push({ metric, stats: { count } });
          } else if (metric === 'oUserPresences') {
            for (const presence of ['On Queue', 'Available', 'Break', 'Meeting', 'Away', 'Busy', 'Offline']) {
              const count = members.filter((s) => s.presence === presence).length;
              if (count) data.push({ metric, qualifier: presence.toUpperCase().replace(' ', '_'), stats: { count } });
            }
          }
        }
        return { group: { queueId: queue.id, mediaType: queue.mediaType }, data };
      }),
    };
  }

  private aggregates(body: Record<string, unknown>) {
    const interval = parseInterval(body.interval);
    const groupBy = (body.groupBy as string[] | undefined) ?? [];
    const metrics = (body.metrics as string[] | undefined) ?? ['nOffered'];
    const granularity = body.granularity ? durationMs(String(body.granularity)) : undefined;
    const now = this.now().getTime();

    const convs = this.conversationsBetween(interval.start, Math.min(interval.end, now)).filter((c) => matches(body.filter, this.dimensions(c)));
    const groups = new Map<string, { group: Record<string, string>; convs: DemoConversation[] }>();
    for (const c of convs) {
      const dims = this.dimensions(c);
      if (groupBy.includes('userId') && !c.agentId) continue;
      const group = Object.fromEntries(groupBy.map((g) => [g, dims[g] ?? ''])) as Record<string, string>;
      const key = JSON.stringify(group);
      const entry = groups.get(key) ?? { group, convs: [] };
      entry.convs.push(c);
      groups.set(key, entry);
    }

    return {
      results: [...groups.values()].map(({ group, convs: list }) => {
        const buckets = new Map<number, DemoConversation[]>();
        for (const c of list) {
          const b = granularity ? interval.start + Math.floor((c.start - interval.start) / granularity) * granularity : interval.start;
          buckets.set(b, [...(buckets.get(b) ?? []), c]);
        }
        return {
          group,
          data: [...buckets.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([start, items]) => ({
              interval: `${new Date(start).toISOString()}/${new Date(granularity ? Math.min(start + granularity, interval.end) : interval.end).toISOString()}`,
              metrics: metrics.map((name) => computeMetric(name, items, now)).filter((x): x is NonNullable<typeof x> => !!x),
            })),
        };
      }),
    };
  }

  private details(body: Record<string, unknown>) {
    const interval = parseInterval(body.interval);
    const now = this.now().getTime();
    const paging = (body.paging as { pageSize?: number; pageNumber?: number } | undefined) ?? {};
    const pageSize = Math.min(paging.pageSize ?? 25, 100);
    const pageNumber = paging.pageNumber ?? 1;

    const segmentFilters = (body.segmentFilters as unknown[] | undefined) ?? [];
    const conversationFilters = (body.conversationFilters as unknown[] | undefined) ?? [];
    let list = this.conversationsBetween(interval.start, Math.min(interval.end, now))
      .filter((c) => segmentFilters.every((f) => matches(f, this.dimensions(c))))
      .filter((c) => conversationFilters.every((f) => matchesMetrics(f, c, now)));

    list = list.sort((a, b) => (body.order === 'asc' ? a.start - b.start : b.start - a.start));
    const items = list.slice((pageNumber - 1) * pageSize, pageNumber * pageSize);
    return { conversations: items.map((c) => this.toDetails(c, now)), totalHits: list.length };
  }

  /** Status changes of one agent, cut to the interval and to the current time. */
  private agentTimeline(a: DemoAgent, start: number, end: number) {
    const convs = this.conversationsBetween(start - 6 * 3_600_000, end).filter((c) => c.agentId === a.id);
    const cuts = new Set<number>([start, end]);
    for (let t = Math.ceil(start / 900_000) * 900_000; t < end; t += 900_000) cuts.add(t);
    for (const c of convs) for (const t of [c.answeredAt!, c.endAt]) if (t > start && t < end) cuts.add(t);
    const points = [...cuts].sort((x, y) => x - y);
    const pieces: { start: number; end: number; presence: string; routing: string }[] = [];
    for (let i = 0; i < points.length - 1; i++) {
      const s = stateAt(a, points[i]!, convs);
      const last = pieces.at(-1);
      if (last && last.presence === s.presence && last.routing === s.routing) last.end = points[i + 1]!;
      else pieces.push({ start: points[i]!, end: points[i + 1]!, ...s });
    }
    return pieces;
  }

  private userAggregates(body: Record<string, unknown>) {
    const interval = parseInterval(body.interval);
    const end = Math.min(interval.end, this.now().getTime());
    const ids = predicateValues(body.filter, 'userId');
    const agents = this.agents.filter((a) => !ids.length || ids.includes(a.id));
    const metrics = (body.metrics as string[] | undefined) ?? ['tAgentRoutingStatus', 'tSystemPresence'];
    return {
      results: agents.map((a) => {
        const presence = new Map<string, number>();
        const routing = new Map<string, number>();
        for (const p of end > interval.start ? this.agentTimeline(a, interval.start, end) : []) {
          if (p.presence === 'Offline') continue;
          const ms = p.end - p.start;
          const key = p.presence.toUpperCase().replace(' ', '_');
          presence.set(key, (presence.get(key) ?? 0) + ms);
          routing.set(p.routing, (routing.get(p.routing) ?? 0) + ms);
        }
        const data: Record<string, unknown>[] = [];
        if (metrics.includes('tSystemPresence')) for (const [qualifier, sum] of presence) data.push({ metric: 'tSystemPresence', qualifier, stats: { sum } });
        if (metrics.includes('tAgentRoutingStatus')) for (const [qualifier, sum] of routing) data.push({ metric: 'tAgentRoutingStatus', qualifier, stats: { sum } });
        return { group: { userId: a.id }, data: [{ interval: `${new Date(interval.start).toISOString()}/${new Date(interval.end).toISOString()}`, metrics: data }] };
      }),
    };
  }

  private userDetails(body: Record<string, unknown>) {
    const interval = parseInterval(body.interval);
    const end = Math.min(interval.end, this.now().getTime());
    const ids = ((body.userFilters as unknown[] | undefined) ?? []).flatMap((f) => predicateValues(f, 'userId'));
    const agents = this.agents.filter((a) => !ids.length || ids.includes(a.id));
    const iso = (t: number) => new Date(t).toISOString();
    return {
      userDetails: agents.map((a) => {
        const pieces = end > interval.start ? this.agentTimeline(a, interval.start, end) : [];
        const merge = (key: 'presence' | 'routing') => {
          const out: { start: number; end: number; value: string }[] = [];
          for (const p of pieces) {
            const last = out.at(-1);
            if (last && last.value === p[key]) last.end = p.end;
            else out.push({ start: p.start, end: p.end, value: p[key] });
          }
          return out;
        };
        return {
          userId: a.id,
          primaryPresence: merge('presence').map((p) => ({ startTime: iso(p.start), endTime: iso(p.end), systemPresence: p.value.toUpperCase().replace(' ', '_') })),
          routingStatus: merge('routing').map((p) => ({ startTime: iso(p.start), endTime: iso(p.end), routingStatus: p.value })),
        };
      }),
    };
  }

  private flowAggregates(body: Record<string, unknown>) {
    const interval = parseInterval(body.interval);
    const now = this.now().getTime();
    const groupBy = (body.groupBy as string[] | undefined) ?? [];
    const metrics = (body.metrics as string[] | undefined) ?? ['nFlow'];
    const granularity = body.granularity ? durationMs(String(body.granularity)) : undefined;
    const sessions = this.flowSessionsBetween(interval.start, Math.min(interval.end, now)).filter((x) => {
      const flow = this.flows.find((f) => f.id === x.flowId)!;
      return matches(body.filter, { flowId: flow.id, flowType: flow.type, mediaType: flow.type === 'inboundchat' ? 'chat' : 'voice' });
    });
    const groups = new Map<string, { group: Record<string, string>; items: DemoFlowSession[] }>();
    for (const x of sessions) {
      const flow = this.flows.find((f) => f.id === x.flowId)!;
      const dims: Record<string, string> = { flowId: flow.id, flowType: flow.type };
      const group = Object.fromEntries(groupBy.map((g) => [g, dims[g] ?? '']));
      const key = JSON.stringify(group);
      const entry = groups.get(key) ?? { group, items: [] };
      entry.items.push(x);
      groups.set(key, entry);
    }
    const stats = (list: DemoFlowSession[]) => (list.length ? { count: list.length, sum: list.reduce((n, x) => n + x.ms, 0), max: Math.max(...list.map((x) => x.ms)) } : undefined);
    const metric = (name: string, items: DemoFlowSession[]) => {
      const s =
        name === 'nFlow'
          ? items.length && { count: items.length }
          : name === 'tFlow'
            ? stats(items)
            : name === 'tFlowExit'
              ? stats(items.filter((x) => x.outcome === 'queue'))
              : name === 'tFlowDisconnect'
                ? stats(items.filter((x) => x.outcome !== 'queue'))
                : name === 'nFlowOutcome'
                  ? items.some((x) => x.outcome === 'self-service') && { count: items.filter((x) => x.outcome === 'self-service').length }
                  : name === 'nFlowOutcomeFailed'
                    ? items.some((x) => x.failedOutcome) && { count: items.filter((x) => x.failedOutcome).length }
                    : undefined;
      return s ? { metric: name, stats: s } : undefined;
    };
    return {
      results: [...groups.values()].map(({ group, items }) => {
        const buckets = new Map<number, DemoFlowSession[]>();
        for (const x of items) {
          const b = granularity ? interval.start + Math.floor((x.start - interval.start) / granularity) * granularity : interval.start;
          buckets.set(b, [...(buckets.get(b) ?? []), x]);
        }
        return {
          group,
          data: [...buckets.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([start, list]) => ({
              interval: `${new Date(start).toISOString()}/${new Date(granularity ? Math.min(start + granularity, interval.end) : interval.end).toISOString()}`,
              metrics: metrics.map((name) => metric(name, list)).filter((x): x is NonNullable<typeof x> => !!x),
            })),
        };
      }),
    };
  }

  private flowSessionsBetween(start: number, end: number): DemoFlowSession[] {
    const out: DemoFlowSession[] = [];
    const nowDay = Math.floor(this.now().getTime() / DAY);
    for (let day = Math.floor(start / DAY); day <= Math.floor((end - 1) / DAY); day++) {
      if (day < nowDay - HISTORY_DAYS || day > nowDay) continue;
      for (const x of this.flowDay(day)) if (x.start >= start && x.start < end) out.push(x);
    }
    return out;
  }

  /**
   * IVR and chat bot sessions for one day. Every inbound conversation that reached a queue went
   * through its entry flow first; on top of that some callers finish in self-service, some hang up
   * in the menus, and outside opening hours callers hear the closed message.
   */
  private flowDay(day: number): DemoFlowSession[] {
    const cached = this.flowDays.get(day);
    if (cached) return cached;
    const rng = random(hash(`flows:${day}`));
    const convs = this.day(day);
    const out: DemoFlowSession[] = [];
    for (const flow of this.flows) {
      for (const c of convs) {
        if (c.direction !== 'inbound' || !flow.queueIds.includes(c.queueId)) continue;
        const ms = Math.round(flow.menuSec * 1000 * (0.6 + rng() * 0.8));
        out.push({ flowId: flow.id, start: c.start - ms, ms, outcome: 'queue', failedOutcome: rng() < flow.authFailure });
      }
      for (let h = 0; h < 24; h++) {
        const hourStart = day * DAY + h * 3_600_000;
        const local = (h + DEMO_UTC_OFFSET + 24) % 24;
        const peak = flow.queueIds.reduce((n, id) => n + this.queues.find((q) => q.id === id)!.peakPerHour, 0);
        if (isOpen(hourStart)) {
          const queued = convs.filter((c) => c.direction === 'inbound' && flow.queueIds.includes(c.queueId) && c.start >= hourStart && c.start < hourStart + 3_600_000).length;
          for (let i = poisson(queued * flow.selfService, rng); i > 0; i--) {
            out.push({ flowId: flow.id, start: hourStart + Math.floor(rng() * 3_600_000), ms: Math.round((90 + rng() * 150) * 1000), outcome: 'self-service', failedOutcome: false });
          }
          for (let i = poisson(queued * 0.05 + 0.2, rng); i > 0; i--) {
            out.push({ flowId: flow.id, start: hourStart + Math.floor(rng() * 3_600_000), ms: Math.round((8 + rng() * 50) * 1000), outcome: 'hung-up', failedOutcome: rng() < 0.3 });
          }
        } else {
          const rate = peak * 0.05 * (local >= 6 && local < 23 ? 1 : 0.2);
          for (let i = poisson(rate, rng); i > 0; i--) {
            out.push({ flowId: flow.id, start: hourStart + Math.floor(rng() * 3_600_000), ms: Math.round((15 + rng() * 10) * 1000), outcome: 'closed', failedOutcome: false });
          }
        }
      }
    }
    out.sort((a, b) => a.start - b.start);
    this.flowDays.set(day, out);
    return out;
  }

  private conversation(id: string) {
    const c = this.byId.get(id);
    if (!c) throw new PlatformError(`Conversation ${id} not found.`, 404);
    return this.toDetails(c, this.now().getTime());
  }

  private dimensions(c: DemoConversation): Record<string, string | undefined> {
    return {
      queueId: c.queueId,
      userId: c.agentId,
      mediaType: c.mediaType,
      direction: c.direction,
      originatingDirection: c.direction,
      wrapUpCode: c.wrapupId,
      conversationId: c.id,
    };
  }

  /** Conversation in the analytics details format. */
  private toDetails(c: DemoConversation, now: number) {
    const iso = (t: number) => new Date(t).toISOString();
    const queue = this.queues.find((q) => q.id === c.queueId)!;
    const agent = c.agentId ? this.agents.find((a) => a.id === c.agentId) : undefined;
    const ended = c.endAt <= now;
    const leftQueue = c.answeredAt ?? c.abandonedAt ?? c.start;
    const dnis = queue.mediaType === 'voice' ? `tel:${queue.number}` : queue.address;
    const ani = queue.mediaType === 'voice' ? `tel:${c.ani}` : c.email;
    const customerEnd = ended ? c.endAt : undefined;

    const participants: Record<string, unknown>[] = [
      {
        participantId: `${c.id}-c`,
        participantName: c.customerName,
        purpose: c.direction === 'outbound' ? 'external' : 'customer',
        sessions: [
          {
            mediaType: c.mediaType,
            direction: c.direction,
            ani,
            dnis,
            segments: [{ segmentStart: iso(c.start), ...(customerEnd ? { segmentEnd: iso(customerEnd) } : {}), segmentType: 'interact', ...(c.abandonedAt !== undefined ? { disconnectType: 'client' } : ended ? { disconnectType: c.disconnectedBy === 'customer' ? 'client' : 'peer' } : {}) }],
          },
        ],
      },
    ];

    if (c.direction === 'inbound') {
      participants.push({
        participantId: `${c.id}-q`,
        participantName: queue.name,
        purpose: 'acd',
        sessions: [
          {
            mediaType: c.mediaType,
            direction: 'inbound',
            segments: [{ segmentStart: iso(c.start), ...(leftQueue <= now ? { segmentEnd: iso(Math.min(leftQueue, now)) } : {}), segmentType: 'interact', queueId: queue.id, ...(c.abandonedAt !== undefined ? { disconnectType: 'peer' } : {}) }],
            metrics: [
              ...(c.abandonedAt !== undefined && c.abandonedAt <= now ? [{ name: 'tAbandon', value: c.abandonedAt - c.start }] : []),
              ...(c.answeredAt !== undefined && c.answeredAt <= now ? [{ name: 'tAcd', value: c.answeredAt - c.start }] : []),
            ],
          },
        ],
      });
    }

    if (agent && c.answeredAt !== undefined && c.answeredAt <= now) {
      const segments: Record<string, unknown>[] = [];
      let t = c.answeredAt;
      const talkEnd = c.answeredAt + c.talkMs + c.holdMs;
      if (c.holdMs > 0) {
        const holdStart = c.answeredAt + Math.round(c.talkMs * 0.6);
        segments.push({ segmentStart: iso(t), segmentEnd: iso(Math.min(holdStart, now)), segmentType: 'interact', queueId: queue.id });
        if (holdStart < now) segments.push({ segmentStart: iso(holdStart), segmentEnd: iso(Math.min(holdStart + c.holdMs, now)), segmentType: 'hold', queueId: queue.id });
        t = holdStart + c.holdMs;
      }
      if (t < now) segments.push({ segmentStart: iso(t), segmentEnd: iso(Math.min(talkEnd, now)), segmentType: 'interact', queueId: queue.id });
      if (talkEnd < now) segments.push({ segmentStart: iso(talkEnd), segmentEnd: iso(Math.min(c.endAt, now)), segmentType: 'wrapup', queueId: queue.id, ...(ended ? { wrapUpCode: c.wrapupId } : {}) });
      participants.push({
        participantId: `${c.id}-a`,
        participantName: agent.name,
        purpose: 'agent',
        userId: agent.id,
        sessions: [
          {
            mediaType: c.mediaType,
            direction: c.direction,
            segments,
            metrics: ended
              ? [
                  { name: 'tAnswered', value: c.answeredAt - c.start },
                  { name: 'tTalk', value: c.talkMs },
                  ...(c.holdMs ? [{ name: 'tHeld', value: c.holdMs }] : []),
                  { name: 'tAcw', value: c.acwMs },
                  { name: 'tHandle', value: c.talkMs + c.holdMs + c.acwMs },
                  ...(c.transferred ? [{ name: 'nTransferred', value: 1 }] : []),
                ]
              : [],
          },
        ],
      });
    }

    return {
      conversationId: c.id,
      conversationStart: iso(c.start),
      ...(ended ? { conversationEnd: iso(c.endAt) } : {}),
      originatingDirection: c.direction,
      divisionIds: ['demo-division'],
      participants,
    };
  }

  // ---- generation ------------------------------------------------------------------------

  private conversationsAround(now: number): DemoConversation[] {
    return this.conversationsBetween(now - 6 * 3_600_000, now);
  }

  private conversationsBetween(start: number, end: number): DemoConversation[] {
    const out: DemoConversation[] = [];
    const nowDay = Math.floor(this.now().getTime() / DAY);
    for (let day = Math.floor(start / DAY); day <= Math.floor((end - 1) / DAY); day++) {
      if (day < nowDay - HISTORY_DAYS || day > nowDay) continue;
      for (const c of this.day(day)) if (c.start >= start && c.start < end) out.push(c);
    }
    return out;
  }

  private day(day: number): DemoConversation[] {
    const cached = this.days.get(day);
    if (cached) return cached;

    const rng = random(hash(`day:${day}`));
    const dayStart = day * DAY;
    const weekday = new Date(dayStart + 12 * 3_600_000).getUTCDay();
    const weekend = weekday === 0 || weekday === 6;
    const arrivals: { queue: DemoQueue; start: number; outbound: boolean }[] = [];

    for (const queue of this.queues) {
      for (let h = 0; h < 24; h++) {
        const local = (h + DEMO_UTC_OFFSET + 24) % 24;
        // Outside opening hours the IVR plays a closed message and calls never reach a queue.
        if (!isOpen(dayStart + h * 3_600_000)) continue;
        const rate = queue.peakPerHour * curve(local) * (weekend ? queue.weekendFactor : 1);
        const count = poisson(rate, rng);
        for (let i = 0; i < count; i++) {
          arrivals.push({ queue, start: dayStart + h * 3_600_000 + Math.floor(rng() * 3_600_000), outbound: rng() < queue.outboundShare });
        }
      }
    }
    arrivals.sort((a, b) => a.start - b.start);

    const busyUntil = new Map<string, number>();
    const result: DemoConversation[] = [];
    for (const { queue, start, outbound } of arrivals) {
      const patience = expo(queue.patienceSec * 1000, rng);
      const members = this.agents.filter((a) => a.queueIds.includes(queue.id));
      let pick: DemoAgent | undefined;
      let answeredAt = Infinity;
      for (const a of members) {
        const free = Math.max(busyUntil.get(a.id) ?? 0, start);
        if (!onShift(a, free)) continue;
        // Lunch, and a 15-minute break or meeting now and then, delay the next answer.
        let pause = free;
        for (let i = 0; i < 8 && offQueueAt(a, pause); i++) pause = (Math.floor(pause / 900_000) + 1) * 900_000;
        const t = onShift(a, pause) && !offQueueAt(a, pause) ? pause : Infinity;
        if (t < answeredAt) {
          answeredAt = t;
          pick = a;
        }
      }
      const wait = outbound ? 0 : answeredAt - start;
      const id = uuid(rng);
      const customer = customerName(rng);
      const base = {
        id,
        queueId: queue.id,
        mediaType: queue.mediaType,
        direction: (outbound ? 'outbound' : 'inbound') as 'inbound' | 'outbound',
        start,
        ani: phone(rng),
        email: `${customer.toLowerCase().replace(/[^a-z]+/g, '.')}@example.net`,
        customerName: customer,
      };

      if (!pick || (!outbound && wait > patience)) {
        const abandonedAt = start + Math.round(Math.min(patience, 20 * 60_000));
        result.push({ ...base, abandonedAt, talkMs: 0, holdMs: 0, acwMs: 0, endAt: abandonedAt, disconnectedBy: 'customer', transferred: false });
        continue;
      }

      const talkMs = Math.round(queue.ahtSec * 1000 * (0.45 + rng() * 1.1));
      const holdMs = rng() < 0.28 ? Math.round(10_000 + rng() * 110_000) : 0;
      const acwMs = Math.round(8_000 + rng() * 55_000);
      const at = start + wait;
      const endAt = at + talkMs + holdMs + acwMs;
      busyUntil.set(pick.id, endAt);
      result.push({
        ...base,
        answeredAt: at,
        agentId: pick.id,
        talkMs,
        holdMs,
        acwMs,
        endAt,
        wrapupId: this.wrapupId(queue.wrapups[Math.floor(rng() ** 1.6 * queue.wrapups.length)]!),
        disconnectedBy: rng() < 0.6 ? 'customer' : 'agent',
        transferred: rng() < 0.05,
      });
    }

    for (const c of result) this.byId.set(c.id, c);
    this.days.set(day, result);
    return result;
  }
}

// ---- data --------------------------------------------------------------------------------

interface DemoQueue {
  id: string;
  name: string;
  description: string;
  mediaType: 'voice' | 'chat' | 'email';
  number?: string;
  address?: string;
  peakPerHour: number;
  ahtSec: number;
  patienceSec: number;
  outboundShare: number;
  weekendFactor: number;
  wrapups: string[];
}

interface DemoFlow {
  id: string;
  name: string;
  type: 'inboundcall' | 'inboundchat';
  description: string;
  queues: string[];
  queueIds: string[];
  /** Average seconds in the menus before reaching a queue. */
  menuSec: number;
  /** Callers who finish in self-service, as a share of those who reach a queue. */
  selfService: number;
  /** Share of callers who fail identification before going to a queue. */
  authFailure: number;
}

interface DemoFlowSession {
  flowId: string;
  start: number;
  ms: number;
  outcome: 'queue' | 'self-service' | 'hung-up' | 'closed';
  failedOutcome: boolean;
}

interface DemoSchedule {
  id: string;
  name: string;
  start: string;
  end: string;
  rrule?: string;
}

interface DemoAgent {
  id: string;
  name: string;
  email: string;
  department: string;
  queueIds: string[];
  /** Shift start, local hour. Shifts last nine hours. */
  shiftStart: number;
}

interface DemoConversation {
  id: string;
  queueId: string;
  mediaType: string;
  direction: 'inbound' | 'outbound';
  start: number;
  answeredAt?: number;
  abandonedAt?: number;
  agentId?: string;
  talkMs: number;
  holdMs: number;
  acwMs: number;
  endAt: number;
  wrapupId?: string;
  ani: string;
  email: string;
  customerName: string;
  disconnectedBy: 'customer' | 'agent';
  transferred: boolean;
}

const DAY = 86_400_000;
const HISTORY_DAYS = 35;
const SL_TARGET_MS = 20_000;
/** The demo center runs on UTC-5. */
const DEMO_UTC_OFFSET = -5;

const QUEUES: Omit<DemoQueue, 'id'>[] = [
  { name: 'Support', description: 'General product support', mediaType: 'voice', number: '+18005550100', peakPerHour: 46, ahtSec: 330, patienceSec: 150, outboundShare: 0, weekendFactor: 0.45, wrapups: ['Resolved', 'Information provided', 'Follow-up needed', 'Escalated', 'Wrong department'] },
  { name: 'Billing', description: 'Invoices, payments and refunds', mediaType: 'voice', number: '+18005550101', peakPerHour: 24, ahtSec: 270, patienceSec: 120, outboundShare: 0, weekendFactor: 0.3, wrapups: ['Payment taken', 'Resolved', 'Information provided', 'Refund issued', 'Follow-up needed', 'Wrong department'] },
  { name: 'Sales', description: 'New customers and upgrades', mediaType: 'voice', number: '+18005550102', peakPerHour: 16, ahtSec: 420, patienceSec: 160, outboundShare: 0.2, weekendFactor: 0.5, wrapups: ['Information provided', 'Sale completed', 'Follow-up needed', 'Wrong department'] },
  { name: 'Retention', description: 'Cancellation requests', mediaType: 'voice', number: '+18005550103', peakPerHour: 8, ahtSec: 540, patienceSec: 260, outboundShare: 0.1, weekendFactor: 0.4, wrapups: ['Cancellation saved', 'Cancelled', 'Follow-up needed', 'Information provided'] },
  { name: 'Spanish Support', description: 'Support in Spanish', mediaType: 'voice', number: '+18005550104', peakPerHour: 15, ahtSec: 360, patienceSec: 160, outboundShare: 0, weekendFactor: 0.5, wrapups: ['Resolved', 'Information provided', 'Follow-up needed', 'Escalated', 'Wrong department'] },
  { name: 'Chat Support', description: 'Web chat support', mediaType: 'chat', address: 'web-chat', peakPerHour: 22, ahtSec: 560, patienceSec: 240, outboundShare: 0, weekendFactor: 0.6, wrapups: ['Resolved', 'Information provided', 'Escalated', 'Follow-up needed'] },
];

const AGENTS: [string, string[], number][] = [
  ['Ana Torres', ['Support'], 8],
  ['Ben Carter', ['Support'], 8],
  ['Chloe Martin', ['Support', 'Chat Support'], 9],
  ['Daniel Ruiz', ['Spanish Support', 'Support'], 11],
  ['Emma Wilson', ['Support'], 9],
  ['Felipe Rojas', ['Spanish Support'], 8],
  ['Grace Lee', ['Support', 'Billing'], 10],
  ['Hugo Moreno', ['Support'], 11],
  ['Isabel Gómez', ['Billing'], 8],
  ['Jack Turner', ['Billing', 'Support'], 9],
  ['Karen Diaz', ['Billing'], 11],
  ['Liam Brooks', ['Sales'], 8],
  ['Maria Silva', ['Sales', 'Retention'], 9],
  ['Noah Price', ['Sales'], 11],
  ['Olivia Reed', ['Sales', 'Support'], 10],
  ['Pablo Vega', ['Retention'], 8],
  ['Quinn Foster', ['Retention', 'Billing'], 11],
  ['Rosa Herrera', ['Spanish Support', 'Chat Support'], 9],
  ['Sam Patel', ['Chat Support'], 8],
  ['Tara Nguyen', ['Chat Support'], 11],
  ['Victor Castro', ['Chat Support', 'Support'], 10],
  ['Wendy Clark', ['Support'], 10],
  ['Xavier Mendez', ['Spanish Support'], 10],
  ['Yara Haddad', ['Chat Support'], 9],
  ['Zoe Adams', ['Support', 'Retention'], 8],
];

const SKILLS = ['Billing', 'Chat', 'Retention', 'Sales', 'Spanish', 'Technical'];
const QUEUE_SKILLS: Record<string, string[]> = {
  Support: ['Technical'],
  Billing: ['Billing'],
  Sales: ['Sales'],
  Retention: ['Retention', 'Sales'],
  'Spanish Support': ['Spanish', 'Technical'],
  'Chat Support': ['Chat', 'Technical'],
};

const FLOWS: Omit<DemoFlow, 'id' | 'queueIds'>[] = [
  { name: 'Main IVR', type: 'inboundcall', description: 'Main number: identification, self-service balance and payments, menu to queues', queues: ['Support', 'Billing', 'Sales', 'Retention'], menuSec: 55, selfService: 0.18, authFailure: 0.12 },
  { name: 'Spanish IVR', type: 'inboundcall', description: 'Spanish line', queues: ['Spanish Support'], menuSec: 40, selfService: 0.08, authFailure: 0.1 },
  { name: 'Web Chat Bot', type: 'inboundchat', description: 'Answers common questions before handing over to an agent', queues: ['Chat Support'], menuSec: 70, selfService: 0.3, authFailure: 0 },
];

/** Days the center is closed, local dates. */
const HOLIDAYS: [string, string][] = [
  ['2026-11-02', "All Saints' Day"],
  ['2026-11-16', 'Independence of Cartagena'],
  ['2026-12-08', 'Immaculate Conception'],
  ['2026-12-25', 'Christmas Day'],
  ['2027-01-01', "New Year's Day"],
];

const WRAPUPS = ['Resolved', 'Information provided', 'Follow-up needed', 'Escalated', 'Payment taken', 'Refund issued', 'Sale completed', 'Cancellation saved', 'Cancelled', 'Wrong department'];

const FIRST = ['Alex', 'Maria', 'John', 'Laura', 'Carlos', 'Sophie', 'David', 'Lucia', 'Mark', 'Elena', 'Peter', 'Julia', 'Diego', 'Nina', 'Oscar', 'Paula'];
const LAST = ['Smith', 'Garcia', 'Brown', 'Lopez', 'Miller', 'Perez', 'Davis', 'Sanchez', 'Taylor', 'Ramirez', 'Moore', 'Flores'];

// ---- helpers -----------------------------------------------------------------------------

/** Opening hours: weekdays 08:00-20:00, weekends 09:00-17:00, closed on holidays and during the team meeting. */
function isOpen(t: number): boolean {
  const localMs = t + DEMO_UTC_OFFSET * 3_600_000;
  const date = new Date(localMs).toISOString().slice(0, 10);
  if (HOLIDAYS.some(([d]) => d === date)) return false;
  const local = (localMs / 3_600_000) % 24;
  if (date === '2026-11-27' && local >= 8 && local < 9.5) return false;
  const weekday = new Date(localMs).getUTCDay();
  return weekday === 0 || weekday === 6 ? local >= 9 && local < 17 : local >= 8 && local < 20;
}

function nextDate(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + DAY).toISOString().slice(0, 10);
}

/** Presence and routing status of an agent at time t, given the conversations they handled around it. */
function stateAt(a: DemoAgent, t: number, convs: DemoConversation[]): { presence: string; routing: string } {
  if (!onShift(a, t)) return { presence: 'Offline', routing: 'OFF_QUEUE' };
  if (convs.some((c) => c.agentId === a.id && c.answeredAt! <= t && t < c.endAt)) return { presence: 'On Queue', routing: 'INTERACTING' };
  const off = offQueueAt(a, t);
  return off ? { presence: off, routing: 'OFF_QUEUE' } : { presence: 'On Queue', routing: 'IDLE' };
}

/** The off-queue presence of an agent on shift at time t, if any. */
function offQueueAt(a: DemoAgent, t: number): string | undefined {
  const localMs = t + DEMO_UTC_OFFSET * 3_600_000;
  const local = (localMs / 3_600_000) % 24;
  const weekday = new Date(localMs).getUTCDay();
  // Half an hour for lunch, four hours into the shift.
  const meal = weekday === 0 || weekday === 6 ? 13 : a.shiftStart + 4;
  if (local >= meal && local < meal + 0.5) return 'Meal';
  // On shift while the center is closed only happens during the team meeting.
  if (!isOpen(t)) return 'Meeting';
  // Other activities change every 15 minutes, deterministically per agent.
  const r = random(hash(`${a.id}:${Math.floor(t / 900_000)}`))();
  if (r < 0.05) return 'Break';
  if (r < 0.08) return 'Meeting';
  if (r < 0.1) return 'Away';
  return undefined;
}

function onShift(a: DemoAgent, t: number): boolean {
  const local = ((t / 3_600_000 + DEMO_UTC_OFFSET) % 24 + 24) % 24;
  const localDate = new Date(t + DEMO_UTC_OFFSET * 3_600_000);
  if (HOLIDAYS.some(([d]) => d === localDate.toISOString().slice(0, 10))) return false;
  const weekday = localDate.getUTCDay();
  const weekend = weekday === 0 || weekday === 6;
  // Half the team works weekends.
  if (weekend) return hash(a.id) % 2 === 1 && local >= 9 && local < 17;
  return local >= a.shiftStart && local < a.shiftStart + 9;
}

/** Relative arrival rate by local hour, peaking mid-morning and mid-afternoon. */
function curve(hour: number): number {
  const morning = Math.exp(-((hour - 10.5) ** 2) / 4);
  const afternoon = 0.85 * Math.exp(-((hour - 15) ** 2) / 5);
  return Math.max(0.2, morning + afternoon);
}

function computeMetric(name: string, items: DemoConversation[], now: number) {
  const done = items.filter((c) => c.endAt <= now);
  const inbound = items.filter((c) => c.direction === 'inbound');
  const answered = inbound.filter((c) => c.answeredAt !== undefined && c.answeredAt <= now);
  const abandoned = inbound.filter((c) => c.abandonedAt !== undefined && c.abandonedAt <= now);
  const handled = done.filter((c) => c.agentId);
  const sum = (list: DemoConversation[], f: (c: DemoConversation) => number) => {
    const values = list.map(f);
    return values.length ? { count: values.length, sum: values.reduce((a, b) => a + b, 0), max: Math.max(...values), min: Math.min(...values) } : undefined;
  };
  let stats: Record<string, number> | undefined;
  switch (name) {
    case 'nOffered':
      stats = inbound.length ? { count: inbound.length } : undefined;
      break;
    case 'nOutbound':
      stats = items.some((c) => c.direction === 'outbound') ? { count: items.filter((c) => c.direction === 'outbound').length } : undefined;
      break;
    case 'tAnswered':
      stats = sum(answered, (c) => c.answeredAt! - c.start);
      break;
    case 'tAbandon':
      stats = sum(abandoned, (c) => c.abandonedAt! - c.start);
      break;
    case 'tWait':
      stats = sum([...answered, ...abandoned], (c) => (c.answeredAt ?? c.abandonedAt!) - c.start);
      break;
    case 'tTalk':
      stats = sum(handled, (c) => c.talkMs);
      break;
    case 'tHeld':
      stats = sum(handled.filter((c) => c.holdMs > 0), (c) => c.holdMs);
      break;
    case 'tAcw':
      stats = sum(handled, (c) => c.acwMs);
      break;
    case 'tHandle':
      stats = sum(handled, (c) => c.talkMs + c.holdMs + c.acwMs);
      break;
    case 'nTransferred':
      stats = handled.some((c) => c.transferred) ? { count: handled.filter((c) => c.transferred).length } : undefined;
      break;
    case 'oServiceLevel': {
      const denominator = answered.length + abandoned.filter((c) => c.abandonedAt! - c.start > SL_TARGET_MS).length;
      const numerator = answered.filter((c) => c.answeredAt! - c.start <= SL_TARGET_MS).length;
      stats = denominator ? { ratio: numerator / denominator, numerator, denominator, target: 0.8 } : undefined;
      break;
    }
    default:
      return undefined;
  }
  return stats ? { metric: name, stats } : undefined;
}

type Filter = { type?: string; predicates?: Predicate[]; clauses?: Filter[] };
type Predicate = { type?: string; dimension?: string; value?: string; metric?: string; operator?: string; range?: { gt?: number; gte?: number; lt?: number; lte?: number } };

function matches(filter: unknown, dims: Record<string, string | undefined>): boolean {
  if (!filter) return true;
  const f = filter as Filter;
  const checks = [
    ...(f.predicates ?? []).filter((p) => p.dimension).map((p) => (p.operator === 'notExists' ? !dims[p.dimension!] : p.operator === 'exists' ? !!dims[p.dimension!] : dims[p.dimension!] === p.value)),
    ...(f.clauses ?? []).map((c) => matches(c, dims)),
  ];
  if (!checks.length) return true;
  return f.type === 'or' ? checks.some(Boolean) : checks.every(Boolean);
}

function matchesMetrics(filter: unknown, c: DemoConversation, now: number): boolean {
  const f = filter as Filter;
  const values: Record<string, number | undefined> = {
    tAbandon: c.abandonedAt !== undefined && c.abandonedAt <= now ? c.abandonedAt - c.start : undefined,
    tAnswered: c.answeredAt !== undefined && c.answeredAt <= now ? c.answeredAt - c.start : undefined,
    tConversationDuration: c.endAt <= now ? c.endAt - c.start : undefined,
    tHandle: c.agentId && c.endAt <= now ? c.talkMs + c.holdMs + c.acwMs : undefined,
    tHeld: c.holdMs || undefined,
    tWait: (c.answeredAt ?? c.abandonedAt ?? now) - c.start,
  };
  const checks = (f.predicates ?? []).map((p) => {
    const v = values[p.metric ?? ''];
    if (p.operator === 'exists') return v !== undefined;
    if (p.operator === 'notExists') return v === undefined;
    if (p.range) {
      if (v === undefined) return false;
      const r = p.range;
      return (r.gt === undefined || v > r.gt) && (r.gte === undefined || v >= r.gte) && (r.lt === undefined || v < r.lt) && (r.lte === undefined || v <= r.lte);
    }
    return true;
  });
  const nested = (f.clauses ?? []).map((cl) => matchesMetrics(cl, c, now));
  const all = [...checks, ...nested];
  if (!all.length) return true;
  return f.type === 'or' ? all.some(Boolean) : all.every(Boolean);
}

function predicateValues(filter: unknown, dimension: string): string[] {
  const out: string[] = [];
  const walk = (f: Filter | undefined) => {
    if (!f) return;
    for (const p of f.predicates ?? []) if (p.dimension === dimension && p.value) out.push(p.value);
    for (const c of f.clauses ?? []) walk(c);
  };
  walk(filter as Filter);
  return out;
}

function parseInterval(value: unknown): { start: number; end: number } {
  const [a, b] = String(value ?? '').split('/');
  const start = Date.parse(a ?? '');
  const end = Date.parse(b ?? '');
  if (Number.isNaN(start) || Number.isNaN(end)) throw new PlatformError(`Invalid interval '${String(value)}'.`, 400);
  return { start, end };
}

function durationMs(iso: string): number {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/.exec(iso);
  if (!m) throw new PlatformError(`Unsupported granularity '${iso}'.`, 400);
  return ((Number(m[1] ?? 0) * 24 + Number(m[2] ?? 0)) * 60 + Number(m[3] ?? 0)) * 60_000;
}

function page<T>(items: T[], q: RequestOptions['query'] & object) {
  const pageSize = Number(q.pageSize ?? 25);
  const pageNumber = Number(q.pageNumber ?? 1);
  return {
    entities: items.slice((pageNumber - 1) * pageSize, pageNumber * pageSize),
    pageSize,
    pageNumber,
    total: items.length,
    pageCount: Math.max(1, Math.ceil(items.length / pageSize)),
  };
}

function wildcard(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

function uuid(rng: () => number): string {
  const hex = Array.from({ length: 32 }, () => Math.floor(rng() * 16).toString(16)).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${'89ab'[Math.floor(rng() * 4)]}${hex.slice(17, 20)}-${hex.slice(20)}`;
}

function poisson(lambda: number, rng: () => number): number {
  if (lambda <= 0) return 0;
  if (lambda > 30) return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * gaussian(rng)));
  const limit = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= rng();
  } while (p > limit);
  return k - 1;
}

function gaussian(rng: () => number): number {
  return Math.sqrt(-2 * Math.log(1 - rng())) * Math.cos(2 * Math.PI * rng());
}

function expo(mean: number, rng: () => number): number {
  return -Math.log(1 - rng()) * mean;
}

function phone(rng: () => number): string {
  return `+1${Math.floor(200 + rng() * 700)}${Math.floor(rng() * 1e7).toString().padStart(7, '0')}`;
}

function customerName(rng: () => number): string {
  return `${FIRST[Math.floor(rng() * FIRST.length)]} ${LAST[Math.floor(rng() * LAST.length)]}`;
}
