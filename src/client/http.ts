import { assertReadOnly, PlatformError, type Method, type PlatformClient, type RequestOptions } from './types.js';

export interface HttpClientOptions {
  clientId: string;
  clientSecret: string;
  /** Region domain, e.g. `mypurecloud.com`, `usw2.pure.cloud`, `mypurecloud.de`. */
  region: string;
  /** Request timeout in milliseconds. */
  timeoutMs?: number;
  /** Retries for 429 and 5xx responses. */
  maxRetries?: number;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

interface Token {
  value: string;
  expiresAt: number;
}

/** Platform API client using the OAuth client credentials grant. */
export class HttpPlatformClient implements PlatformClient {
  private token?: Token;
  private pendingToken?: Promise<Token>;
  private readonly fetch: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: HttpClientOptions) {
    this.fetch = options.fetch ?? globalThis.fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async request<T>(method: Method, path: string, options: RequestOptions = {}): Promise<T> {
    assertReadOnly(method, path);
    const url = new URL(`https://api.${this.options.region}${path}`);
    for (const [k, v] of Object.entries(options.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));

    const maxRetries = this.options.maxRetries ?? 3;
    for (let attempt = 0; ; attempt++) {
      const token = await this.getToken();
      const res = await this.fetch(url, {
        method,
        headers: {
          authorization: `Bearer ${token.value}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 30_000),
      });

      if (res.status === 401 && attempt === 0) {
        this.token = undefined; // token revoked or expired early
        continue;
      }
      if ((res.status === 429 || res.status >= 500) && attempt < maxRetries) {
        const retryAfter = Number(res.headers.get('retry-after'));
        await this.sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** attempt);
        continue;
      }
      if (!res.ok) throw new PlatformError(await errorMessage(res, `${method} ${path}`), res.status);
      return (await res.json()) as T;
    }
  }

  private async getToken(): Promise<Token> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token;
    this.pendingToken ??= this.fetchToken().finally(() => {
      this.pendingToken = undefined;
    });
    this.token = await this.pendingToken;
    return this.token;
  }

  private async fetchToken(): Promise<Token> {
    const basic = Buffer.from(`${this.options.clientId}:${this.options.clientSecret}`).toString('base64');
    const res = await this.fetch(`https://login.${this.options.region}/oauth/token`, {
      method: 'POST',
      headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 30_000),
    });
    if (!res.ok) throw new PlatformError(await errorMessage(res, 'OAuth token request'), res.status);
    const json = (await res.json()) as { access_token: string; expires_in: number };
    return { value: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
  }
}

async function errorMessage(res: Response, what: string): Promise<string> {
  let detail = '';
  try {
    const body = (await res.json()) as { message?: string; error_description?: string };
    detail = body.message ?? body.error_description ?? '';
  } catch {
    // body was not JSON
  }
  const hint =
    res.status === 401
      ? ' Check GENESYS_CLIENT_ID, GENESYS_CLIENT_SECRET and GENESYS_REGION.'
      : res.status === 403
        ? ' The OAuth client is missing a permission for this request; see the README for the role to assign.'
        : '';
  return `${what} failed with ${res.status}${detail ? `: ${detail}` : ''}.${hint}`;
}
