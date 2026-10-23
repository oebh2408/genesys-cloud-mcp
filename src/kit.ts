/** Pieces shared by the tool modules: the tool shape, common arguments, API result types and helpers. */
import { z } from 'zod';
import type { PlatformClient } from './client/types.js';
import type { Directory, Named } from './directory.js';

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

export const define = <S extends z.ZodRawShape>(t: ToolDefinition<S>) => t;

export const intervalArg = z
  .string()
  .optional()
  .describe('today (default), yesterday, this_week, last 30m, last 4h, last 7d, or an ISO-8601 interval start/end');
export const queuesArg = z.array(z.string()).optional().describe('Queue names or ids. Partial names work. Omit for all queues.');

// ---- API shapes --------------------------------------------------------------------------

export interface Stat {
  count?: number;
  sum?: number;
  max?: number;
  ratio?: number;
  numerator?: number;
  denominator?: number;
}
export interface AggregateResult {
  results?: { group: Record<string, string>; data?: { interval: string; metrics: { metric: string; stats: Stat }[] }[] }[];
}
export interface ObservationResult {
  results?: { group: Record<string, string>; data?: { metric: string; qualifier?: string; stats: Stat; observations?: { observationDate: string }[] }[] }[];
}
export interface Segment {
  segmentStart: string;
  segmentEnd?: string;
  segmentType: string;
  queueId?: string;
  wrapUpCode?: string;
  disconnectType?: string;
}
export interface Session {
  mediaType: string;
  direction?: string;
  ani?: string;
  dnis?: string;
  segments?: Segment[];
  metrics?: { name: string; value: number }[];
}
export interface Participant {
  participantId?: string;
  participantName?: string;
  purpose: string;
  userId?: string;
  sessions?: Session[];
}
export interface Conversation {
  conversationId: string;
  conversationStart: string;
  conversationEnd?: string;
  originatingDirection?: string;
  participants?: Participant[];
}

export type UserEntity = Named & {
  department?: string;
  presence?: { presenceDefinition?: { systemPresence?: string } };
  routingStatus?: { status?: string };
  skills?: { name: string; proficiency?: number }[];
  languages?: { name: string; proficiency?: number }[];
};

// ---- helpers -----------------------------------------------------------------------------

export const PRESENCE_KEYS: Record<string, string> = {
  BREAK: 'breakMinutes',
  MEAL: 'mealMinutes',
  MEETING: 'meetingMinutes',
  TRAINING: 'trainingMinutes',
  AWAY: 'awayMinutes',
  BUSY: 'busyMinutes',
  AVAILABLE: 'availableMinutes',
};

export function emptyStatus() {
  return {
    loggedInMinutes: 0,
    onQueueMinutes: 0,
    idleMinutes: 0,
    interactingMinutes: 0,
    notRespondingMinutes: 0,
    offQueueMinutes: 0,
    onQueuePercent: null as number | null,
    occupancyPercent: null as number | null,
    offQueueBy: {} as Record<string, number>,
  };
}

/** Time per presence and routing status from the user aggregates, in minutes, per user id. */
export async function statusTimes(ctx: ToolContext, userIds: string[], interval: string) {
  type Result = { group: Record<string, string>; data?: { metrics: { metric: string; qualifier?: string; stats: Stat }[] }[] };
  // Filters are sent in chunks to stay under the predicate limit of the analytics API.
  const chunks = userIds.length ? Array.from({ length: Math.ceil(userIds.length / 100) }, (_, i) => userIds.slice(i * 100, i * 100 + 100)) : [[]];
  const responses = await Promise.all(
    chunks.map((ids) =>
      ctx.client.request<{ results?: Result[] }>('POST', '/api/v2/analytics/users/aggregates/query', {
        body: {
          interval,
          groupBy: ['userId'],
          ...(ids.length ? { filter: { type: 'or', predicates: ids.map((id) => ({ dimension: 'userId', value: id })) } } : {}),
          metrics: ['tSystemPresence', 'tAgentRoutingStatus'],
        },
      }),
    ),
  );
  const out = new Map<string, ReturnType<typeof emptyStatus>>();
  for (const r of responses.flatMap((x) => x.results ?? [])) {
    const metrics = (r.data ?? []).flatMap((d) => d.metrics);
    const ms = (metric: string, qualifier: string) => metrics.filter((m) => m.metric === metric && m.qualifier === qualifier).reduce((n, m) => n + (m.stats.sum ?? 0), 0);
    const minutes = (metric: string, qualifier: string) => Math.round(ms(metric, qualifier) / 60_000);
    const presences = [...new Set(metrics.filter((m) => m.metric === 'tSystemPresence').map((m) => m.qualifier ?? ''))].filter((p) => p && p !== 'OFFLINE');
    const loggedIn = Math.round(presences.reduce((n, p) => n + ms('tSystemPresence', p), 0) / 60_000);
    const onQueue = minutes('tSystemPresence', 'ON_QUEUE');
    const idle = minutes('tAgentRoutingStatus', 'IDLE');
    const interacting = minutes('tAgentRoutingStatus', 'INTERACTING') + minutes('tAgentRoutingStatus', 'COMMUNICATING');
    const offQueueBy: Record<string, number> = {};
    for (const p of presences) if (p !== 'ON_QUEUE' && minutes('tSystemPresence', p)) offQueueBy[PRESENCE_KEYS[p] ?? `${p.toLowerCase()}Minutes`] = minutes('tSystemPresence', p);
    out.set(r.group.userId!, {
      loggedInMinutes: loggedIn,
      onQueueMinutes: onQueue,
      idleMinutes: idle,
      interactingMinutes: interacting,
      notRespondingMinutes: minutes('tAgentRoutingStatus', 'NOT_RESPONDING'),
      offQueueMinutes: loggedIn - onQueue,
      onQueuePercent: loggedIn ? round1((onQueue / loggedIn) * 100) : null,
      occupancyPercent: idle + interacting ? round1((interacting / (idle + interacting)) * 100) : null,
      offQueueBy,
    });
  }
  return out;
}

export function presenceLabel(system: string | undefined): string {
  if (!system) return 'Unknown';
  if (system === 'ON_QUEUE') return 'On Queue';
  return system.charAt(0) + system.slice(1).toLowerCase().replace(/_/g, ' ');
}

export async function pages<T>(client: PlatformClient, path: string, query: Record<string, string>): Promise<T[]> {
  const out: T[] = [];
  for (let pageNumber = 1; pageNumber <= 20; pageNumber++) {
    const page = await client.request<{ entities?: T[]; pageCount?: number }>('GET', path, { query: { ...query, pageSize: 100, pageNumber } });
    out.push(...(page.entities ?? []));
    if (!page.pageCount || pageNumber >= page.pageCount) break;
  }
  return out;
}

export function stat(metrics: { metric: string; stats: Stat }[], name: string): Stat {
  const list = metrics.filter((m) => m.metric === name).map((m) => m.stats);
  return {
    count: list.reduce((n, s) => n + (s.count ?? 0), 0),
    sum: list.reduce((n, s) => n + (s.sum ?? 0), 0),
    max: list.reduce((n, s) => Math.max(n, s.max ?? 0), 0),
    numerator: list.reduce((n, s) => n + (s.numerator ?? 0), 0),
    denominator: list.reduce((n, s) => n + (s.denominator ?? 0), 0),
  };
}

export function avgSeconds(s: Stat): number | null {
  return s.count ? Math.round((s.sum ?? 0) / s.count / 1000) : null;
}

export const round1 = (n: number) => Math.round(n * 10) / 10;
