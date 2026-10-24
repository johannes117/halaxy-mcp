import { log } from '../logger.js';
import { userAgent } from '../version.js';
import { AuthError, type FetchLike, type TokenProvider } from './auth.js';

export type Query = Record<string, string | number | boolean | (string | number)[] | undefined>;

export interface HalaxyResponse {
  status: number;
  body: unknown;
  location?: string;
}

const STATUS_MESSAGES: Record<number, string> = {
  400: 'Halaxy said the request was malformed',
  401: 'Halaxy rejected the access token',
  403: 'Halaxy refused access. Check that the API key has permission for this resource',
  404: 'Halaxy could not find that record',
  405: 'Halaxy does not allow this operation on that resource',
  409: 'Halaxy reported a conflict (for example a double booking)',
  422: 'Halaxy could not process the request (validation failed)',
  429: 'Halaxy is rate limiting requests; try again shortly',
};

export class HalaxyApiError extends Error {
  constructor(
    readonly status: number,
    readonly operation: string,
    readonly issues: string[],
  ) {
    const base =
      STATUS_MESSAGES[status] ??
      (status >= 500 ? 'Halaxy had a server error' : `Halaxy returned HTTP ${status}`);
    const detail = issues.length > 0 ? `: ${issues.join(' | ')}` : '.';
    super(`${base} (HTTP ${status}, ${operation})${detail}`);
    this.name = 'HalaxyApiError';
  }
}

/** Pull human-readable text out of a FHIR OperationOutcome, if that is what we got. */
export function operationOutcomeIssues(body: unknown): string[] {
  if (!body || typeof body !== 'object') return [];
  const outcome = body as { resourceType?: unknown; issue?: unknown };
  if (outcome.resourceType !== 'OperationOutcome' || !Array.isArray(outcome.issue)) return [];
  const out: string[] = [];
  for (const issue of outcome.issue as Array<Record<string, unknown>>) {
    const details = issue.details as { text?: unknown } | undefined;
    const text =
      (typeof issue.diagnostics === 'string' && issue.diagnostics) ||
      (details && typeof details.text === 'string' && details.text) ||
      (typeof issue.code === 'string' && issue.code) ||
      '';
    if (text) out.push(text.slice(0, 500));
  }
  return out.slice(0, 5);
}

export interface ClientOptions {
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  /** Hard cap for internal pagination. */
  maxResults?: number;
}

export const RESULT_CAP = 50;
const RETRYABLE_GET = new Set([429, 502, 503, 504]);

export class HalaxyClient {
  private readonly fetchImpl: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;
  readonly maxResults: number;
  private readonly origin: string;

  constructor(
    readonly base: string,
    private readonly tokens: TokenProvider,
    options: ClientOptions = {},
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.maxResults = options.maxResults ?? RESULT_CAP;
    this.origin = new URL(base).origin;
  }

  url(path: string, query?: Query): string {
    const url = new URL(path.replace(/^\/+/, ''), this.base);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined) continue;
        const values = Array.isArray(value) ? value : [value];
        for (const v of values) url.searchParams.append(key, String(v));
      }
    }
    return url.toString();
  }

  async get<T = unknown>(path: string, query?: Query): Promise<T> {
    return (await this.request('GET', this.url(path, query))).body as T;
  }

  async post(path: string, body: unknown): Promise<HalaxyResponse> {
    return this.request('POST', this.url(path), body, 'application/fhir+json');
  }

  /** JSON merge-patch. Never PUT: Halaxy's PUT removes any omitted field. */
  async patch(path: string, body: unknown): Promise<HalaxyResponse> {
    return this.request('PATCH', this.url(path), body, 'application/merge-patch+json');
  }

  /**
   * Run a search and follow Bundle `next` links until `cap` resources are collected
   * (default: the 50-result hard cap).
   * `truncated` tells the caller (and the model) that more results exist.
   */
  async search<T = Record<string, unknown>>(
    path: string,
    query: Query = {},
    cap = this.maxResults,
  ): Promise<{ resources: T[]; truncated: boolean }> {
    // `cap` may exceed maxResults only for internal scans that are filtered client-side
    // before anything is returned to the model (e.g. separating PR- from EP- roles).
    const limit = Math.max(1, cap);
    const resources: T[] = [];
    let next: string | undefined = this.url(path, { _count: Math.min(limit, 50), ...query });
    let pages = 0;
    const maxPages = Math.ceil(limit / 50) + 1;
    while (next && pages < maxPages) {
      pages++;
      const bundle = (await this.request('GET', next)).body as {
        entry?: Array<{ resource?: T; search?: { mode?: string } }>;
        link?: Array<{ relation?: string; url?: string }>;
      };
      for (const entry of bundle?.entry ?? []) {
        if (!entry.resource) continue;
        if (entry.search?.mode && entry.search.mode !== 'match') continue;
        if (resources.length >= limit) return { resources, truncated: true };
        resources.push(entry.resource);
      }
      const nextLink = bundle?.link?.find((l) => l.relation === 'next')?.url;
      next = nextLink && this.isOwnUrl(nextLink) ? nextLink : undefined;
      if (next && resources.length >= limit) return { resources, truncated: true };
    }
    return { resources, truncated: Boolean(next) };
  }

  /** Only ever talk to the configured Halaxy host. */
  private isOwnUrl(url: string): boolean {
    try {
      const u = new URL(url, this.base);
      return u.origin === this.origin && u.pathname.startsWith(new URL(this.base).pathname);
    } catch {
      return false;
    }
  }

  async request(
    method: string,
    url: string,
    body?: unknown,
    contentType?: string,
  ): Promise<HalaxyResponse> {
    if (!this.isOwnUrl(url))
      throw new Error('Refusing to call a URL outside the configured Halaxy base.');
    const operation = describe(method, url);
    let authRetried = false;
    let transientRetried = false;
    for (;;) {
      const token = await this.tokens.getToken();
      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        Accept: 'application/fhir+json',
        'User-Agent': userAgent(),
      };
      if (body !== undefined) headers['Content-Type'] = contentType ?? 'application/fhir+json';
      const started = Date.now();
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch {
        log.debug('request failed (network)', { operation });
        throw new HalaxyApiError(0, operation, ['Network error while contacting Halaxy']);
      }
      log.debug('request', { operation, status: res.status, ms: Date.now() - started });

      if (res.status === 401 && !authRetried) {
        authRetried = true;
        this.tokens.invalidate();
        continue;
      }
      if (method === 'GET' && RETRYABLE_GET.has(res.status) && !transientRetried) {
        transientRetried = true;
        await this.sleep(1000);
        continue;
      }

      const parsed = await readJson(res);
      if (!res.ok) {
        throw new HalaxyApiError(res.status, operation, operationOutcomeIssues(parsed));
      }
      return {
        status: res.status,
        body: parsed,
        location: res.headers.get('location') ?? undefined,
      };
    }
  }
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** "GET Patient" style label with ids and query values stripped, safe for logs and errors. */
function describe(method: string, url: string): string {
  try {
    const path = new URL(url).pathname.replace(/^\/main\//, '');
    const segments = path.split('/').filter(Boolean);
    return `${method} ${segments[0] ?? ''}${segments.length > 1 ? (segments[1]!.startsWith('$') ? '/' + segments[1] : '/{id}') : ''}${segments.length > 2 ? '/' + segments.slice(2).join('/') : ''}`;
  } catch {
    return method;
  }
}

export { AuthError };
