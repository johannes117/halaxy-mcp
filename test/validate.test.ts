import { describe, expect, it } from 'vitest';
import {
  AuMobileSchema,
  DateSchema,
  EmailSchema,
  MedicareNumberSchema,
  isValidMedicareNumber,
  medicareExpiryToDate,
  normalisePhone,
  providerNumberCheckOk,
  ProviderNumberSchema,
} from '../src/safety/validate.js';
import { TEST_MEDICARE } from './helpers.js';

describe('Medicare validation', () => {
  it('accepts a number with a valid check digit', () => {
    expect(isValidMedicareNumber(TEST_MEDICARE)).toBe(true);
    expect(MedicareNumberSchema.parse('2123 45670 1')).toBe(TEST_MEDICARE);
  });
  it('rejects a bad check digit, wrong length or bad first digit', () => {
    expect(isValidMedicareNumber('2123456711')).toBe(false);
    expect(isValidMedicareNumber('212345670')).toBe(false);
    expect(isValidMedicareNumber('1123456701')).toBe(false);
    expect(MedicareNumberSchema.safeParse('2123456711').success).toBe(false);
  });
  it('computes expiry as the last day of the month', () => {
    expect(medicareExpiryToDate('02/2028')).toBe('2028-02-29');
    expect(medicareExpiryToDate('11/2027')).toBe('2027-11-30');
  });
});

describe('phone normalisation', () => {
  it.each([
    ['0400 000 001', '+61400000001', 'mobile'],
    ['+61 400 000 001', '+61400000001', 'mobile'],
    ['61400000001', '+61400000001', 'mobile'],
    ['(02) 9000 0000', '+61290000000', 'landline'],
    ['+610400000001', '+61400000001', 'mobile'],
    ['0011 64 21 000 0000', '+64210000000', 'international'],
  ])('%s → %s', (input, value, kind) => {
    expect(normalisePhone(input)).toEqual({ value, kind });
  });
  it('rejects junk', () => {
    expect(normalisePhone('12345')).toBeUndefined();
    expect(normalisePhone('0100000000')).toBeUndefined();
  });
  it('AU mobile schema refuses landlines', () => {
    expect(AuMobileSchema.parse('0400000001')).toBe('+61400000001');
    expect(AuMobileSchema.safeParse('0290000000').success).toBe(false);
  });
});

describe('dates and email', () => {
  it('requires real YYYY-MM-DD dates', () => {
    expect(DateSchema.safeParse('2000-01-01').success).toBe(true);
    expect(DateSchema.safeParse('2001-02-29').success).toBe(false);
    expect(DateSchema.safeParse('01/01/2000').success).toBe(false);
  });
  it('lowercases and validates email', () => {
    expect(EmailSchema.parse(' Test@Example.COM ')).toBe('test@example.com');
    expect(EmailSchema.safeParse('not-an-email').success).toBe(false);
  });
});

describe('provider numbers', () => {
  it('normalises and validates format', () => {
    expect(ProviderNumberSchema.parse('242659 1t')).toBe('2426591T');
    expect(ProviderNumberSchema.safeParse('ABC').success).toBe(false);
  });
  it('checks the check character', () => {
    expect(providerNumberCheckOk('2426591T')).toBe(true);
    expect(providerNumberCheckOk('2426591A')).toBe(false);
  });
});
