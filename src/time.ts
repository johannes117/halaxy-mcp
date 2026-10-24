/** Timezone helpers built on Intl, so no tz database dependency is needed. */

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const LOCAL_DT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;
const ABS_DT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

export function isValidDate(value: string): boolean {
  const m = DATE_RE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

/** Offset of `zone` from UTC at `date`, in minutes (e.g. +660 for AEDT). */
export function zoneOffsetMinutes(zone: string, date: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' })
    .formatToParts(date)
    .find((p) => p.type === 'timeZoneName')?.value;
  if (!parts || parts === 'GMT') return 0;
  const m = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(parts);
  if (!m) return 0;
  const sign = m[1] === '-' ? -1 : 1;
  return sign * (Number(m[2]) * 60 + Number(m[3] ?? 0));
}

function pad(n: number, w = 2): string {
  return String(Math.abs(n)).padStart(w, '0');
}

function formatOffset(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+';
  return `${sign}${pad(Math.trunc(Math.abs(minutes) / 60))}:${pad(Math.abs(minutes) % 60)}`;
}

/** ISO 8601 in the practice zone with an explicit offset, e.g. 2026-02-15T09:00:00+11:00. */
export function formatInZone(date: Date, zone: string): string {
  const offset = zoneOffsetMinutes(zone, date);
  const local = new Date(date.getTime() + offset * 60_000);
  return (
    `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}` +
    `T${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}` +
    formatOffset(offset)
  );
}

/** Convert a wall-clock time in `zone` to an absolute Date. */
export function zonedToDate(
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
  s: number,
  zone: string,
): Date {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  const off1 = zoneOffsetMinutes(zone, new Date(guess));
  let t = guess - off1 * 60_000;
  const off2 = zoneOffsetMinutes(zone, new Date(t));
  if (off2 !== off1) t = guess - off2 * 60_000;
  return new Date(t);
}

export class TimeInputError extends Error {}

/**
 * Accepts `YYYY-MM-DD`, a local `YYYY-MM-DDTHH:mm[:ss]` (interpreted in the practice zone),
 * or an absolute ISO datetime with `Z`/offset. Dates resolve to start of day, or end of day
 * when `endOfDay` is set.
 */
export function parseTimeInput(value: string, zone: string, endOfDay = false): Date {
  const date = DATE_RE.exec(value);
  if (date) {
    if (!isValidDate(value)) throw new TimeInputError(`Invalid date: ${value}`);
    const [y, mo, d] = [Number(date[1]), Number(date[2]), Number(date[3])];
    return endOfDay
      ? zonedToDate(y, mo, d, 23, 59, 59, zone)
      : zonedToDate(y, mo, d, 0, 0, 0, zone);
  }
  const local = LOCAL_DT_RE.exec(value);
  if (local) {
    if (!isValidDate(value.slice(0, 10))) throw new TimeInputError(`Invalid date: ${value}`);
    const [h, mi, s] = [Number(local[4]), Number(local[5]), Number(local[6] ?? 0)];
    if (h > 23 || mi > 59 || s > 59) throw new TimeInputError(`Invalid time: ${value}`);
    return zonedToDate(Number(local[1]), Number(local[2]), Number(local[3]), h, mi, s, zone);
  }
  if (ABS_DT_RE.test(value)) {
    const dt = new Date(value);
    if (!Number.isNaN(dt.getTime())) return dt;
  }
  throw new TimeInputError(
    `Unrecognised date/time "${value}". Use YYYY-MM-DD or YYYY-MM-DDTHH:mm (practice time).`,
  );
}

/** Today's date (YYYY-MM-DD) in the given zone. */
export function todayInZone(zone: string, now = new Date()): string {
  return formatInZone(now, zone).slice(0, 10);
}

/** Render a Halaxy datetime string in the practice zone; passes through if unparseable. */
export function toZone(value: string | undefined, zone: string): string | undefined {
  if (!value) return undefined;
  const dt = new Date(value);
  return Number.isNaN(dt.getTime()) ? value : formatInZone(dt, zone);
}
