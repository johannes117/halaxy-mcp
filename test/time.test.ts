import { describe, expect, it } from 'vitest';
import { formatInZone, parseTimeInput, todayInZone, zoneOffsetMinutes } from '../src/time.js';

const TZ = 'Australia/Sydney';

describe('time helpers', () => {
  it('knows Sydney DST offsets', () => {
    expect(zoneOffsetMinutes(TZ, new Date('2026-01-15T00:00:00Z'))).toBe(660);
    expect(zoneOffsetMinutes(TZ, new Date('2026-07-15T00:00:00Z'))).toBe(600);
  });
  it('formats in the practice zone with explicit offset', () => {
    expect(formatInZone(new Date('2026-02-14T22:00:00Z'), TZ)).toBe('2026-02-15T09:00:00+11:00');
    expect(formatInZone(new Date('2026-07-14T23:00:00Z'), TZ)).toBe('2026-07-15T09:00:00+10:00');
  });
  it('parses local practice times, dates and absolute times', () => {
    expect(parseTimeInput('2026-02-15T09:00', TZ).toISOString()).toBe('2026-02-14T22:00:00.000Z');
    expect(parseTimeInput('2026-07-15', TZ).toISOString()).toBe('2026-07-14T14:00:00.000Z');
    expect(formatInZone(parseTimeInput('2026-07-15', TZ, true), TZ)).toBe(
      '2026-07-15T23:59:59+10:00',
    );
    expect(parseTimeInput('2026-02-15T09:00:00Z', TZ).toISOString()).toBe(
      '2026-02-15T09:00:00.000Z',
    );
  });
  it('handles the DST transition day', () => {
    // 2026-04-05: clocks go back at 03:00 AEDT → 02:00 AEST.
    expect(formatInZone(parseTimeInput('2026-04-05T09:00', TZ), TZ)).toBe(
      '2026-04-05T09:00:00+10:00',
    );
  });
  it('rejects nonsense', () => {
    expect(() => parseTimeInput('2026-02-30', TZ)).toThrow();
    expect(() => parseTimeInput('next tuesday', TZ)).toThrow();
  });
  it('computes today in zone', () => {
    expect(todayInZone(TZ, new Date('2026-02-14T14:00:00Z'))).toBe('2026-02-15');
  });
});
