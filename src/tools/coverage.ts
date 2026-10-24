import { z } from 'zod';
import { refMatches, type Refs } from '../halaxy/refs.js';
import { displayName } from '../halaxy/summaries.js';
import { CoverageSchema, parseEach } from '../halaxy/types.js';
import { maskMedicare } from '../safety/mask.js';
import {
  HalaxyIdSchema,
  IrnSchema,
  MedicareExpirySchema,
  MedicareNumberSchema,
  medicareExpiryToDate,
} from '../safety/validate.js';
import { todayInZone } from '../time.js';
import { prepared } from './commit.js';
import { createdId, fetchPatient } from './shared.js';
import { APPROVAL_NOTE, ToolError, defineTool } from './types.js';

/**
 * Medicare Coverage payload.
 *
 * UNVERIFIED: Halaxy's Create Coverage reference (https://developers.halaxy.com/reference/createcoverage)
 * documents subscriberId (card number) and dependent (IRN) but we could not confirm how the
 * Medicare payor/type must be expressed. That is why this tool is only registered when
 * `enableMedicareCoverage: true` is set in config.json. Verify against the docs (or a test
 * account) and adjust before enabling.
 */
export function buildMedicareCoveragePayload(
  refs: Refs,
  patientId: string,
  medicareNumber: string,
  irn: number,
  expiry?: string,
): Record<string, unknown> {
  const patient = refs.ref('Patient', patientId);
  return {
    resourceType: 'Coverage',
    status: 'active',
    type: { text: 'Medicare' },
    subscriberId: medicareNumber,
    dependent: String(irn),
    subscriber: patient,
    beneficiary: patient,
    payor: [{ display: 'Medicare' }],
    ...(expiry ? { period: { end: medicareExpiryToDate(expiry) } } : {}),
  };
}

export const prepareCreateMedicareCoverageTool = defineTool({
  name: 'halaxy_prepare_create_medicare_coverage',
  title: 'Prepare: add Medicare card',
  kind: 'write',
  description:
    "Prepares adding a patient's Medicare card as a Halaxy Coverage (does not write yet). Needed before creating a referral. " +
    'The 10-digit number is checked with the Medicare check-digit rule; the IRN is the single digit next to the patient on the card. ' +
    'Have the user confirm the number digit by digit against the card or referral. Outputs show the number masked. ' +
    APPROVAL_NOTE,
  input: z
    .object({
      patientId: HalaxyIdSchema,
      medicareNumber: MedicareNumberSchema.describe('10 digits, spaces allowed'),
      irn: IrnSchema.describe('Individual reference number, 1–9'),
      expiry: MedicareExpirySchema.optional().describe('MM/YYYY'),
    })
    .strict(),
  async handler(args, ctx) {
    const patient = await fetchPatient(ctx, args.patientId);
    const existing = parseEach(
      CoverageSchema,
      (
        await ctx.client.search('Coverage', {
          beneficiary: ctx.refs.search('Patient', args.patientId),
        })
      ).resources,
    ).filter((c) => refMatches(c.beneficiary?.reference, 'Patient', args.patientId));
    const same = existing.find(
      (c) =>
        c.subscriberId?.replace(/\D/g, '') === args.medicareNumber &&
        (c.dependent ?? '') === String(args.irn),
    );
    if (same) {
      throw new ToolError(
        'This Medicare card is already on the patient. Use the existing coverage.',
        {
          existingCoverageId: same.id,
        },
      );
    }
    const warnings: string[] = [];
    if (
      args.expiry &&
      medicareExpiryToDate(args.expiry) < todayInZone(ctx.config.timezone, ctx.now())
    ) {
      warnings.push('⚠️ This Medicare card has expired. Ask the patient for their current card.');
    }
    if (existing.some((c) => c.subscriberId && c.status !== 'cancelled')) {
      warnings.push(
        'The patient already has another active coverage. Check whether it should be updated instead.',
      );
    }
    const payload = buildMedicareCoveragePayload(
      ctx.refs,
      args.patientId,
      args.medicareNumber,
      args.irn,
      args.expiry,
    );
    return prepared(
      ctx,
      {
        tool: 'halaxy_prepare_create_medicare_coverage',
        resourceType: 'Coverage',
        payload,
        async execute(body, c) {
          const res = await c.client.post('Coverage', body);
          return { resourceType: 'Coverage', id: createdId(res.body, res.location, 'Coverage') };
        },
      },
      {
        action: 'Add Medicare coverage',
        patient: displayName(patient.name) ?? args.patientId,
        medicare: maskMedicare(args.medicareNumber, args.irn),
        checkDigit: 'valid',
        expiry: args.expiry ?? null,
      },
      warnings,
    );
  },
});
