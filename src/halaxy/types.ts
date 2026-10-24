import { z } from 'zod';

/**
 * Loose zod schemas for the slices of FHIR resources this server reads. Unknown fields are
 * kept (looseObject) so Halaxy additions don't break parsing; anything we rely on is typed.
 */

export const ReferenceSchema = z.looseObject({
  reference: z.string().optional(),
  display: z.string().optional(),
  type: z.string().optional(),
});
export type Reference = z.infer<typeof ReferenceSchema>;

export const CodingSchema = z.looseObject({
  system: z.string().optional(),
  code: z.string().optional(),
  display: z.string().optional(),
});

export const HumanNameSchema = z.looseObject({
  use: z.string().optional(),
  text: z.string().optional(),
  family: z.string().optional(),
  given: z.array(z.string()).optional(),
  prefix: z.array(z.string()).optional(),
});
export type HumanName = z.infer<typeof HumanNameSchema>;

export const ContactPointSchema = z.looseObject({
  system: z.string().optional(),
  value: z.string().optional(),
  use: z.string().optional(),
});
export type ContactPoint = z.infer<typeof ContactPointSchema>;

export const AddressSchema = z.looseObject({
  use: z.string().optional(),
  text: z.string().optional(),
  line: z.array(z.string()).optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  postalCode: z.string().optional(),
  country: z.string().optional(),
});
export type Address = z.infer<typeof AddressSchema>;

const MetaSchema = z.looseObject({
  lastUpdated: z.string().optional(),
  profile: z.array(z.string()).optional(),
});

const IdentifierSchema = z.looseObject({
  system: z.string().optional(),
  value: z.string().optional(),
});

export const PatientSchema = z.looseObject({
  resourceType: z.literal('Patient').optional(),
  id: z.string(),
  meta: MetaSchema.optional(),
  name: z.array(HumanNameSchema).optional(),
  birthDate: z.string().optional(),
  gender: z.string().optional(),
  telecom: z.array(ContactPointSchema).optional(),
  address: z.array(AddressSchema).optional(),
  contact: z.array(z.looseObject({})).optional(),
});
export type Patient = z.infer<typeof PatientSchema>;

export const CoverageSchema = z.looseObject({
  id: z.string(),
  status: z.string().optional(),
  subscriberId: z.string().optional(),
  dependent: z.string().optional(),
  beneficiary: ReferenceSchema.optional(),
  payor: z.array(ReferenceSchema).optional(),
  period: z.looseObject({ start: z.string().optional(), end: z.string().optional() }).optional(),
  type: z
    .looseObject({ text: z.string().optional(), coding: z.array(CodingSchema).optional() })
    .optional(),
});
export type Coverage = z.infer<typeof CoverageSchema>;

export const ParticipantSchema = z.looseObject({
  actor: ReferenceSchema.optional(),
  status: z.string().optional(),
  modifierExtension: z
    .array(z.looseObject({ url: z.string().optional(), valueCoding: CodingSchema.optional() }))
    .optional(),
});

export const AppointmentSchema = z.looseObject({
  id: z.string().optional(),
  status: z.string().optional(),
  start: z.string().optional(),
  end: z.string().optional(),
  minutesDuration: z.number().optional(),
  description: z.string().optional(),
  comment: z.string().optional(),
  participant: z.array(ParticipantSchema).optional(),
  serviceType: z
    .array(z.looseObject({ text: z.string().optional(), coding: z.array(CodingSchema).optional() }))
    .optional(),
});
export type Appointment = z.infer<typeof AppointmentSchema>;

export const PractitionerRoleSchema = z.looseObject({
  id: z.string(),
  meta: MetaSchema.optional(),
  active: z.boolean().optional(),
  practitioner: ReferenceSchema.optional(),
  organization: ReferenceSchema.optional(),
  identifier: z.array(IdentifierSchema).optional(),
  telecom: z.array(ContactPointSchema).optional(),
});
export type PractitionerRole = z.infer<typeof PractitionerRoleSchema>;

export const PractitionerSchema = z.looseObject({
  id: z.string(),
  name: z.array(HumanNameSchema).optional(),
});
export type Practitioner = z.infer<typeof PractitionerSchema>;

export const OrganizationSchema = z.looseObject({
  id: z.string(),
  name: z.string().optional(),
});
export type Organization = z.infer<typeof OrganizationSchema>;

export const HealthcareServiceSchema = z.looseObject({
  id: z.string(),
  name: z.string().optional(),
  active: z.boolean().optional(),
  extension: z.array(z.looseObject({ url: z.string().optional() })).optional(),
});
export type HealthcareService = z.infer<typeof HealthcareServiceSchema>;

export const ReferralSchema = z.looseObject({
  id: z.string(),
  coverage: ReferenceSchema.optional(),
  subject: ReferenceSchema.optional(),
  requester: ReferenceSchema.optional(),
  created: z.string().optional(),
  active: z.boolean().optional(),
  comment: z.string().optional(),
  attachments: z.array(z.looseObject({})).optional(),
});
export type Referral = z.infer<typeof ReferralSchema>;

export class UnexpectedResponseError extends Error {
  constructor(what: string) {
    super(
      `Halaxy returned an unexpected ${what} shape. The API may have changed; please report this (without patient data).`,
    );
    this.name = 'UnexpectedResponseError';
  }
}

export function parseAs<S extends z.ZodType>(schema: S, value: unknown, what: string): z.infer<S> {
  const result = schema.safeParse(value);
  if (!result.success) throw new UnexpectedResponseError(what);
  return result.data;
}

/** Parse each item, silently dropping ones that don't fit (e.g. OperationOutcome entries). */
export function parseEach<S extends z.ZodType>(schema: S, values: unknown[]): z.infer<S>[] {
  const out: z.infer<S>[] = [];
  for (const v of values) {
    const r = schema.safeParse(v);
    if (r.success) out.push(r.data);
  }
  return out;
}
