import { describe, expect, it, vi } from 'vitest';
import { ConfirmationStore, commitTool } from '../src/tools/commit.js';
import { makeCtx, run } from './helpers.js';

describe('confirmation store', () => {
  it('is single use', () => {
    const store = new ConfirmationStore();
    const { confirmationId } = store.create({
      tool: 't',
      resourceType: 'Patient',
      payload: { a: 1 },
      execute: async () => ({ resourceType: 'Patient' }),
    });
    expect(store.consume(confirmationId).payload).toEqual({ a: 1 });
    expect(() => store.consume(confirmationId)).toThrow(/already been used/);
  });
  it('expires after the TTL', () => {
    let now = 1_000;
    const store = new ConfirmationStore(10 * 60 * 1000, () => now);
    const { confirmationId } = store.create({
      tool: 't',
      resourceType: 'X',
      payload: {},
      execute: async () => ({ resourceType: 'X' }),
    });
    now += 10 * 60 * 1000 + 1;
    expect(() => store.consume(confirmationId)).toThrow(/expired/);
  });
  it('rejects unknown ids', () => {
    expect(() => new ConfirmationStore().consume('cf_nope')).toThrow(/Unknown/);
  });
  it('binds to a frozen copy of the payload', () => {
    const store = new ConfirmationStore();
    const payload = { nested: { value: 'original' } };
    const { confirmationId } = store.create({
      tool: 't',
      resourceType: 'X',
      payload,
      execute: async () => ({ resourceType: 'X' }),
    });
    payload.nested.value = 'mutated';
    const stored = store.consume(confirmationId).payload as typeof payload;
    expect(stored.nested.value).toBe('original');
    expect(Object.isFrozen(stored.nested)).toBe(true);
  });
  it('ids are random and unguessable', () => {
    const store = new ConfirmationStore();
    const ids = new Set(
      Array.from(
        { length: 50 },
        () =>
          store.create({
            tool: 't',
            resourceType: 'X',
            payload: {},
            execute: async () => ({ resourceType: 'X' }),
          }).confirmationId,
      ),
    );
    expect(ids.size).toBe(50);
  });
});

describe('halaxy_commit', () => {
  it('executes the stored payload once and audits it', async () => {
    const { ctx } = makeCtx([]);
    const execute = vi.fn(async (p: { n: number }) => ({ resourceType: 'Patient', id: `P${p.n}` }));
    const { confirmationId } = ctx.confirmations.create({
      tool: 'halaxy_prepare_create_patient',
      resourceType: 'Patient',
      payload: { n: 7 },
      execute,
    });
    const result = await run(commitTool, { confirmationId }, ctx);
    expect(result).toMatchObject({ committed: true, resourceType: 'Patient', id: 'P7' });
    expect(result.auditId).toMatch(/[0-9a-f-]{36}/);
    expect(execute).toHaveBeenCalledTimes(1);
    await expect(run(commitTool, { confirmationId }, ctx)).rejects.toThrow(/already been used/);
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it('audits failures and reports them', async () => {
    const { ctx } = makeCtx([]);
    const { confirmationId } = ctx.confirmations.create({
      tool: 'x',
      resourceType: 'Patient',
      payload: {},
      execute: async () => {
        throw new Error('boom');
      },
    });
    await expect(run(commitTool, { confirmationId }, ctx)).rejects.toThrow(/Commit failed: boom/);
  });
});
