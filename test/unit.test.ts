import { describe, expect, it, vi } from 'vitest';
import { assertReadOnly, covers, evaluate, HttpPlatformClient, maskAddress, maskName, PlatformError, resolveInterval } from '../src/index.js';

describe('resolveInterval', () => {
  const now = new Date('2026-10-21T16:30:00Z');

  it('today and yesterday follow the time zone', () => {
    expect(resolveInterval('today', now, 'America/Bogota').iso).toBe('2026-10-21T05:00:00.000Z/2026-10-21T16:30:00.000Z');
    expect(resolveInterval('yesterday', now, 'America/Bogota').iso).toBe('2026-10-20T05:00:00.000Z/2026-10-21T05:00:00.000Z');
    expect(resolveInterval('today', now, 'Europe/Madrid').iso).toBe('2026-10-20T22:00:00.000Z/2026-10-21T16:30:00.000Z');
  });

  it('handles days where daylight saving time changes', () => {
    // 2026-11-01 is 25 hours long in New York.
    const at = new Date('2026-11-02T12:00:00Z');
    expect(resolveInterval('yesterday', at, 'America/New_York').iso).toBe('2026-11-01T04:00:00.000Z/2026-11-02T05:00:00.000Z');
  });

  it('this_week starts on Monday', () => {
    expect(resolveInterval('this_week', now, 'UTC').start.toISOString()).toBe('2026-10-19T00:00:00.000Z');
  });

  it('relative and ISO intervals', () => {
    expect(resolveInterval('last 4h', now, 'UTC').start.toISOString()).toBe('2026-10-21T12:30:00.000Z');
    expect(resolveInterval('last_30m', now, 'UTC').start.toISOString()).toBe('2026-10-21T16:00:00.000Z');
    expect(resolveInterval('last 7 days', now, 'UTC').start.toISOString()).toBe('2026-10-14T16:30:00.000Z');
    expect(resolveInterval('2026-10-01T00:00:00Z/2026-10-02T00:00:00Z', now, 'UTC').iso).toBe('2026-10-01T00:00:00.000Z/2026-10-02T00:00:00.000Z');
    expect(resolveInterval(undefined, now, 'UTC').start.toISOString()).toBe('2026-10-21T00:00:00.000Z');
  });

  it('rejects nonsense', () => {
    expect(() => resolveInterval('next tuesday', now, 'UTC')).toThrow(/Unrecognised interval/);
    expect(() => resolveInterval('2026-10-02T00:00:00Z/2026-10-01T00:00:00Z', now, 'UTC')).toThrow(/ends before/);
  });
});

describe('redaction', () => {
  it('masks phone numbers, SIP addresses and emails', () => {
    expect(maskAddress('tel:+15551234567')).toBe('+1•••4567');
    expect(maskAddress('sip:+15551234567@10.0.0.1')).toBe('+1•••4567@10.0.0.1');
    expect(maskAddress('jane.doe@example.com')).toBe('j•••@example.com');
    expect(maskAddress('web-chat')).toBe('web-chat');
  });

  it('reduces names to initials', () => {
    expect(maskName('Laura Perez')).toBe('L. P.');
    expect(maskName('+1 555 123 4567')).toBe('+1•••4567');
  });
});

describe('read-only guard', () => {
  it('allows GET and the analytics queries only', () => {
    expect(() => assertReadOnly('GET', '/api/v2/routing/queues')).not.toThrow();
    expect(() => assertReadOnly('POST', '/api/v2/analytics/conversations/details/query')).not.toThrow();
    expect(() => assertReadOnly('POST', '/api/v2/analytics/users/details/query')).not.toThrow();
    expect(() => assertReadOnly('POST', '/api/v2/analytics/flows/aggregates/query')).not.toThrow();
    expect(() => assertReadOnly('POST', '/api/v2/architect/schedules')).toThrow(/read-only/);
    expect(() => assertReadOnly('POST', '/api/v2/routing/queues')).toThrow(PlatformError);
    expect(() => assertReadOnly('POST', '/api/v2/conversations/calls')).toThrow(/read-only/);
    expect(() => assertReadOnly('DELETE' as never, '/api/v2/users/1')).toThrow();
  });
});

