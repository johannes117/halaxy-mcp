import { describe, expect, it } from 'vitest';
import { TokenProvider } from '../src/halaxy/auth.js';
import { HalaxyApiError, HalaxyClient } from '../src/halaxy/client.js';
import { BASE, TEST_SECRET, TEST_TOKEN, bundle, json } from './helpers.js';

function setup(handler: (url: URL, init: RequestInit) => Response, now = () => 0) {
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  let tokens = 0;
  const fetchImpl = (async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    if (url.pathname.endsWith('/oauth/token')) {
      tokens++;
      return json(200, { access_token: `${TEST_TOKEN}-${tokens}`, expires_in: 3600 });
    }
    return handler(url, init);
  }) as typeof fetch;
  const provider = new TokenProvider(
    BASE,
    async () => ({ clientId: 'id', clientSecret: TEST_SECRET }),
    fetchImpl,
    now,
  );
  const client = new HalaxyClient(BASE, provider, { fetchImpl, sleep: async () => {} });
  return { client, calls, tokens: () => tokens };
}

describe('auth', () => {
  it('posts client credentials as JSON with FHIR accept + UA', async () => {
    const { client, calls } = setup(() => json(200, { resourceType: 'Patient', id: '1' }));
    await client.get('Patient/1');
    const tokenCall = calls[0]!;
    expect(tokenCall.url.toString()).toBe(`${BASE}oauth/token`);
    const h = tokenCall.init.headers as Record<string, string>;
    expect(h['Content-Type']).toBe('application/json');
    expect(h.Accept).toBe('application/fhir+json');
    expect(h['User-Agent']).toMatch(/^halaxy-mcp\//);
    expect(JSON.parse(tokenCall.init.body as string)).toEqual({
      grant_type: 'client_credentials',
      client_id: 'id',
      client_secret: TEST_SECRET,
    });
  });

  it('caches the token and refreshes 60s before min(expires_in, 900)', async () => {
    let now = 0;
    const { client, tokens } = setup(
      () => json(200, {}),
      () => now,
    );
    await client.get('Patient');
    await client.get('Patient');
    expect(tokens()).toBe(1);
    now = (900 - 60) * 1000 - 1;
    await client.get('Patient');
    expect(tokens()).toBe(1);
    now = (900 - 60) * 1000 + 1;
    await client.get('Patient');
    expect(tokens()).toBe(2);
  });

  it('refreshes once and retries once on 401', async () => {
    let n = 0;
    const { client, tokens } = setup(() => (++n === 1 ? json(401, {}) : json(200, { ok: true })));
    expect(await client.get('Patient')).toEqual({ ok: true });
    expect(tokens()).toBe(2);
  });

  it('gives up after a second 401', async () => {
    const { client } = setup(() => json(401, {}));
    await expect(client.get('Patient')).rejects.toMatchObject({ status: 401 });
  });
});

describe('requests', () => {
  it('sends bearer, FHIR accept and User-Agent on every request', async () => {
    const { client, calls } = setup(() => json(200, {}));
    await client.get('Patient', { family: 'Patient' });
    const h = calls[1]!.init.headers as Record<string, string>;
    expect(h.Authorization).toBe(`Bearer ${TEST_TOKEN}-1`);
    expect(h.Accept).toBe('application/fhir+json');
    expect(h['User-Agent']).toMatch(/^halaxy-mcp\/\d+\.\d+\.\d+/);
  });

  it('uses merge-patch for PATCH', async () => {
    const { client, calls } = setup(() => json(200, {}));
    await client.patch('Patient/1', { birthDate: '2000-01-01' });
    expect(calls[1]!.init.method).toBe('PATCH');
    expect((calls[1]!.init.headers as Record<string, string>)['Content-Type']).toBe(
      'application/merge-patch+json',
    );
  });

  it('turns 422 into a plain-English error with OperationOutcome text and no secrets', async () => {
    const { client } = setup(() =>
      json(422, {
        resourceType: 'OperationOutcome',
        issue: [
          { severity: 'error', code: 'processing', diagnostics: 'recipient must be Type/id' },
        ],
      }),
    );
    const err = await client.post('Patient', { name: 'Test Patient' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HalaxyApiError);
    const msg = (err as Error).message;
    expect(msg).toContain('could not process');
    expect(msg).toContain('recipient must be Type/id');
    expect(msg).not.toContain(TEST_TOKEN);
    expect(msg).not.toContain('Test Patient');
    expect(msg).not.toContain(TEST_SECRET);
  });

  it('explains 405', async () => {
    const { client } = setup(() => json(405, {}));
    await expect(client.patch('Practitioner/1', {})).rejects.toThrow(
      /does not allow this operation/,
    );
  });

  it('retries a GET once on 503 but never retries POST', async () => {
    let n = 0;
    const a = setup(() => (++n === 1 ? json(503, {}) : json(200, { ok: 1 })));
    expect(await a.client.get('Patient')).toEqual({ ok: 1 });
    let m = 0;
    const b = setup(() => (++m === 1 ? json(503, {}) : json(201, {})));
    await expect(b.client.post('Patient', {})).rejects.toMatchObject({ status: 503 });
    expect(m).toBe(1);
  });

  it('refuses URLs outside the configured base', async () => {
    const { client } = setup(() => json(200, {}));
    await expect(client.request('GET', 'https://evil.example.com/main/Patient')).rejects.toThrow(
      /outside/,
    );
  });
});

describe('pagination', () => {
  const page = (start: number, count: number) =>
    Array.from({ length: count }, (_, i) => ({ resourceType: 'Patient', id: String(start + i) }));

  it('follows next links up to the 50-result cap and reports truncation', async () => {
    const { client } = setup((url) => {
      const p = Number(url.searchParams.get('page') ?? '1');
      return json(200, bundle(page((p - 1) * 30, 30), `${BASE}Patient?page=${p + 1}`));
    });
    const r = await client.search('Patient');
    expect(r.resources).toHaveLength(50);
    expect(r.truncated).toBe(true);
  });

  it('does not report truncation when everything fits', async () => {
    const { client } = setup(() => json(200, bundle(page(0, 5))));
    expect(await client.search('Patient')).toMatchObject({ truncated: false });
  });

  it('ignores next links to other hosts', async () => {
    const { client, calls } = setup(() =>
      json(200, bundle(page(0, 2), 'https://evil.example.com/main/Patient?page=2')),
    );
    const r = await client.search('Patient');
    expect(r.resources).toHaveLength(2);
    expect(calls.filter((c) => c.url.host === 'evil.example.com')).toHaveLength(0);
  });

  it('skips included (non-match) entries', async () => {
    const { client } = setup(() =>
      json(200, {
        resourceType: 'Bundle',
        entry: [
          { resource: { id: 'a' }, search: { mode: 'match' } },
          { resource: { id: 'b' }, search: { mode: 'include' } },
        ],
      }),
    );
    expect((await client.search('Patient')).resources).toEqual([{ id: 'a' }]);
  });
});
