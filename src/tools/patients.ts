import { z } from 'zod';
import { refMatches } from '../halaxy/refs.js';
import {
  displayName,
  emails,
  formatAddress,
  mobiles,
  officialName,
  patientFamily,
  patientGivenNames,
  phones,
} from '../halaxy/summaries.js';
import {
  CoverageSchema,
  PatientSchema,
  ReferralSchema,
  parseEach,
  type ContactPoint,
  type HumanName,
  type Patient,
} from '../halaxy/types.js';
import { checkDuplicate, nameKey } from '../safety/duplicates.js';
import { maskMedicare, maskPhone } from '../safety/mask.js';
import {
  AddressInputSchema,
  AuMobileSchema,
  DateSchema,
  EmailSchema,
  HalaxyIdSchema,
  PhoneSchema,
  type AddressInput,
} from '../safety/validate.js';
import { todayInZone } from '../time.js';
import { prepared } from './commit.js';
import { ageOn, createdId, fetchPatient, truncationNote } from './shared.js';
import { APPROVAL_NOTE, ToolError, UNTRUSTED_NOTE, defineTool, type ToolContext } from './types.js';

// ---------- read tools ----------

export const searchPatientsTool = defineTool({
  name: 'halaxy_search_patients',
  title: 'Search patients',
  kind: 'read',
  description:
    'Searches Halaxy patients by family name, given name, date of birth, phone or email (at least one required). ' +
    'Returns up to 20 compact matches with masked mobile numbers. Use it to find a patient for booking, or alongside halaxy_check_duplicate before creating one. ' +
    UNTRUSTED_NOTE,
  input: z
    .object({
      family: z.string().trim().min(1).max(100).optional(),
      given: z.string().trim().min(1).max(100).optional(),
      birthDate: DateSchema.optional().describe('YYYY-MM-DD'),
      phone: PhoneSchema.optional(),
      email: EmailSchema.optional(),
    })
    .strict()
    .refine((v) => Object.values(v).some((x) => x !== undefined), {
      message: 'Provide at least one of family, given, birthDate, phone or email.',
    }),
  async handler(args, ctx) {
    const { resources, truncated } = await ctx.client.search(
      'Patient',
      {
        family: args.family,
        given: args.given,
        birthdate: args.birthDate,
        phone: args.phone,
        email: args.email,
      },
      20,
    );
    // Halaxy silently ignores some search params, so re-check every filter client-side.
    const matches = parseEach(PatientSchema, resources).filter((p) => {
      if (args.family && !nameKey(patientFamily(p)).startsWith(nameKey(args.family))) return false;
      if (
        args.given &&
        !patientGivenNames(p).some((g) => nameKey(g).startsWith(nameKey(args.given)))
      ) {
        return false;
      }
      if (args.birthDate && p.birthDate !== args.birthDate) return false;
      if (args.phone && !phones(p.telecom).includes(args.phone)) return false;
      if (args.email && !emails(p.telecom).includes(args.email)) return false;
      return true;
    });
    return {
      patients: matches.map((p) => ({
        id: p.id,
        name: displayName(p.name) ?? null,
        birthDate: p.birthDate ?? null,
        mobile: maskPhone(mobiles(p.telecom)[0]) ?? null,
        email: emails(p.telecom)[0] ?? null,
        lastUpdated: p.meta?.lastUpdated ?? null,
      })),
      ...truncationNote(truncated),
    };
  },
});

const DuplicateInputSchema = z
  .object({
    given: z.string().trim().min(1).max(100),
    family: z.string().trim().min(1).max(100),
    birthDate: DateSchema.describe('YYYY-MM-DD'),
    mobile: AuMobileSchema.optional(),
    email: EmailSchema.optional(),
  })
  .strict();

export const checkDuplicateTool = defineTool({
  name: 'halaxy_check_duplicate',
  title: 'Check for a duplicate patient',
  kind: 'read',
  description:
    'Before creating any patient, call this. Runs several searches (family+DOB, given+DOB, name, mobile, email) and scores candidates: ' +
    '"exact" (name and DOB match), "likely" (DOB plus one name or contact matches) or "possible". ' +
    'Returns { verdict, candidates }. If the verdict is exact or likely, tell the user and use the existing patient unless they confirm it is a different person.',
  input: DuplicateInputSchema,
  async handler(args, ctx) {
    return checkDuplicate(ctx.client, args);
  },
});

