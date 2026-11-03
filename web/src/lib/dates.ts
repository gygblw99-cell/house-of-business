/**
 * Calendar-date helpers pinned to Israel time.
 *
 * `new Date().toISOString().slice(0, 10)` returns the UTC date, which is not the
 * date the user is living in. Israel runs UTC+2 (IST) or UTC+3 (IDT), so between
 * midnight and 02:00/03:00 local the UTC date is still yesterday.
 *
 * That window is exactly when a restaurant does its end-of-night work. The
 * inventory waste form defaulted to the UTC date and capped its date picker at
 * it, so a kitchen closing at 01:00 got yesterday pre-filled and could not
 * select the day it was actually standing in.
 *
 * `en-CA` is used because it formats as YYYY-MM-DD, which is what every date
 * input and every API query parameter in this app expects.
 */

const IL = 'Asia/Jerusalem';

/** Today's calendar date in Israel, as YYYY-MM-DD. */
export function todayIL(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: IL });
}

/** A Date's calendar date in Israel, as YYYY-MM-DD. */
export function toILDate(d: Date): string {
  return d.toLocaleDateString('en-CA', { timeZone: IL });
}

/**
 * The Israel calendar date `days` before today, as YYYY-MM-DD.
 *
 * Shifting by whole days of milliseconds and then formatting in Israel time is
 * correct across a DST boundary: the instant moves by exactly 24h per day and
 * the formatter resolves whatever offset applies on the target date.
 */
export function daysAgoIL(days: number): string {
  return toILDate(new Date(Date.now() - days * 86_400_000));
}

/** The Israel calendar date `days` after today, as YYYY-MM-DD. */
export function daysAheadIL(days: number): string {
  return toILDate(new Date(Date.now() + days * 86_400_000));
}

/** Offsets a YYYY-MM-DD string by whole days without going through a timezone. */
export function shiftDateStr(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d) + days * 86_400_000);
  return t.toISOString().slice(0, 10);
}

/** Day of week for a YYYY-MM-DD string, 0 = Sunday. Timezone-independent. */
export function dayOfWeekStr(dateStr: string): number {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/**
 * Sunday of the current week in Israel, as YYYY-MM-DD.
 *
 * The Israeli work week starts on Sunday, so this is the natural "this week"
 * boundary for reports. Derived from the Israel calendar date rather than from a
 * local Date, so it doesn't drift for a user whose device sits in another zone.
 */
export function startOfWeekIL(): string {
  const today = todayIL();
  return shiftDateStr(today, -dayOfWeekStr(today));
}
