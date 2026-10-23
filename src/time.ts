export interface ResolvedInterval {
  start: Date;
  end: Date;
  /** ISO-8601 interval as the analytics API expects it: `start/end`. */
  iso: string;
}

const RELATIVE = /^last[\s_-]*(\d+)\s*(m|min|minutes?|h|hours?|d|days?)$/i;

/**
 * Resolve a human interval into an absolute one.
 * Accepts `today`, `yesterday`, `this_week`, `last 30m`, `last 4h`, `last 7d`, or an ISO interval `start/end`.
 * Calendar words use the given IANA time zone.
 */
export function resolveInterval(input: string | undefined, now: Date, timeZone: string): ResolvedInterval {
  const text = (input ?? 'today').trim();
  let start: Date;
  let end = now;

  const rel = RELATIVE.exec(text);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2]!.toLowerCase()[0];
    const ms = unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
    start = new Date(now.getTime() - n * ms);
  } else if (/^today$/i.test(text)) {
    start = startOfDay(now, timeZone);
  } else if (/^yesterday$/i.test(text)) {
    end = startOfDay(now, timeZone);
    start = startOfDay(new Date(end.getTime() - 12 * 3_600_000), timeZone);
  } else if (/^this[\s_-]?week$/i.test(text)) {
    const today = startOfDay(now, timeZone);
    const weekday = isoWeekday(now, timeZone);
    start = startOfDay(new Date(today.getTime() - (weekday - 1) * 86_400_000 + 12 * 3_600_000), timeZone);
  } else if (text.includes('/')) {
    const [a, b] = text.split('/');
    start = new Date(a!);
    end = new Date(b!);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) throw new Error(`Invalid ISO interval '${text}'.`);
  } else {
    throw new Error(`Unrecognised interval '${text}'. Use today, yesterday, this_week, last 30m, last 4h, last 7d or an ISO interval start/end.`);
  }

  if (end <= start) throw new Error(`Interval '${text}' ends before it starts.`);
  return { start, end, iso: `${start.toISOString()}/${end.toISOString()}` };
}

/** UTC instant of local midnight for the day `at` falls on in `timeZone`. */
export function startOfDay(at: Date, timeZone: string): Date {
  const p = zonedParts(at, timeZone);
  const guess = Date.UTC(p.year, p.month - 1, p.day);
  // Two passes handle days where the offset changes (DST).
  let ts = guess - offset(guess, timeZone);
  ts = guess - offset(ts, timeZone);
  return new Date(ts);
}

function isoWeekday(at: Date, timeZone: string): number {
  const name = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(at);
  return ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(name) + 1;
}

function offset(ts: number, timeZone: string): number {
  const p = zonedParts(new Date(ts), timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ts / 1000) * 1000;
}

function zonedParts(at: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((x) => x.type === type)!.value);
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute'), second: get('second') };
}

export function assertTimeZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
  } catch {
    throw new Error(`Unknown time zone '${timeZone}'. Use an IANA name such as America/Bogota.`);
  }
}
