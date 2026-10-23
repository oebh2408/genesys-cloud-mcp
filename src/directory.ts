import type { PlatformClient } from './client/types.js';

export interface Named {
  id: string;
  name: string;
}

interface Paged<T> {
  entities?: T[];
  pageCount?: number;
}

const TTL_MS = 5 * 60_000;
const MAX_PAGES = 20;

/** Cached lookups of queues, users and wrap-up codes, so tools can show names instead of ids. */
export class Directory {
  private cache = new Map<string, { at: number; value: Named[] }>();
  private extraUsers = new Map<string, Named>();

  constructor(
    private readonly client: PlatformClient,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  queues(): Promise<(Named & { description?: string; memberCount?: number })[]> {
    return this.list('/api/v2/routing/queues');
  }

  users(): Promise<Named[]> {
    return this.list('/api/v2/users');
  }

  wrapupCodes(): Promise<Named[]> {
    return this.list('/api/v2/routing/wrapupcodes');
  }

  async queueName(id: string | undefined): Promise<string | undefined> {
    if (!id) return undefined;
    return (await this.queues()).find((q) => q.id === id)?.name ?? id;
  }

  async userName(id: string | undefined): Promise<string | undefined> {
    if (!id) return undefined;
    const hit = (await this.users()).find((u) => u.id === id) ?? this.extraUsers.get(id);
    if (hit) return hit.name;
    try {
      const user = await this.client.request<Named>('GET', `/api/v2/users/${encodeURIComponent(id)}`);
      this.extraUsers.set(id, user);
      return user.name;
    } catch {
      return id;
    }
  }

  async wrapupName(id: string | undefined): Promise<string | undefined> {
    if (!id) return undefined;
    return (await this.wrapupCodes()).find((w) => w.id === id)?.name ?? id;
  }

  /** Find queues by id or name. Exact matches win over partial matches. */
  async resolveQueues(inputs: string[]): Promise<Named[]> {
    return resolve(await this.queues(), inputs, 'queue');
  }

  async resolveUsers(inputs: string[]): Promise<Named[]> {
    return resolve(await this.users(), inputs, 'agent');
  }

  private async list<T extends Named>(path: string): Promise<T[]> {
    const hit = this.cache.get(path);
    if (hit && this.clock().getTime() - hit.at < TTL_MS) return hit.value as T[];
    const out: T[] = [];
    for (let pageNumber = 1; pageNumber <= MAX_PAGES; pageNumber++) {
      const page = await this.client.request<Paged<T>>('GET', path, { query: { pageSize: 100, pageNumber } });
      out.push(...(page.entities ?? []));
      if (!page.pageCount || pageNumber >= page.pageCount) break;
    }
    this.cache.set(path, { at: this.clock().getTime(), value: out });
    return out;
  }
}

function resolve<T extends Named>(all: T[], inputs: string[], what: string): T[] {
  return inputs.map((input) => {
    const needle = input.trim().toLowerCase();
    const found =
      all.find((x) => x.id === input) ??
      all.find((x) => x.name.toLowerCase() === needle) ??
      all.filter((x) => x.name.toLowerCase().includes(needle)).sort((a, b) => a.name.length - b.name.length)[0];
    if (!found) {
      const sample = all.slice(0, 15).map((x) => x.name).join(', ');
      throw new Error(`No ${what} matches '${input}'.${sample ? ` Known ${what}s include: ${sample}.` : ''}`);
    }
    return found;
  });
}
