/**
 * Salary Calculator Tests — חוק עבודה ישראלי
 */

const { calcDailyOvertime, checkMinWage, calcDeductions } = require('../src/services/employees/salary.calculator');

describe('calcDailyOvertime', () => {
  it('8 שעות — ללא שעות נוספות', () => {
    const result = calcDailyOvertime(8, 40);
    expect(result.regular).toBe(8);
    expect(result.overtime125).toBe(0);
    expect(result.overtime150).toBe(0);
  });

  it('10 שעות — 2 שעות ב-125%', () => {
    const result = calcDailyOvertime(10, 40);
    expect(result.regular).toBe(8);
    expect(result.overtime125).toBe(2);
    expect(result.overtime150).toBe(0);
  });

  it('12 שעות — 2 שעות ב-125% + 2 שעות ב-150%', () => {
    const result = calcDailyOvertime(12, 40);
    expect(result.regular).toBe(8);
    expect(result.overtime125).toBe(2);
    expect(result.overtime150).toBe(2);
  });
});

describe('checkMinWage', () => {
  it('שכר שעתי תקין', () => {
    const result = checkMinWage('hourly', 40);
    expect(result.valid).toBe(true);
  });

  it('שכר שעתי נמוך מדי', () => {
    const result = checkMinWage('hourly', 10);
    expect(result.valid).toBe(false);
    expect(result.minRequired).toBe(33.87); // מינימום אפריל 2025
  });

  it('שכר חודשי תקין', () => {
    const result = checkMinWage('monthly', 7000);
    expect(result.valid).toBe(true);
  });

  it('שכר חודשי נמוך מדי', () => {
    const result = checkMinWage('monthly', 3000);
    expect(result.valid).toBe(false);
    expect(result.minRequired).toBe(6300.00); // מינימום חודשי אפריל 2025
  });
});

describe('calcDeductions', () => {
  it('חישוב ניכויים בסיסי', () => {
    const result = calcDeductions(7000, 2.25);
    expect(result.grossSalary).toBe(7000);
    expect(result.incomeTax).toBeGreaterThan(0);
    expect(result.nationalInsurance).toBeGreaterThan(0);
    expect(result.healthInsurance).toBeGreaterThan(0);
    expect(result.pension).toBeGreaterThan(0);
    expect(result.netSalary).toBeLessThan(7000);
    expect(result.netSalary).toBeGreaterThan(0);
  });

  it('שכר נמוך — מס הכנסה אפס', () => {
    const result = calcDeductions(2000, 2.25);
    expect(result.incomeTax).toBe(0);
  });

  it('גרוס אפס — כל ניכויים אפס', () => {
    const result = calcDeductions(0, 2.25);
    expect(result.grossSalary).toBe(0);
    expect(result.netSalary).toBe(0);
    expect(result.incomeTax).toBe(0);
  });

  it('גרוס שלילי מטופל כאפס', () => {
    const result = calcDeductions(-500, 2.25);
    expect(result.grossSalary).toBe(0);
    expect(result.netSalary).toBe(0);
  });

  it('פנסיה = 6% מהגרוס', () => {
    const result = calcDeductions(10000, 2.25);
    expect(result.pension).toBeCloseTo(600, 0);
  });

  it('שכר גבוה — מס הכנסה חיובי', () => {
    const result = calcDeductions(20000, 2.25);
    expect(result.incomeTax).toBeGreaterThan(0);
    expect(result.netSalary).toBeGreaterThan(0);
    expect(result.netSalary).toBeLessThan(result.grossSalary);
  });
});

describe('calcDailyOvertime — edge cases', () => {
  it('פחות מ-8 שעות — ללא שעות נוספות', () => {
    const result = calcDailyOvertime(6);
    expect(result.regular).toBe(6);
    expect(result.overtime125).toBe(0);
    expect(result.overtime150).toBe(0);
  });

  it('0 שעות — הכל אפס', () => {
    const result = calcDailyOvertime(0);
    expect(result.regular).toBe(0);
    expect(result.overtime125).toBe(0);
    expect(result.overtime150).toBe(0);
  });

  it('9 שעות — שעה אחת ב-125%', () => {
    const result = calcDailyOvertime(9);
    expect(result.regular).toBe(8);
    expect(result.overtime125).toBe(1);
    expect(result.overtime150).toBe(0);
  });

  it('11 שעות — 2 ב-125%, 1 ב-150%', () => {
    const result = calcDailyOvertime(11);
    expect(result.regular).toBe(8);
    expect(result.overtime125).toBe(2);
    expect(result.overtime150).toBe(1);
  });
});
