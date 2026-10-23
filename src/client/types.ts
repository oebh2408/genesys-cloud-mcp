export type Method = 'GET' | 'POST';

export interface RequestOptions {
  /** Arrays are sent as repeated parameters. */
  query?: Record<string, string | number | boolean | string[] | undefined>;
  body?: unknown;
}

/** The subset of the Genesys Cloud Platform API the tools use. Both the HTTP client and the demo org implement it. */
export interface PlatformClient {
  request<T>(method: Method, path: string, options?: RequestOptions): Promise<T>;
}

export class PlatformError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'PlatformError';
  }
}

/** Paths that may be called with POST. Every one of them is a query that reads data. */
const READ_ONLY_POST = [
  /^\/api\/v2\/analytics\/conversations\/aggregates\/query$/,
  /^\/api\/v2\/analytics\/conversations\/details\/query$/,
  /^\/api\/v2\/analytics\/queues\/observations\/query$/,
  /^\/api\/v2\/analytics\/users\/aggregates\/query$/,
  /^\/api\/v2\/analytics\/users\/details\/query$/,
  /^\/api\/v2\/analytics\/flows\/aggregates\/query$/,
  /^\/api\/v2\/analytics\/evaluations\/aggregates\/query$/,
  /^\/api\/v2\/analytics\/surveys\/aggregates\/query$/,
  /^\/api\/v2\/workforcemanagement\/managementunits\/[^/]+\/agentschedules\/search$/,
  /^\/api\/v2\/users\/search$/,
  /^\/api\/v2\/audits\/query\/realtime$/,
];

/**
 * The server never changes anything in the org. This check is the last line of defence:
 * any request that is not a GET or one of the known query endpoints is refused before it is sent.
 */
export function assertReadOnly(method: Method, path: string): void {
  if (method === 'GET') return;
  if (method === 'POST' && READ_ONLY_POST.some((re) => re.test(path))) return;
  throw new PlatformError(`Refused ${method} ${path}: this server only performs read-only requests.`);
}