export const getPatientTool = defineTool({
  name: 'halaxy_get_patient',
  title: 'Get patient summary',
  kind: 'read',
  description:
    'Returns a summary of one patient: name, DOB, contacts, address, Medicare/other coverages (numbers masked) and how many referrals they have. ' +
    'Use the coverage id when preparing a referral. ' +
    UNTRUSTED_NOTE,
  input: z.object({ id: HalaxyIdSchema }).strict(),
  async handler({ id }, ctx) {
    const patient = await fetchPatient(ctx, id);
    const patientRef = ctx.refs.search('Patient', id);
    const [coverages, referrals] = await Promise.all([
      ctx.client.search('Coverage', { beneficiary: patientRef }),
      ctx.client.search('Referral', { subject: patientRef }),
    ]);
    const cov = parseEach(CoverageSchema, coverages.resources).filter((c) =>
      refMatches(c.beneficiary?.reference, 'Patient', id),
    );
    const refCount = parseEach(ReferralSchema, referrals.resources).filter((r) =>
      refMatches(r.subject?.reference, 'Patient', id),
    ).length;
    return {
      id: patient.id,
      name: displayName(patient.name) ?? null,
      birthDate: patient.birthDate ?? null,
      sex: patient.gender ?? null,
      mobile: mobiles(patient.telecom)[0] ?? null,
      otherPhones: phones(patient.telecom).filter((p) => p !== mobiles(patient.telecom)[0]),
      email: emails(patient.telecom)[0] ?? null,
      address: formatAddress(patient.address?.[0]) ?? null,
      coverages: cov.map((c) => ({
        id: c.id,
        status: c.status ?? null,
        type: c.type?.text ?? c.type?.coding?.[0]?.display ?? c.payor?.[0]?.display ?? null,
        number: maskMedicare(c.subscriberId, c.dependent) ?? null,
        expires: c.period?.end ?? null,
      })),
      referralCount: refCount,
      ...(coverages.truncated || referrals.truncated
        ? { truncated: 'Coverage or referral list hit the result cap.' }
        : {}),
    };
  },
});

// ---------- payload builders ----------

const SEX = ['male', 'female', 'other', 'unknown'] as const;

const GuardianSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    relationship: z.string().trim().min(1).max(50).describe('e.g. mother, father, carer'),
    mobile: AuMobileSchema.optional(),
    email: EmailSchema.optional(),
  })
  .strict();
type Guardian = z.infer<typeof GuardianSchema>;

export interface PatientFields {
  given: string;
  family: string;
  birthDate: string;
  sex?: (typeof SEX)[number];
  mobile?: string;
  email?: string;
  address?: AddressInput;
  guardian?: Guardian;
}

export function buildAddress(a: AddressInput) {
  return {
    use: 'home',
    line: [a.line],
    city: a.suburb,
    state: a.state,
    postalCode: a.postcode,
    country: 'AU',
  };
}

export function mobileContact(value: string): ContactPoint {
  return { system: 'sms', value, use: 'mobile' };
}

export function emailContact(value: string): ContactPoint {
  return { system: 'email', value };
}

/** FHIR Patient payload. `identifier` and `active` are read-only in Halaxy and never sent. */
export function buildPatientPayload(f: PatientFields): Record<string, unknown> {
  const telecom: ContactPoint[] = [];
  if (f.mobile) telecom.push(mobileContact(f.mobile));
  if (f.email) telecom.push(emailContact(f.email));
  const payload: Record<string, unknown> = {
    resourceType: 'Patient',
    name: [{ use: 'official', given: f.given.split(/\s+/), family: f.family }],
    birthDate: f.birthDate,
  };
  if (f.sex) payload.gender = f.sex;
  if (telecom.length) payload.telecom = telecom;
  if (f.address) payload.address = [buildAddress(f.address)];
  if (f.guardian) {
    const gTelecom: ContactPoint[] = [];
    if (f.guardian.mobile) gTelecom.push(mobileContact(f.guardian.mobile));
    if (f.guardian.email) gTelecom.push(emailContact(f.guardian.email));
    payload.contact = [
      {
        relationship: [{ text: f.guardian.relationship }],
        name: { text: f.guardian.name },
        ...(gTelecom.length ? { telecom: gTelecom } : {}),
      },
    ];
  }
  return payload;
}

const SOURCE = ['gp_referral', 'direct', 'school', 'allied_health', 'paper_form'] as const;

function validateBirthDate(birthDate: string, ctx: ToolContext): void {
  const today = todayInZone(ctx.config.timezone, ctx.now());
  if (birthDate > today) throw new ToolError('Date of birth is in the future. Re-check it.');
  if (ageOn(birthDate, today) > 120)
    throw new ToolError('Date of birth is more than 120 years ago. Re-check it.');
}

// ---------- write tools ----------

