import { z } from 'zod';
import { isValidDate } from '../time.js';

// ---------- dates ----------

export const DateSchema = z
  .string()
  .trim()
  .refine(isValidDate, { message: 'Expected a real calendar date as YYYY-MM-DD' });

export const DateOrDateTimeSchema = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/, {
    message:
      'Expected YYYY-MM-DD or YYYY-MM-DDTHH:mm (practice time) or an ISO datetime with offset',
  });

// ---------- Medicare ----------

const MEDICARE_WEIGHTS = [1, 3, 7, 9, 1, 3, 7, 9];

/**
 * Validates a 10-digit Medicare card number: first digit 2–6, digit 9 is a weighted
 * checksum of digits 1–8, digit 10 is the card issue number.
 */
export function isValidMedicareNumber(value: string): boolean {
  if (!/^[2-6]\d{9}$/.test(value)) return false;
  const digits = value.split('').map(Number);
  const sum = MEDICARE_WEIGHTS.reduce((acc, w, i) => acc + w * digits[i]!, 0);
  return sum % 10 === digits[8];
}

export const MedicareNumberSchema = z
  .string()
  .transform((v) => v.replace(/[\s-]/g, ''))
  .refine((v) => /^\d{10}$/.test(v), { message: 'Medicare number must be 10 digits' })
  .refine(isValidMedicareNumber, {
    message: 'Medicare number fails the check-digit test. Re-check each digit against the card.',
  });

export const IrnSchema = z.coerce
  .number()
  .int()
  .min(1, { message: 'IRN must be 1–9' })
  .max(9, { message: 'IRN must be 1–9' });

export const MedicareExpirySchema = z
  .string()
  .trim()
  .regex(/^(0[1-9]|1[0-2])\/\d{4}$/, { message: 'Expiry must be MM/YYYY' });

/** Last day of the expiry month as YYYY-MM-DD. */
export function medicareExpiryToDate(expiry: string): string {
  const [mm, yyyy] = expiry.split('/').map(Number) as [number, number];
  const last = new Date(Date.UTC(yyyy, mm, 0)).getUTCDate();
  return `${yyyy}-${String(mm).padStart(2, '0')}-${String(last).padStart(2, '0')}`;
}

// ---------- phone ----------

export type PhoneKind = 'mobile' | 'landline' | 'international';

export interface NormalisedPhone {
  value: string;
  kind: PhoneKind;
}

/**
 * Normalise to Halaxy's compact international format (+61400000000).
 * Returns undefined if the number can't be understood.
 */
export function normalisePhone(raw: string): NormalisedPhone | undefined {
  let v = raw.trim().replace(/[\s\-().]/g, '');
  if (v.startsWith('0011')) v = '+' + v.slice(4);
  if (v.startsWith('00')) v = '+' + v.slice(2);
  let national: string | undefined;
  if (/^\+61\d+$/.test(v)) national = v.slice(3);
  else if (/^61\d{9}$/.test(v)) national = v.slice(2);
  else if (/^0\d{9}$/.test(v)) national = v.slice(1);
  else if (/^4\d{8}$/.test(v)) national = v;
  if (national !== undefined) {
    if (national.startsWith('0')) national = national.slice(1);
    if (!/^\d{9}$/.test(national)) return undefined;
    if (/^4/.test(national)) return { value: `+61${national}`, kind: 'mobile' };
    if (/^[2378]/.test(national)) return { value: `+61${national}`, kind: 'landline' };
    return undefined;
  }
  if (/^\+[1-9]\d{7,14}$/.test(v)) return { value: v, kind: 'international' };
  return undefined;
}

export const AuMobileSchema = z.string().transform((raw, ctx) => {
  const n = normalisePhone(raw);
  if (!n || n.kind !== 'mobile') {
    ctx.addIssue({
      code: 'custom',
      message: 'Expected an Australian mobile number (04xx xxx xxx)',
    });
    return z.NEVER;
  }
  return n.value;
});

export const PhoneSchema = z.string().transform((raw, ctx) => {
  const n = normalisePhone(raw);
  if (!n) {
    ctx.addIssue({ code: 'custom', message: 'Unrecognised phone number' });
    return z.NEVER;
  }
  return n.value;
});

// ---------- email ----------

export const EmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email({ message: 'Invalid email address' }));

// ---------- Medicare provider number ----------

const PLV_CHARS = '0123456789ABCDEFGHJKLMNPQRTUVWXY';
const PROVIDER_CHECK_CHARS = 'YXWTLKJHFBA';
const PROVIDER_WEIGHTS = [3, 5, 8, 4, 2, 1];

export function normaliseProviderNumber(raw: string): string {
  let v = raw.replace(/\s/g, '').toUpperCase();
  if (/^\d{5}[0-9A-Z]{2}$/.test(v)) v = '0' + v;
  return v;
}

export const ProviderNumberSchema = z
  .string()
  .transform(normaliseProviderNumber)
  .refine((v) => /^\d{6}[0-9A-HJ-NP-RT-Y][A-HJ-NP-Y]$/.test(v), {
    message:
      'Provider number must look like 2426591T (6 digits, a location character, a check letter)',
  });

/** Services Australia provider number check character. A mismatch is reported as a warning only. */
export function providerNumberCheckOk(value: string): boolean {
  const v = normaliseProviderNumber(value);
  if (v.length !== 8) return false;
  const plv = PLV_CHARS.indexOf(v[6]!);
  if (plv < 0) return false;
  const stem = v.slice(0, 6).split('').map(Number);
  const sum = PROVIDER_WEIGHTS.reduce((acc, w, i) => acc + w * stem[i]!, 0) + plv * 6;
  return PROVIDER_CHECK_CHARS[sum % 11] === v[7];
}

// ---------- ids ----------

export const HalaxyIdSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9\-.]{1,64}$/, { message: 'Expected a Halaxy id' });

export const AddressInputSchema = z
  .object({
    line: z.string().trim().min(1).max(200),
    suburb: z.string().trim().min(1).max(100),
    state: z
      .string()
      .trim()
      .toUpperCase()
      .pipe(z.enum(['NSW', 'VIC', 'QLD', 'SA', 'WA', 'TAS', 'ACT', 'NT'])),
    postcode: z
      .string()
      .trim()
      .regex(/^\d{4}$/, { message: 'Postcode must be 4 digits' }),
  })
  .strict();
export type AddressInput = z.infer<typeof AddressInputSchema>;
