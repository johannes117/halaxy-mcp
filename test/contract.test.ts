import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { createServer } from '../src/server.js';
import { makeCtx, tempDir } from './helpers.js';

const READS = [
  'halaxy_search_patients',
  'halaxy_check_duplicate',
  'halaxy_get_patient',
  'halaxy_list_practitioners',
  'halaxy_list_services',
  'halaxy_find_available_times',
  'halaxy_list_appointments',
  'halaxy_search_referrers',
  'halaxy_list_referrals',
];
const WRITES = [
  'halaxy_prepare_create_patient',
  'halaxy_prepare_update_patient',
  'halaxy_prepare_create_referrer',
  'halaxy_prepare_create_referral',
  'halaxy_prepare_book_appointment',
  'halaxy_prepare_cancel_appointment',
  'halaxy_commit',
];

async function connect(
  config: Parameters<typeof makeCtx>[1] extends infer O
    ? O extends { config?: infer C }
      ? C
      : never
    : never = {},
) {
  const { ctx } = makeCtx([], { config });
  const server = createServer(ctx);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(b);
  return client;
}

describe('MCP contract', () => {
  it('lists every tool with schemas and correct annotations', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([...READS, ...WRITES].sort());
    for (const t of tools) {
      expect(t.description!.length).toBeGreaterThan(40);
      expect(t.inputSchema.type).toBe('object');
      if (READS.includes(t.name)) {
        expect(t.annotations).toMatchObject({ readOnlyHint: true });
      } else {
        expect(t.annotations).toMatchObject({
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
        });
      }
      if (t.name.startsWith('halaxy_prepare_')) expect(t.description).toMatch(/explicit approval/);
    }
    const create = tools.find((t) => t.name === 'halaxy_prepare_create_patient')!;
    expect(create.description).toMatch(/halaxy_check_duplicate first/);
    expect(Object.keys(create.inputSchema.properties ?? {})).toEqual(
      expect.arrayContaining(['given', 'family', 'birthDate', 'mobile', 'source', 'guardian']),
    );
  });

  it('read-only mode registers no write tools', async () => {
    const client = await connect({ writesEnabled: false });
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names.sort()).toEqual([...READS].sort());
  });

  it('Medicare coverage tool appears only when enabled', async () => {
    const client = await connect({ enableMedicareCoverage: true });
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain('halaxy_prepare_create_medicare_coverage');
  });

  it('returns structured tool errors for invalid input and bad confirmations', async () => {
    const client = await connect();
    const bad = await client.callTool({
      name: 'halaxy_commit',
      arguments: { confirmationId: 'cf_unknown' },
    });
    expect(bad.isError).toBe(true);
    expect(JSON.stringify(bad.content)).toMatch(/Unknown confirmationId/);
    const invalid = await client.callTool({
      name: 'halaxy_get_patient',
      arguments: { id: '../../etc' },
    });
    expect(invalid.isError).toBe(true);
  });

  it('exposes the workflow prompts', async () => {
    const client = await connect();
    const names = (await client.listPrompts()).prompts.map((p) => p.name).sort();
    expect(names).toEqual(['find_and_offer_times', 'ingest_gp_referral', 'ingest_paper_form']);
  });
});

describe.skipIf(!existsSync('dist/index.js'))('stdio (built binary)', () => {
  it('starts over stdio and lists tools without touching the network', async () => {
    const configDir = tempDir();
    writeFileSync(
      join(configDir, 'config.json'),
      JSON.stringify({ region: 'au', timezone: 'Australia/Sydney', writesEnabled: true }),
    );
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['dist/index.js'],
      env: {
        ...(process.env as Record<string, string>),
        HALAXY_MCP_CONFIG_DIR: configDir,
        HALAXY_MCP_STATE_DIR: tempDir(),
      },
      stderr: 'pipe',
    });
    const client = new Client({ name: 'stdio-test', version: '0.0.0' });
    await client.connect(transport);
    const { tools } = await client.listTools();
    expect(tools.length).toBe(READS.length + WRITES.length);
    await client.close();
  });

  it('prints its version', async () => {
    const out = await new Promise<string>((resolve) => {
      const p = spawn(process.execPath, ['dist/index.js', 'version']);
      let s = '';
      p.stdout.on('data', (d) => (s += d));
      p.on('close', () => resolve(s.trim()));
    });
    expect(out).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