export const prepareCreatePatientTool = defineTool({
  name: 'halaxy_prepare_create_patient',
  title: 'Prepare: create patient',
  kind: 'write',
  description:
    'Prepares a new patient record (does not write yet). ALWAYS call halaxy_check_duplicate first and discuss any match with the user; this tool also re-runs the duplicate check and refuses exact duplicates. ' +
    'Phone numbers are normalised to +614… and dates must be YYYY-MM-DD. For children, include the guardian. ' +
    'Double-check DOB, name spelling and mobile digits against the source document. ' +
    APPROVAL_NOTE +
    ' ' +
    UNTRUSTED_NOTE,
  input: z
    .object({
      given: z.string().trim().min(1).max(100),
      family: z.string().trim().min(1).max(100),
      birthDate: DateSchema.describe('YYYY-MM-DD'),
      sex: z.enum(SEX).optional(),
      mobile: AuMobileSchema.optional(),
      email: EmailSchema.optional(),
      address: AddressInputSchema.optional(),
      notes: z.string().trim().max(2000).optional(),
      guardian: GuardianSchema.optional(),
      source: z.enum(SOURCE),
    })
    .strict(),
  async handler(args, ctx) {
    validateBirthDate(args.birthDate, ctx);
    const dup = await checkDuplicate(ctx.client, args);
    if (dup.verdict === 'exact') {
      throw new ToolError(
        'A patient with the same name and date of birth already exists. Use the existing record instead of creating a new one.',
        { existing: dup.candidates.filter((c) => c.match === 'exact') },
      );
    }
    const warnings: string[] = [];
    if (dup.verdict === 'likely') {
      warnings.push(
        '⚠️ LIKELY DUPLICATE: an existing patient shares the date of birth and a name or contact detail. Confirm with the user that this is a different person before committing.',
      );
    } else if (dup.verdict === 'possible') {
      warnings.push(
        'Possible duplicate: an existing patient shares some details. Review the candidates.',
      );
    }
    if (dup.note) warnings.push(dup.note);
    const age = ageOn(args.birthDate, todayInZone(ctx.config.timezone, ctx.now()));
    if (age < 18 && !args.guardian)
      warnings.push('Patient is under 18 but no guardian was provided.');
    if (!args.mobile && !args.email)
      warnings.push('No mobile or email: Halaxy reminders will not reach this patient.');
    if (args.notes) {
      warnings.push(
        'Notes are NOT written to Halaxy by this tool (no supported API field). Add them manually in Halaxy if needed.',
      );
    }
    if (args.source === 'gp_referral') {
      warnings.push(
        'Source is a GP referral: after creating the patient, add Medicare coverage and the referral.',
      );
    }
    const payload = buildPatientPayload(args);
    const preview = {
      action: 'Create new patient',
      name: `${args.given} ${args.family}`,
      birthDate: args.birthDate,
      age,
      sex: args.sex ?? null,
      mobile: args.mobile ?? null,
      email: args.email ?? null,
      address: args.address
        ? `${args.address.line}, ${args.address.suburb} ${args.address.state} ${args.address.postcode}`
        : null,
      guardian: args.guardian ?? null,
      source: args.source,
    };
    return prepared(
      ctx,
      {
        tool: 'halaxy_prepare_create_patient',
        resourceType: 'Patient',
        payload,
        async execute(body, c) {
          const res = await c.client.post('Patient', body);
          return { resourceType: 'Patient', id: createdId(res.body, res.location, 'Patient') };
        },
      },
      preview,
      warnings,
      { duplicateCheck: { verdict: dup.verdict, candidates: dup.candidates } },
    );
  },
});

interface Change {
  field: string;
  before: unknown;
  after: unknown;
}

/**
 * Build a JSON merge-patch for the changed fields only. Arrays (name, telecom, address) are
 * replaced wholesale by merge-patch, so they are rebuilt from the current record with only
 * the targeted entry changed.
 */
