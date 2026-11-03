import { todayIL, toILDate, daysAgoIL, daysAheadIL, shiftDateStr, dayOfWeekStr, startOfWeekIL } from './dates';

describe('Israel calendar dates', () => {
  // The bug these helpers exist for: at 01:00 Israel time the UTC date is still
  // the previous day, so a kitchen closing after midnight got yesterday.
  test('01:00 Israel time resolves to the Israel day, not the UTC day', () => {
    // 2026-09-19T22:00Z === 01:00 on 2026-09-20 in Israel (IDT, UTC+3)
    const instant = new Date('2026-09-19T22:00:00Z');
    expect(instant.toISOString().slice(0, 10)).toBe('2026-09-19'); // what the old code produced
    expect(toILDate(instant)).toBe('2026-09-20');                  // what the user is living in
  });

  test('handles winter time (UTC+2) as well', () => {
    // 2026-01-15T22:30Z === 00:30 on 2026-01-16 in Israel (IST, UTC+2)
    expect(toILDate(new Date('2026-01-15T22:30:00Z'))).toBe('2026-01-16');
  });

  test('midday is unaffected', () => {
    expect(toILDate(new Date('2026-09-19T09:00:00Z'))).toBe('2026-09-19');
  });

  test('todayIL returns a YYYY-MM-DD string', () => {
    expect(todayIL()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test('daysAgoIL and daysAheadIL are symmetric around today', () => {
    expect(daysAgoIL(0)).toBe(todayIL());
    expect(shiftDateStr(daysAgoIL(7), 7)).toBe(todayIL());
    expect(shiftDateStr(daysAheadIL(3), -3)).toBe(todayIL());
  });

  describe('shiftDateStr', () => {
    test('crosses a month boundary', () => {
      expect(shiftDateStr('2026-03-01', -1)).toBe('2026-02-28');
      expect(shiftDateStr('2026-01-31', 1)).toBe('2026-02-01');
    });
    test('crosses a year boundary', () => {
      expect(shiftDateStr('2026-01-01', -1)).toBe('2025-12-31');
      expect(shiftDateStr('2026-12-31', 1)).toBe('2027-01-01');
    });
    test('handles a leap year', () => {
      expect(shiftDateStr('2028-02-28', 1)).toBe('2028-02-29');
      expect(shiftDateStr('2028-03-01', -1)).toBe('2028-02-29');
    });
    test('is stable across the Israeli DST change', () => {
      // DST shifts the clock, never the calendar date arithmetic.
      expect(shiftDateStr('2026-03-27', 1)).toBe('2026-03-28');
      expect(shiftDateStr('2026-10-25', 1)).toBe('2026-10-26');
    });
  });

  describe('dayOfWeekStr', () => {
    test('0 is Sunday', () => {
      expect(dayOfWeekStr('2026-09-20')).toBe(0); // a Sunday
      expect(dayOfWeekStr('2026-09-21')).toBe(1);
      expect(dayOfWeekStr('2026-09-26')).toBe(6); // Saturday
    });
  });

  test('startOfWeekIL lands on a Sunday at or before today', () => {
    const sunday = startOfWeekIL();
    expect(dayOfWeekStr(sunday)).toBe(0);
    expect(sunday <= todayIL()).toBe(true);
    // never more than 6 days back
    expect(shiftDateStr(sunday, 7) > todayIL()).toBe(true);
  });
});