describe('schedules', () => {
  const at = (s: string) => Date.parse(`${s}Z`);
  it('weekly rules with BYDAY and an interval', () => {
    const weekdays = { id: '1', name: 'w', start: '2026-01-05T08:00:00.000', end: '2026-01-05T20:00:00.000', rrule: 'FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,TU,WE,TH,FR' };
    expect(covers(weekdays, at('2026-10-21T08:00:00'))).toBe(true);
    expect(covers(weekdays, at('2026-10-21T20:00:00'))).toBe(false);
    expect(covers(weekdays, at('2026-10-24T10:00:00'))).toBe(false); // Saturday
    expect(covers(weekdays, at('2025-12-31T10:00:00'))).toBe(false); // before the start
    const fortnight = { ...weekdays, rrule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO' };
    expect(covers(fortnight, at('2026-01-19T09:00:00'))).toBe(true);
    expect(covers(fortnight, at('2026-01-12T09:00:00'))).toBe(false);
  });

  it('daily, monthly, yearly, UNTIL and schedules past midnight', () => {
    const night = { id: '1', name: 'n', start: '2026-01-01T22:00:00.000', end: '2026-01-02T06:00:00.000', rrule: 'FREQ=DAILY' };
    expect(covers(night, at('2026-10-21T03:00:00'))).toBe(true);
    expect(covers(night, at('2026-10-21T12:00:00'))).toBe(false);
    const monthly = { id: '2', name: 'm', start: '2026-01-15T00:00:00.000', end: '2026-01-16T00:00:00.000', rrule: 'FREQ=MONTHLY;BYMONTHDAY=15' };
    expect(covers(monthly, at('2026-10-15T12:00:00'))).toBe(true);
    const christmas = { id: '3', name: 'c', start: '2025-12-25T00:00:00.000', end: '2025-12-26T00:00:00.000', rrule: 'FREQ=YEARLY' };
    expect(covers(christmas, at('2027-12-25T09:00:00'))).toBe(true);
    expect(covers({ ...christmas, rrule: 'FREQ=YEARLY;UNTIL=20261231T000000Z' }, at('2027-12-25T09:00:00'))).toBe(false);
  });

  it('holiday wins over closed, closed over open, in the group time zone', () => {
    const schedules = new Map([
      ['o', { id: 'o', name: 'Open', start: '2026-01-01T08:00:00.000', end: '2026-01-01T20:00:00.000', rrule: 'FREQ=DAILY' }],
      ['c', { id: 'c', name: 'Training', start: '2026-10-21T08:00:00.000', end: '2026-10-21T09:00:00.000' }],
      ['h', { id: 'h', name: 'Holiday', start: '2026-10-22T00:00:00.000', end: '2026-10-23T00:00:00.000' }],
    ]);
    const group = { id: 'g', name: 'G', openSchedules: [{ id: 'o' }], closedSchedules: [{ id: 'c' }], holidaySchedules: [{ id: 'h' }] };
    expect(evaluate(group, schedules, Date.parse('2026-10-21T13:30:00Z'), 'America/Bogota')).toEqual({ state: 'closed', schedule: 'Training' });
    expect(evaluate(group, schedules, Date.parse('2026-10-21T14:30:00Z'), 'America/Bogota')).toEqual({ state: 'open', schedule: 'Open' });
    expect(evaluate(group, schedules, Date.parse('2026-10-22T15:00:00Z'), 'America/Bogota')).toEqual({ state: 'holiday', schedule: 'Holiday' });
    expect(evaluate(group, schedules, Date.parse('2026-10-21T02:00:00Z'), 'America/Bogota').state).toBe('closed');
  });
});

describe('HttpPlatformClient', () => {
  const tokenResponse = () => new Response(JSON.stringify({ access_token: 'tok', expires_in: 86400 }), { status: 200 });
  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });

  it('gets a token once, sends it, and builds the URL from the region', async () => {
    const fetch = vi.fn(async (url: string | URL) => (String(url).includes('/oauth/token') ? tokenResponse() : json({ entities: [] })));
    const client = new HttpPlatformClient({ clientId: 'id', clientSecret: 'secret', region: 'usw2.pure.cloud', fetch: fetch as never });
    await client.request('GET', '/api/v2/routing/queues', { query: { pageSize: 100, name: undefined } });
    await client.request('GET', '/api/v2/users');
    expect(fetch).toHaveBeenCalledTimes(3);
    const [tokenUrl, tokenInit] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(tokenUrl).toBe('https://login.usw2.pure.cloud/oauth/token');
    expect((tokenInit.headers as Record<string, string>).authorization).toBe(`Basic ${Buffer.from('id:secret').toString('base64')}`);
    const [apiUrl, apiInit] = fetch.mock.calls[1] as unknown as [URL, RequestInit];
    expect(String(apiUrl)).toBe('https://api.usw2.pure.cloud/api/v2/routing/queues?pageSize=100');
    expect((apiInit.headers as Record<string, string>).authorization).toBe('Bearer tok');
  });

  it('retries 429 using Retry-After', async () => {
    const sleep = vi.fn(async () => {});
    let calls = 0;
    const fetch = vi.fn(async (url: string | URL) => {
      if (String(url).includes('/oauth/token')) return tokenResponse();
      return ++calls === 1 ? json({ message: 'slow down' }, 429, { 'retry-after': '2' }) : json({ ok: true });
    });
    const client = new HttpPlatformClient({ clientId: 'a', clientSecret: 'b', region: 'mypurecloud.com', fetch: fetch as never, sleep });
    await expect(client.request('GET', '/api/v2/users')).resolves.toEqual({ ok: true });
    expect(sleep).toHaveBeenCalledWith(2000);
  });

  it('refreshes the token once on 401', async () => {
    let tokens = 0;
    let calls = 0;
    const fetch = vi.fn(async (url: string | URL) => {
      if (String(url).includes('/oauth/token')) {
        tokens++;
        return tokenResponse();
      }
      return ++calls === 1 ? json({}, 401) : json({ ok: true });
    });
    const client = new HttpPlatformClient({ clientId: 'a', clientSecret: 'b', region: 'mypurecloud.com', fetch: fetch as never });
    await expect(client.request('GET', '/api/v2/users')).resolves.toEqual({ ok: true });
    expect(tokens).toBe(2);
  });

  it('explains permission errors and never sends write requests', async () => {
    const fetch = vi.fn(async (url: string | URL) => (String(url).includes('/oauth/token') ? tokenResponse() : json({ message: 'Missing permission' }, 403)));
    const client = new HttpPlatformClient({ clientId: 'a', clientSecret: 'b', region: 'mypurecloud.com', fetch: fetch as never });
    await expect(client.request('GET', '/api/v2/users')).rejects.toThrow(/403: Missing permission\. The OAuth client is missing a permission/);
    fetch.mockClear();
    await expect(client.request('POST', '/api/v2/conversations/emails', { body: {} })).rejects.toThrow(/read-only/);
    expect(fetch).not.toHaveBeenCalled();
  });
});