export function buildPatientPatch(
  current: Patient,
  changes: {
    given?: string;
    family?: string;
    birthDate?: string;
    sex?: string;
    mobile?: string;
    email?: string;
    address?: AddressInput;
  },
): { patch: Record<string, unknown>; diff: Change[] } {
  const patch: Record<string, unknown> = {};
  const diff: Change[] = [];

  if (changes.given !== undefined || changes.family !== undefined) {
    const names: HumanName[] = structuredClone(current.name ?? []);
    const official = officialName(names);
    const before = displayName(current.name);
    const next: HumanName = {
      ...(official ?? { use: 'official' }),
      ...(changes.given !== undefined ? { given: changes.given.split(/\s+/) } : {}),
      ...(changes.family !== undefined ? { family: changes.family } : {}),
    };
    delete next.text;
    const idx = official ? names.indexOf(official) : -1;
    if (idx >= 0) names[idx] = next;
    else names.unshift(next);
    const after = displayName(names);
    if (after !== before) {
      patch.name = names;
      diff.push({ field: 'name', before: before ?? null, after });
    }
  }
  if (changes.birthDate !== undefined && changes.birthDate !== current.birthDate) {
    patch.birthDate = changes.birthDate;
    diff.push({ field: 'birthDate', before: current.birthDate ?? null, after: changes.birthDate });
  }
  if (changes.sex !== undefined && changes.sex !== current.gender) {
    patch.gender = changes.sex;
    diff.push({ field: 'sex', before: current.gender ?? null, after: changes.sex });
  }

  let telecom: ContactPoint[] = structuredClone(current.telecom ?? []);
  let telecomChanged = false;
  if (changes.mobile !== undefined) {
    const before = mobiles(current.telecom)[0];
    if (before !== changes.mobile) {
      const idx = telecom.findIndex(
        (t) => t.system === 'sms' || (t.system === 'phone' && t.use === 'mobile'),
      );
      if (idx >= 0) telecom[idx] = { ...telecom[idx], ...mobileContact(changes.mobile) };
      else telecom = [mobileContact(changes.mobile), ...telecom];
      telecomChanged = true;
      diff.push({ field: 'mobile', before: before ?? null, after: changes.mobile });
    }
  }
  if (changes.email !== undefined) {
    const before = emails(current.telecom)[0];
    if (before !== changes.email) {
      const idx = telecom.findIndex((t) => t.system === 'email');
      if (idx >= 0) telecom[idx] = { ...telecom[idx], ...emailContact(changes.email) };
      else telecom.push(emailContact(changes.email));
      telecomChanged = true;
      diff.push({ field: 'email', before: before ?? null, after: changes.email });
    }
  }
  if (telecomChanged) patch.telecom = telecom;

  if (changes.address !== undefined) {
    const next = buildAddress(changes.address);
    const before = formatAddress(current.address?.[0]);
    const after = formatAddress(next);
    if (before !== after) {
      const addresses = structuredClone(current.address ?? []);
      if (addresses.length > 0) addresses[0] = { ...addresses[0], ...next };
      else addresses.push(next);
      patch.address = addresses;
      diff.push({ field: 'address', before: before ?? null, after });
    }
  }
  return { patch, diff };
}

export const prepareUpdatePatientTool = defineTool({
  name: 'halaxy_prepare_update_patient',
  title: 'Prepare: update patient',
  kind: 'write',
  description:
    "Prepares changes to an existing patient's details (does not write yet). Only the fields you pass are changed (JSON merge-patch; never a full replace). " +
    'The preview shows a before → after diff of the changed fields. ' +
    APPROVAL_NOTE +
    ' ' +
    UNTRUSTED_NOTE,
  input: z
    .object({
      id: HalaxyIdSchema,
      given: z.string().trim().min(1).max(100).optional(),
      family: z.string().trim().min(1).max(100).optional(),
      birthDate: DateSchema.optional(),
      sex: z.enum(SEX).optional(),
      mobile: AuMobileSchema.optional(),
      email: EmailSchema.optional(),
      address: AddressInputSchema.optional(),
    })
    .strict()
    .refine((v) => Object.entries(v).some(([k, x]) => k !== 'id' && x !== undefined), {
      message: 'Provide at least one field to change.',
    }),
  async handler({ id, ...changes }, ctx) {
    if (changes.birthDate) validateBirthDate(changes.birthDate, ctx);
    const current = await fetchPatient(ctx, id);
    const { patch, diff } = buildPatientPatch(current, changes);
    if (diff.length === 0)
      throw new ToolError('Nothing to change: the patient already has these values.');
    const warnings: string[] = [];
    if (patch.name || patch.birthDate) {
      warnings.push(
        'Name or date-of-birth change: confirm the identity change with the user (these affect Medicare claims).',
      );
    }
    return prepared(
      ctx,
      {
        tool: 'halaxy_prepare_update_patient',
        resourceType: 'Patient',
        payload: { id, patch },
        async execute(p, c) {
          await c.client.patch(`Patient/${encodeURIComponent(p.id)}`, p.patch);
          return { resourceType: 'Patient', id: p.id };
        },
      },
      {
        action: 'Update patient',
        patientId: id,
        patient: displayName(current.name) ?? null,
        changes: diff,
      },
      warnings,
    );
  },
});
