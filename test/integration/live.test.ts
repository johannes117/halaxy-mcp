/**
 * Live Halaxy API tests. Opt-in only:
 *   HALAXY_IT=1             read tests (uses the keychain credentials + config.json — use a TEST key)
 *   HALAXY_IT_WRITES=1      also book and then cancel an appointment (never run in CI)
 * Pinned synthetic test data (create these once in the test practice):
 *   HALAXY_IT_PATIENT_ID, HALAXY_IT_FAMILY, HALAXY_IT_BIRTHDATE
 *   HALAXY_IT_ROLE_ID (a PR- role), HALAXY_IT_SERVICE_ID  (writes only)
 */
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { createContext } from '../../src/server.js';
import { listPractitionersTool, listServicesTool } from '../../src/tools/catalog.js';
import {
  findAvailableTimesTool,
  prepareBookAppointmentTool,
  prepareCancelAppointmentTool,
} from '../../src/tools/appointments.js';
import { commitTool } from '../../src/tools/commit.js';
import { run } from '../helpers.js';

const enabled = process.env.HALAXY_IT === '1' && !process.env.CI;
const writes = enabled && process.env.HALAXY_IT_WRITES === '1';
const env = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is required for integration tests`);
  return v;
};

describe.skipIf(!enabled)('live Halaxy (read)', () => {
  const ctx = enabled ? createContext(loadConfig()) : undefined!;

  it('lists practitioners and services', async () => {
    const p = await run(listPractitionersTool, {}, ctx);
    expect(Array.isArray(p.practitioners)).toBe(true);
    const s = await run(listServicesTool, {}, ctx);
    expect(Array.isArray(s.services)).toBe(true);
  });

  // Control-query tests: each filter we rely on must actually narrow results.
  const control = async (
    query: Record<string, string>,
    nonsense: Record<string, string>,
    path = 'Patient',
  ) => {
    const real = await ctx.client.search(path, query);
    const none = await ctx.client.search(path, nonsense);
    return { real: real.resources.length, none: none.resources.length };
  };

  it('Patient family filter is honoured', async () => {
    const r = await control({ family: env('HALAXY_IT_FAMILY') }, { family: 'Zzqxnonexistent' });
    expect(r.real).toBeGreaterThan(0);
    expect(r.none).toBe(0);
  });

  it('Patient birthdate filter is honoured', async () => {
    const r = await control({ birthdate: env('HALAXY_IT_BIRTHDATE') }, { birthdate: '1901-01-01' });
    expect(r.real).toBeGreaterThan(0);
    expect(r.none).toBe(0);
  });

  it('Coverage beneficiary filter is honoured', async () => {
    const r = await control(
      { beneficiary: `Patient/${env('HALAXY_IT_PATIENT_ID')}` },
      { beneficiary: 'Patient/0' },
      'Coverage',
    );
    expect(r.none).toBe(0);
  });

  it('Referral subject filter is honoured', async () => {
    const r = await control(
      { subject: `Patient/${env('HALAXY_IT_PATIENT_ID')}` },
      { subject: 'Patient/0' },
      'Referral',
    );
    expect(r.none).toBe(0);
  });
});

describe.skipIf(!writes)('live Halaxy (writes: book then cancel)', () => {
  it('books and cancels an appointment for the synthetic patient', async () => {
    const ctx = createContext(loadConfig());
    const from = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
    const to = new Date(Date.now() + 21 * 86_400_000).toISOString().slice(0, 10);
    const slots = await run(
      findAvailableTimesTool,
      { practitionerRoleId: env('HALAXY_IT_ROLE_ID'), from, to, durationMinutes: 30, limit: 1 },
      ctx,
    );
    const slot = (slots.slots as Array<{ start: string }>)[0];
    expect(slot).toBeDefined();
    const prep = await run(
      prepareBookAppointmentTool,
      {
        patientId: env('HALAXY_IT_PATIENT_ID'),
        practitionerRoleId: env('HALAXY_IT_ROLE_ID'),
        healthcareServiceId: env('HALAXY_IT_SERVICE_ID'),
        start: slot!.start,
        durationMinutes: 30,
      },
      ctx,
    );
    const booked = await run(commitTool, { confirmationId: prep.confirmationId }, ctx);
    expect(booked.id).toBeTruthy();
    const cancel = await run(
      prepareCancelAppointmentTool,
      { appointmentId: booked.id as string, reason: 'no charge' },
      ctx,
    );
    await run(commitTool, { confirmationId: cancel.confirmationId }, ctx);
  });
});
