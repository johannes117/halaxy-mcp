import { describe, expect, it } from 'vitest';
import { checkDuplicate, scoreCandidate } from '../src/safety/duplicates.js';
import { PatientSchema } from '../src/halaxy/types.js';
import { bundle, makeCtx, patient } from './helpers.js';

const input = {
  given: 'Test',
  family: 'Patient',
  birthDate: '2000-01-01',
  mobile: '+61400000001',
  email: 'test.patient@example.com',
};
const p = (o: Record<string, unknown> = {}) => PatientSchema.parse(patient('1', o));

describe('duplicate scoring', () => {
  it('exact when name and DOB match (case/accent-insensitive)', () => {
    expect(
      scoreCandidate(input, p({ name: [{ given: ['TÉST'], family: 'patient' }] }))?.match,
    ).toBe('exact');
  });
  it('likely when DOB plus one name or contact matches', () => {
    expect(
      scoreCandidate(input, p({ name: [{ given: ['Other'], family: 'Patient' }] }))?.match,
    ).toBe('likely');
    expect(
      scoreCandidate(input, p({ name: [{ given: ['Other'], family: 'Person' }] }))?.match,
    ).toBe('likely');
  });
  it('possible when only a contact or both names match', () => {
    expect(
      scoreCandidate(input, p({ birthDate: '1999-01-01', name: [{ given: ['X'], family: 'Y' }] }))
        ?.match,
    ).toBe('possible');
    expect(
      scoreCandidate(
        { ...input, mobile: undefined, email: undefined },
        p({ birthDate: '1999-01-01' }),
      )?.match,
    ).toBe('possible');
  });
  it('drops candidates with nothing in common', () => {
    expect(
      scoreCandidate(
        input,
        p({ birthDate: '1980-05-05', name: [{ given: ['A'], family: 'B' }], telecom: [] }),
      ),
    ).toBeUndefined();
  });
});

describe('checkDuplicate', () => {
  it('merges searches and ignores noise from ignored filters', async () => {
    const noise = Array.from({ length: 5 }, (_, i) =>
      patient(`noise${i}`, {
        name: [{ given: ['Someone'], family: `Else${i}` }],
        birthDate: '1970-01-01',
        telecom: [],
      }),
    );
    const { ctx, calls } = makeCtx([
      { method: 'GET', path: 'Patient', reply: { body: bundle([patient('42'), ...noise]) } },
    ]);
    const r = await checkDuplicate(ctx.client, input);
    expect(r.verdict).toBe('exact');
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0]).toMatchObject({ id: '42', match: 'exact', mobile: '•••••••001' });
    const queries = calls
      .filter((c) => c.url.pathname.endsWith('/Patient'))
      .map((c) => Object.fromEntries(c.url.searchParams));
    expect(queries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ family: 'Patient', birthdate: '2000-01-01' }),
        expect.objectContaining({ given: 'Test', birthdate: '2000-01-01' }),
        expect.objectContaining({ phone: '+61400000001' }),
        expect.objectContaining({ email: 'test.patient@example.com' }),
      ]),
    );
  });
  it('returns none when nothing matches', async () => {
    const { ctx } = makeCtx([{ method: 'GET', path: 'Patient', reply: { body: bundle([]) } }]);
    expect(await checkDuplicate(ctx.client, input)).toEqual({ verdict: 'none', candidates: [] });
  });
});
