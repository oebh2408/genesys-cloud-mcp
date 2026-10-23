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
  }

  async request<T>(method: Method, path: string, options: RequestOptions = {}): Promise<T> {
    assertReadOnly(method, path);
    const q = options.query ?? {};
    const body = (options.body ?? {}) as Record<string, unknown>;
    let m: RegExpExecArray | null;

    if (method === 'GET' && path === '/api/v2/routing/queues') return this.listQueues(q) as T;
    if (method === 'GET' && (m = /^\/api\/v2\/routing\/queues\/([^/]+)\/members$/.exec(path))) return this.queueMembers(m[1]!, q) as T;
    if (method === 'GET' && path === '/api/v2/users') return this.listUsers(q) as T;
    if (method === 'GET' && (m = /^\/api\/v2\/users\/([^/]+)$/.exec(path))) {
      const agent = this.agents.find((a) => a.id === m![1]);
      if (!agent) throw new PlatformError(`User ${m[1]} not found.`, 404);
      return this.userEntity(agent) as T;
    }
    if (method === 'GET' && path === '/api/v2/routing/wrapupcodes') return page(this.wrapups, q) as T;
    if (method === 'GET' && (m = /^\/api\/v2\/analytics\/conversations\/([^/]+)\/details$/.exec(path))) return this.conversation(m[1]!) as T;
    if (path === '/api/v2/analytics/queues/observations/query') return this.observations(body) as T;
    if (path === '/api/v2/analytics/conversations/aggregates/query') return this.aggregates(body) as T;
    if (path === '/api/v2/analytics/conversations/details/query') return this.details(body) as T;
    throw new PlatformError(`The demo org does not implement ${method} ${path}.`, 404);
  }

  // ---- directory -------------------------------------------------------------------------

  private listQueues(q: RequestOptions['query'] & object) {
    const pattern = typeof q.name === 'string' ? wildcard(q.name) : undefined;
    const queues = this.queues
      .filter((x) => !pattern || pattern.test(x.name))
      .map((x) => {
        const members = this.agents.filter((a) => a.queueIds.includes(x.id));
        return {
          id: x.id,
          name: x.name,
          description: x.description,
          memberCount: members.length,
          joinedMemberCount: members.length,
          mediaSettings: { [x.mediaType === 'voice' ? 'call' : x.mediaType]: { serviceLevel: { percentage: 0.8, durationMs: SL_TARGET_MS } } },
        };
      });
    return page(queues, q);
  }

  private queueMembers(queueId: string, q: RequestOptions['query'] & object) {
    if (!this.queues.some((x) => x.id === queueId)) throw new PlatformError(`Queue ${queueId} not found.`, 404);
    const members = this.agents
      .filter((a) => a.queueIds.includes(queueId))
      .map((a) => {
        const s = this.agentState(a);
        return { id: a.id, name: a.name, joined: true, routingStatus: { status: s.routing }, user: this.userEntity(a) };
      });
    return page(members, q);
  }

  private listUsers(q: RequestOptions['query'] & object) {
    return page(
      this.agents.map((a) => this.userEntity(a)),
      q,
    );
  }

  private userEntity(a: DemoAgent) {
    const s = this.agentState(a);
    return {
      id: a.id,
      name: a.name,
      email: a.email,
      department: a.department,
      title: 'Contact Center Agent',
      state: 'active',
      presence: { presenceDefinition: { systemPresence: s.presence } },
      routingStatus: { status: s.routing },
    };
  }

  /** Presence and routing status at the current time. */
  private agentState(a: DemoAgent): { presence: string; routing: string } {
    const now = this.now().getTime();
    if (!onShift(a, now)) return { presence: 'Offline', routing: 'OFF_QUEUE' };
    const busy = this.conversationsAround(now).some((c) => c.agentId === a.id && c.answeredAt! <= now && now < c.endAt);
    if (busy) return { presence: 'On Queue', routing: 'INTERACTING' };
    // Off-queue activities change every 15 minutes, deterministically per agent.
    const slot = Math.floor(now / 900_000);
    const r = random(hash(`${a.id}:${slot}`))();
    if (r < 0.05) return { presence: 'Break', routing: 'OFF_QUEUE' };
    if (r < 0.08) return { presence: 'Meeting', routing: 'OFF_QUEUE' };
    if (r < 0.1) return { presence: 'Away', routing: 'OFF_QUEUE' };
    return { presence: 'On Queue', routing: 'IDLE' };
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
        const open = weekend ? local >= 9 && local < 17 : local >= 8 && local < 20;
        if (!open) continue;
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
        // Agents are pulled into a 15-minute break or meeting now and then.
        const slot = Math.floor(free / 900_000);
        const pause = random(hash(`${a.id}:${slot}`))() < 0.1 ? (slot + 1) * 900_000 : free;
        const t = onShift(a, pause) ? pause : Infinity;
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
        wrapupId: this.wrapups[Math.floor(rng() ** 1.6 * this.wrapups.length)]!.id,
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
  { name: 'Support', description: 'General product support', mediaType: 'voice', number: '+18005550100', peakPerHour: 46, ahtSec: 330, patienceSec: 150, outboundShare: 0, weekendFactor: 0.45 },
  { name: 'Billing', description: 'Invoices, payments and refunds', mediaType: 'voice', number: '+18005550101', peakPerHour: 24, ahtSec: 270, patienceSec: 120, outboundShare: 0, weekendFactor: 0.3 },
  { name: 'Sales', description: 'New customers and upgrades', mediaType: 'voice', number: '+18005550102', peakPerHour: 16, ahtSec: 420, patienceSec: 160, outboundShare: 0.2, weekendFactor: 0.5 },
  { name: 'Retention', description: 'Cancellation requests', mediaType: 'voice', number: '+18005550103', peakPerHour: 8, ahtSec: 540, patienceSec: 260, outboundShare: 0.1, weekendFactor: 0.4 },
  { name: 'Spanish Support', description: 'Support in Spanish', mediaType: 'voice', number: '+18005550104', peakPerHour: 15, ahtSec: 360, patienceSec: 160, outboundShare: 0, weekendFactor: 0.5 },
  { name: 'Chat Support', description: 'Web chat support', mediaType: 'chat', address: 'web-chat', peakPerHour: 22, ahtSec: 560, patienceSec: 240, outboundShare: 0, weekendFactor: 0.6 },
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

const WRAPUPS = ['Resolved', 'Information provided', 'Follow-up needed', 'Escalated', 'Payment taken', 'Refund issued', 'Sale completed', 'Cancellation saved', 'Cancelled', 'Wrong department'];

const FIRST = ['Alex', 'Maria', 'John', 'Laura', 'Carlos', 'Sophie', 'David', 'Lucia', 'Mark', 'Elena', 'Peter', 'Julia', 'Diego', 'Nina', 'Oscar', 'Paula'];
const LAST = ['Smith', 'Garcia', 'Brown', 'Lopez', 'Miller', 'Perez', 'Davis', 'Sanchez', 'Taylor', 'Ramirez', 'Moore', 'Flores'];

// ---- helpers -----------------------------------------------------------------------------

function onShift(a: DemoAgent, t: number): boolean {
  const local = ((t / 3_600_000 + DEMO_UTC_OFFSET) % 24 + 24) % 24;
  const weekday = new Date(t + DEMO_UTC_OFFSET * 3_600_000).getUTCDay();
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
