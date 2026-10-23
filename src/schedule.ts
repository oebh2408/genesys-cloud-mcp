/** An Architect schedule: a local start and end time, optionally repeated by an iCalendar RRULE. */
export interface Schedule {
  id: string;
  name: string;
  /** Local date-time without offset, as the API returns it: 2026-01-05T08:00:00.000 */
  start: string;
  end: string;
  rrule?: string;
}

export interface ScheduleGroup {
  id: string;
  name: string;
  timeZone?: string;
  openSchedules?: { id: string; name?: string }[];
  closedSchedules?: { id: string; name?: string }[];
  holidaySchedules?: { id: string; name?: string }[];
}

export type ScheduleState = 'open' | 'closed' | 'holiday';

const DAY = 86_400_000;
const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

/** Local wall-clock time of an instant, as milliseconds on a UTC axis, so date arithmetic ignores offsets. */
export function wallClock(at: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(at));
  const get = (type: string) => Number(parts.find((x) => x.type === type)!.value);
  return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
}

const parseLocal = (s: string) => Date.parse(`${s.replace(/Z$/, '').slice(0, 19)}Z`);

function parseRule(rrule: string): Record<string, string> {
  return Object.fromEntries(
    rrule
      .replace(/^RRULE:/i, '')
      .split(';')
      .filter(Boolean)
      .map((p) => {
        const [k, v] = p.split('=');
        return [k!.toUpperCase(), (v ?? '').toUpperCase()];
      }),
  );
}

/**
 * Whether a schedule covers a local wall-clock time. Supports one-off schedules and RRULEs with
 * FREQ DAILY, WEEKLY (BYDAY), MONTHLY (BYMONTHDAY) and YEARLY, INTERVAL and UNTIL; other parts are ignored.
 */
export function covers(schedule: Schedule, local: number): boolean {
  const start = parseLocal(schedule.start);
  const end = parseLocal(schedule.end);
  if (Number.isNaN(start) || Number.isNaN(end) || end <= start) return false;
  if (!schedule.rrule) return local >= start && local < end;

  const rule = parseRule(schedule.rrule);
  const length = end - start;
  const interval = Math.max(1, Number(rule.INTERVAL ?? 1));
  const until = rule.UNTIL ? Date.parse(rule.UNTIL.replace(/^(\d{4})(\d{2})(\d{2})(T(\d{2})(\d{2})(\d{2}))?Z?$/, (_, y, m, d, _t, hh = '23', mm = '59', ss = '59') => `${y}-${m}-${d}T${hh}:${mm}:${ss}Z`)) : Infinity;
  const timeOfDay = start % DAY;
  const startDay = Math.floor(start / DAY);
  const days = Math.ceil(length / DAY);

  // An occurrence that covers `local` started on its day or up to `days` days earlier.
  for (let back = 0; back <= days; back++) {
    const day = Math.floor(local / DAY) - back;
    const occurrence = day * DAY + timeOfDay;
    if (occurrence < start || occurrence > until) continue;
    if (local < occurrence || local >= occurrence + length) continue;
    const date = new Date(day * DAY);
    const first = new Date(start);
    let ok: boolean;
    switch (rule.FREQ) {
      case 'DAILY':
        ok = (day - startDay) % interval === 0;
        break;
      case 'WEEKLY': {
        const byDay = rule.BYDAY ? rule.BYDAY.split(',').map((d) => d.slice(-2)) : [WEEKDAYS[first.getUTCDay()]!];
        const week = (d: number) => Math.floor((d + 3) / 7); // weeks start on Monday
        ok = byDay.includes(WEEKDAYS[date.getUTCDay()]!) && (week(day) - week(startDay)) % interval === 0;
        break;
      }
      case 'MONTHLY': {
        const byMonthDay = rule.BYMONTHDAY ? rule.BYMONTHDAY.split(',').map(Number) : [first.getUTCDate()];
        const months = (date.getUTCFullYear() - first.getUTCFullYear()) * 12 + date.getUTCMonth() - first.getUTCMonth();
        ok = byMonthDay.includes(date.getUTCDate()) && months % interval === 0;
        break;
      }
      case 'YEARLY':
        ok = date.getUTCMonth() === first.getUTCMonth() && date.getUTCDate() === first.getUTCDate() && (date.getUTCFullYear() - first.getUTCFullYear()) % interval === 0;
        break;
      default:
        ok = false;
    }
    if (ok) return true;
  }
  return false;
}

/** Holiday schedules win over closed ones, closed over open, the same order Architect uses. */
export function evaluate(
  group: ScheduleGroup,
  schedules: Map<string, Schedule>,
  at: number,
  timeZone: string,
): { state: ScheduleState; schedule?: string } {
  const local = wallClock(at, timeZone);
  const find = (refs: { id: string }[] | undefined) => (refs ?? []).map((r) => schedules.get(r.id)).find((s) => s && covers(s, local));
  const holiday = find(group.holidaySchedules);
  if (holiday) return { state: 'holiday', schedule: holiday.name };
  const closed = find(group.closedSchedules);
  if (closed) return { state: 'closed', schedule: closed.name };
  const open = find(group.openSchedules);
  if (open) return { state: 'open', schedule: open.name };
  return { state: 'closed' };
}

/** The next time the state changes, up to `horizonDays` ahead, to the minute. Changes shorter than five minutes can be missed. */
export function nextChange(group: ScheduleGroup, schedules: Map<string, Schedule>, at: number, timeZone: string, horizonDays = 8) {
  const current = evaluate(group, schedules, at, timeZone);
  const differs = (t: number) => {
    const next = evaluate(group, schedules, t, timeZone);
    return next.state !== current.state || next.schedule !== current.schedule ? next : undefined;
  };
  const first = Math.floor(at / 60_000) * 60_000 + 60_000;
  for (let t = first; t < at + horizonDays * DAY; t += 5 * 60_000) {
    if (!differs(t)) continue;
    for (let m = Math.max(first, t - 4 * 60_000); m <= t; m += 60_000) {
      const next = differs(m);
      if (next) return { at: m, ...next };
    }
  }
  return undefined;
}

/** Holidays that start within the next `days` days, in local dates. */
export function upcomingHolidays(group: ScheduleGroup, schedules: Map<string, Schedule>, at: number, timeZone: string, days = 60) {
  const out: { name: string; date: string }[] = [];
  const today = Math.floor(wallClock(at, timeZone) / DAY);
  for (let d = 0; d < days; d++) {
    const noon = (today + d) * DAY + 12 * 3_600_000;
    for (const ref of group.holidaySchedules ?? []) {
      const s = schedules.get(ref.id);
      if (s && covers(s, noon) && !out.some((h) => h.name === s.name)) out.push({ name: s.name, date: new Date(noon).toISOString().slice(0, 10) });
    }
  }
  return out;
}

export function formatLocal(at: number, timeZone: string): string {
  return new Date(wallClock(at, timeZone)).toISOString().slice(0, 16).replace('T', ' ');
}
