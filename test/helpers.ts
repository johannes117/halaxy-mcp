import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig, type Config } from '../src/config.js';
import type { SecretStore } from '../src/secrets.js';
import { createContext } from '../src/server.js';
import type { ToolContext, ToolDef } from '../src/tools/types.js';

export const BASE = 'https://au-api.halaxy.com/main/';
export const TEST_TOKEN = 'test-access-token-abc123';
export const TEST_SECRET = 'test-client-secret-xyz789';

export class MemoryStore implements SecretStore {
  values = new Map<string, string>([
    ['client_id', 'test-client-id'],
    ['client_secret', TEST_SECRET],
  ]);
  async get(a: string) {
    return this.values.get(a);
  }
  async set(a: string, v: string) {
    this.values.set(a, v);
  }
  async delete(a: string) {
    return this.values.delete(a);
  }
}

export interface Call {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: unknown;
}

export interface Reply {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export type Route = {
  method: string;
  /** Path relative to /main/, e.g. "Patient" or /^Patient\/\w+$/ */
  path: string | RegExp;
  reply: Reply | ((call: Call) => Reply);
};

export function fakeHalaxy(routes: Route[]) {
  const calls: Call[] = [];
  let tokenCount = 0;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>),
    );
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    const call = { method, url, headers, body };
    calls.push(call);
    const path = url.pathname.replace(/^\/main\//, '');
    if (path === 'oauth/token') {
      tokenCount++;
      return json(200, { access_token: TEST_TOKEN, expires_in: 900, token_type: 'Bearer' });
    }
    for (const r of routes) {
      if (r.method !== method) continue;
      const match = typeof r.path === 'string' ? r.path === path : r.path.test(path);
      if (!match) continue;
      const reply = typeof r.reply === 'function' ? r.reply(call) : r.reply;
      return json(reply.status ?? 200, reply.body, reply.headers);
    }
    return json(404, {
      resourceType: 'OperationOutcome',
      issue: [
        { severity: 'error', code: 'not-found', diagnostics: `No route for ${method} ${path}` },
      ],
    });
  }) as typeof fetch;
  return { fetchImpl, calls, tokenCount: () => tokenCount };
}

export function json(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/fhir+json', ...headers },
  });
}

export function bundle(resources: unknown[], next?: string) {
  return {
    resourceType: 'Bundle',
    type: 'searchset',
    entry: resources.map((resource) => ({ resource, search: { mode: 'match' } })),
    ...(next ? { link: [{ relation: 'next', url: next }] } : {}),
  };
}

export function tempDir(prefix = 'halaxy-mcp-test-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function testConfig(overrides: Partial<Config> = {}): Config {
  return parseConfig({ region: 'au', timezone: 'Australia/Sydney', ...overrides });
}

export function makeCtx(
  routes: Route[],
  opts: { config?: Partial<Config>; now?: Date; auditDir?: string } = {},
): { ctx: ToolContext; calls: Call[]; auditDir: string; tokenCount: () => number } {
  const fake = fakeHalaxy(routes);
  const auditDir = opts.auditDir ?? tempDir('halaxy-audit-');
  const ctx = createContext(testConfig(opts.config), {
    secrets: new MemoryStore(),
    fetchImpl: fake.fetchImpl,
    now: () => opts.now ?? new Date('2026-03-01T00:00:00Z'),
    auditDir,
  });
  return { ctx, calls: fake.calls, auditDir, tokenCount: fake.tokenCount };
}

export async function run(
  tool: ToolDef,
  args: unknown,
  ctx: ToolContext,
): Promise<Record<string, unknown>> {
  const parsed = await tool.input.parseAsync(args);
  return (await tool.handler(parsed, ctx)) as Record<string, unknown>;
}

// ---------- synthetic fixtures (obviously fake data) ----------

/** Synthetic Medicare number with a valid check digit; not a real card. */
export const TEST_MEDICARE = '2123456701';

export function patient(id: string, overrides: Record<string, unknown> = {}) {
  return {
    resourceType: 'Patient',
    id,
    meta: { lastUpdated: '2026-01-01T00:00:00Z' },
    name: [{ use: 'official', given: ['Test'], family: 'Patient' }],
    birthDate: '2000-01-01',
    gender: 'female',
    telecom: [
      { system: 'sms', value: '+61400000001', use: 'mobile' },
      { system: 'email', value: 'test.patient@example.com' },
    ],
    ...overrides,
  };
}
