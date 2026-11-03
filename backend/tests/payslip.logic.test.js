/**
 * Salary Calculator + Deductions — Unit Tests
 * Pure functions, no DB or network needed.
 */

const { calcMonthlySalary, calcDeductions, calcLeaveAccrual } = require('../src/services/employees/salary.calculator');

// Helper: build a shift from (startHour, endHour) on 2026-01-15
function makeShift(startHour, endHour, dayOffset = 0) {
  const base = new Date('2026-01-15T00:00:00.000Z');
  const s = new Date(base.getTime() + dayOffset * 86_400_000);
  s.setUTCHours(startHour, 0, 0, 0);
  const e = new Date(s);
  e.setUTCHours(endHour, 0, 0, 0);
  return { actual_start: s.toISOString(), actual_end: e.toISOString() };
}

describe('calcMonthlySalary', () => {
  const rate = 40; // ₪40/hour

  it('ללא משמרות → 0 שעות, 0 שכר', () => {
    const r = calcMonthlySalary([], rate);
    expect(r.regularHours).toBe(0);
    expect(r.grossSalary).toBe(0);
  });

  it('משמרת חסרת actual_start/end → מדולגת', () => {
    const r = calcMonthlySalary([{ note: 'missing times' }], rate);
    expect(r.regularHours).toBe(0);
  });

  it('משמרת 8 שעות → 8 שעות רגילות, 0 נוספות', () => {
    const r = calcMonthlySalary([makeShift(8, 16)], rate); // 8h
    expect(r.regularHours).toBe(8);
    expect(r.overtime125).toBe(0);
    expect(r.overtime150).toBe(0);
    expect(r.grossSalary).toBeCloseTo(320); // 8 * 40
  });

  it('משמרת 10 שעות → 8 רגילות + 2 × 125%', () => {
    const r = calcMonthlySalary([makeShift(8, 18)], rate); // 10h
    expect(r.regularHours).toBe(8);
    expect(r.overtime125).toBe(2);
    expect(r.overtime150).toBe(0);
    // gross = 8*40 + 2*40*1.25 = 320+100 = 420
    expect(r.grossSalary).toBeCloseTo(420);
  });

  it('משמרת 12 שעות → 8 רגילות + 2×125% + 2×150%', () => {
    const r = calcMonthlySalary([makeShift(6, 18)], rate); // 12h
    expect(r.regularHours).toBe(8);
    expect(r.overtime125).toBe(2);
    expect(r.overtime150).toBe(2);
    // gross = 8*40 + 2*40*1.25 + 2*40*1.5 = 320+100+120 = 540
    expect(r.grossSalary).toBeCloseTo(540);
  });

  it('כמה משמרות → שעות מצטברות', () => {
    const shifts = [
      makeShift(8, 16, 0),  // 8h → 8 regular
      makeShift(8, 18, 1),  // 10h → 8 regular + 2 OT125
      makeShift(8, 16, 2),  // 8h → 8 regular
    ];
    const r = calcMonthlySalary(shifts, rate);
    expect(r.regularHours).toBe(24);
    expect(r.overtime125).toBe(2);
  });

  it('משמרת שלילית (end < start) → מדולגת', () => {
    const bad = { actual_start: '2026-01-15T18:00:00Z', actual_end: '2026-01-15T08:00:00Z' };
    const r = calcMonthlySalary([bad], rate);
    expect(r.regularHours).toBe(0);
  });

  it('משמרת > 24 שעות → מדולגת', () => {
    const big = { actual_start: '2026-01-15T00:00:00Z', actual_end: '2026-01-17T00:00:00Z' };
    const r = calcMonthlySalary([big], rate);
    expect(r.regularHours).toBe(0);
  });
});

describe('calcDeductions', () => {
  it('שכר 0 → כל הניכויים 0', () => {
    const r = calcDeductions(0, 2.25);
    expect(r.incomeTax).toBe(0);
    expect(r.nationalInsurance).toBe(0);
    expect(r.netSalary).toBe(0);
  });

  it('netSalary = grossSalary − ∑ניכויים', () => {
    const gross = 10000;
    const r = calcDeductions(gross, 2.25);
    const total = r.incomeTax + r.nationalInsurance + r.healthInsurance + r.pension;
    expect(r.netSalary).toBeCloseTo(gross - total, 0);
  });

  it('netSalary > 0 ו- < grossSalary', () => {
    const r = calcDeductions(8000, 2.25);
    expect(r.netSalary).toBeGreaterThan(0);
    expect(r.netSalary).toBeLessThan(8000);
  });

  it('נקודות זיכוי גבוהות → מס הכנסה נמוך יותר', () => {
    const low  = calcDeductions(8000, 0);
    const high = calcDeductions(8000, 6);
    expect(high.incomeTax).toBeLessThanOrEqual(low.incomeTax);
  });

  it('שכר מינימום ישראלי (6300 ₪) → netSalary > 5000', () => {
    const r = calcDeductions(6300, 2.25);
    expect(r.netSalary).toBeGreaterThan(5000);
  });

  it('שכר גבוה (30000 ₪) → מס הכנסה חיובי', () => {
    const r = calcDeductions(30000, 2.25);
    expect(r.incomeTax).toBeGreaterThan(0);
  });

  it('ביטוח לאומי ובריאות חיוביים', () => {
    const r = calcDeductions(8000, 2.25);
    expect(r.nationalInsurance).toBeGreaterThan(0);
    expect(r.healthInsurance).toBeGreaterThan(0);
  });

  it('פנסיה חיובית (6%)', () => {
    const r = calcDeductions(10000, 2.25);
    expect(r.pension).toBeCloseTo(600, 0); // ~6%
  });
});

describe('calcLeaveAccrual', () => {
  it('0 חודשים → 0 ימי חופשה + חולי', () => {
    const r = calcLeaveAccrual(0);
    expect(r.vacationDaysAccrued).toBe(0);
    expect(r.sickDaysAccrued).toBeDefined();
  });

  it('12 חודשים → לפחות יום חופשה אחד', () => {
    const r = calcLeaveAccrual(12);
    expect(r.vacationDaysAccrued).toBeGreaterThan(0);
  });

  it('ותק רב → יותר ימי חופשה מותיק מזוטר', () => {
    const junior = calcLeaveAccrual(6);
    const senior = calcLeaveAccrual(72); // 6 years
    expect(senior.vacationDaysAccrued).toBeGreaterThanOrEqual(junior.vacationDaysAccrued);
  });

  it('חולה — sickDaysAccrued מוגדר', () => {
    const r = calcLeaveAccrual(24);
    expect(typeof r.sickDaysAccrued).toBe('number');
  });
});
