/**
 * Validation Schema Unit Tests — covers all Zod schemas in validateInput.js.
 * Pure unit tests — no HTTP, no DB mock needed.
 */

const { validate, schemas } = require('../src/middleware/validateInput');

// ── Helper ────────────────────────────────────────────────────────────────────
const mockRes = () => {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json   = jest.fn().mockReturnValue(res);
  return res;
};

const runValidate = (schema, bodyData) => {
  const middleware = validate({ body: schema });
  const req  = { body: bodyData };
  const res  = mockRes();
  const next = jest.fn();
  middleware(req, res, next);
  return { req, res, next };
};

// ── registerSchema ────────────────────────────────────────────────────────────
describe('registerSchema', () => {
  const valid = {
    name: 'ישראל ישראלי',
    businessName: 'מסעדת הגן',
    businessType: 'restaurant',
    email: 'owner@example.com',
    password: 'securePass123',
  };

  it('קלט תקין — עובר ומוסיף לreq.body', () => {
    const { next, req } = runValidate(schemas.registerSchema, valid);
    expect(next).toHaveBeenCalled();
    expect(req.body.email).toBe('owner@example.com');
  });

  it('שדות לא ידועים נמחקים (strip)', () => {
    const { next, req } = runValidate(schemas.registerSchema, { ...valid, adminFlag: true, __proto__: {} });
    expect(next).toHaveBeenCalled();
    expect(req.body.adminFlag).toBeUndefined();
  });

  it('מייל לא תקין → 400', () => {
    const { res, next } = runValidate(schemas.registerSchema, { ...valid, email: 'not-email' });
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('מייל ארוך מ-254 תווים → 400', () => {
    const { res } = runValidate(schemas.registerSchema, { ...valid, email: 'a'.repeat(250) + '@x.co' });
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('סיסמה פחות מ-8 תווים → 400', () => {
    const { res } = runValidate(schemas.registerSchema, { ...valid, password: 'short7' });
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('סיסמה בדיוק 8 תווים → עוברת', () => {
    const { next } = runValidate(schemas.registerSchema, { ...valid, password: 'exactly8' });
    expect(next).toHaveBeenCalled();
  });

  it('businessType לא ברשימה → 400', () => {
    const { res } = runValidate(schemas.registerSchema, { ...valid, businessType: 'HOSPITAL' });
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it.each(['restaurant', 'cafe', 'bar', 'bakery', 'other'])('businessType="%s" → תקין', (type) => {
    const { next } = runValidate(schemas.registerSchema, { ...valid, businessType: type });
    expect(next).toHaveBeenCalled();
  });

  it('שם עסק חסר → 400', () => {
    const { res } = runValidate(schemas.registerSchema, { ...valid, businessName: '' });
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('שם עסק ארוך מ-100 תווים → 400', () => {
    const { res } = runValidate(schemas.registerSchema, { ...valid, businessName: 'א'.repeat(101) });
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('phone אופציונלי — ניתן להשמיט', () => {
    const { businessName, name, businessType, email, password } = valid;
    const { next } = runValidate(schemas.registerSchema, { name, businessName, businessType, email, password });
    expect(next).toHaveBeenCalled();
  });
});

// ── loginOwnerSchema ──────────────────────────────────────────────────────────
describe('loginOwnerSchema', () => {
  const valid = { username: 'owner_user', password: 'anyPass1' };

  it('קלט תקין → עובר', () => {
    const { next } = runValidate(schemas.loginOwnerSchema, valid);
    expect(next).toHaveBeenCalled();
  });

  it('שם משתמש חסר → 400', () => {
    const { res } = runValidate(schemas.loginOwnerSchema, { password: 'abc' });
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('סיסמה חסרה → 400', () => {
    const { res } = runValidate(schemas.loginOwnerSchema, { username: 'owner_user' });
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('totpCode אופציונלי — ניתן להשמיט', () => {
    const { next } = runValidate(schemas.loginOwnerSchema, valid);
    expect(next).toHaveBeenCalled();
  });

  it('totpCode שאינו 6 תווים → 400', () => {
    const { res } = runValidate(schemas.loginOwnerSchema, { ...valid, totpCode: '12345' });
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('totpCode בדיוק 6 תווים → עובר', () => {
    const { next } = runValidate(schemas.loginOwnerSchema, { ...valid, totpCode: '123456' });
    expect(next).toHaveBeenCalled();
  });
});

// ── createTaskSchema ──────────────────────────────────────────────────────────
describe('createTaskSchema', () => {
  it('קלט מינימלי (title בלבד) → עובר', () => {
    const { next } = runValidate(schemas.createTaskSchema, { title: 'משימה חדשה' });
    expect(next).toHaveBeenCalled();
  });

  it('title חסר → 400', () => {
    const { res } = runValidate(schemas.createTaskSchema, { priority: 'high' });
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('priority לא ברשימה → 400', () => {
    const { res } = runValidate(schemas.createTaskSchema, { title: 'משימה', priority: 'CRITICAL' });
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it.each(['low', 'normal', 'high', 'urgent'])('priority="%s" → תקין', (p) => {
    const { next } = runValidate(schemas.createTaskSchema, { title: 'משימה', priority: p });
    expect(next).toHaveBeenCalled();
  });

  it('priority ברירת מחדל normal — לא נדרש', () => {
    const { next, req } = runValidate(schemas.createTaskSchema, { title: 'משימה' });
    expect(next).toHaveBeenCalled();
    expect(req.body.priority).toBe('normal');
  });

  it('assignedTo לא UUID → 400', () => {
    const { res } = runValidate(schemas.createTaskSchema, { title: 'משימה', assignedTo: 'not-a-uuid' });
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('assignedTo UUID תקין → עובר', () => {
    const { next } = runValidate(schemas.createTaskSchema, {
      title: 'משימה',
      assignedTo: '550e8400-e29b-41d4-a716-446655440000',
    });
    expect(next).toHaveBeenCalled();
  });

  it('subtasks מערך מחרוזות → עובר', () => {
    const { next, req } = runValidate(schemas.createTaskSchema, {
      title: 'משימה', subtasks: ['שלב א', 'שלב ב'],
    });
    expect(next).toHaveBeenCalled();
    expect(req.body.subtasks).toEqual(['שלב א', 'שלב ב']);
  });
});

// ── createQueueEntrySchema ────────────────────────────────────────────────────
describe('createQueueEntrySchema', () => {
  const valid = { name: 'ישראל', phone: '052-1234567', party_size: 2 };

  it('קלט תקין → עובר', () => {
    const { next } = runValidate(schemas.createQueueEntrySchema, valid);
    expect(next).toHaveBeenCalled();
  });

  it('party_size > 50 → 400', () => {
    const { res } = runValidate(schemas.createQueueEntrySchema, { ...valid, party_size: 51 });
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('party_size = 50 → עובר', () => {
    const { next } = runValidate(schemas.createQueueEntrySchema, { ...valid, party_size: 50 });
    expect(next).toHaveBeenCalled();
  });

  it('party_size = 0 → 400', () => {
    const { res } = runValidate(schemas.createQueueEntrySchema, { ...valid, party_size: 0 });
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('party_size לא מספר שלם → 400', () => {
    const { res } = runValidate(schemas.createQueueEntrySchema, { ...valid, party_size: 2.5 });
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('phone פורמט לא תקין → 400', () => {
    const { res } = runValidate(schemas.createQueueEntrySchema, { ...valid, phone: 'abc' });
    expect(res.status).toHaveBeenCalledWith(400);
  });
});

// ── analyzeReviewsSchema ──────────────────────────────────────────────────────
describe('analyzeReviewsSchema', () => {
  const valid = { platform: 'google', text: 'ביקורת מצוינת מאוד' };

  it('קלט תקין → עובר', () => {
    const { next } = runValidate(schemas.analyzeReviewsSchema, valid);
    expect(next).toHaveBeenCalled();
  });

  it.each(['google', 'tripadvisor', 'wolt', 'tenbis', 'mishloha', 'facebook', 'other'])('platform="%s" → תקין', (p) => {
    const { next } = runValidate(schemas.analyzeReviewsSchema, { ...valid, platform: p });
    expect(next).toHaveBeenCalled();
  });

  it('platform לא ברשימה → 400', () => {
    const { res } = runValidate(schemas.analyzeReviewsSchema, { platform: 'INVALID', text: 'ביקורת' });
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('טקסט קצר מ-10 תווים → 400', () => {
    const { res } = runValidate(schemas.analyzeReviewsSchema, { platform: 'google', text: 'קצר' });
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('טקסט ארוך מ-20000 תווים → 400', () => {
    const { res } = runValidate(schemas.analyzeReviewsSchema, { platform: 'google', text: 'א'.repeat(20001) });
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('טקסט בדיוק 20000 תווים → עובר', () => {
    const { next } = runValidate(schemas.analyzeReviewsSchema, { platform: 'google', text: 'א'.repeat(20000) });
    expect(next).toHaveBeenCalled();
  });
});

// ── createExpenseSchema ───────────────────────────────────────────────────────
describe('createExpenseSchema', () => {
  const valid = { amount: 150.5, category: 'ספקים' };

  it('קלט תקין → עובר', () => {
    const { next } = runValidate(schemas.createExpenseSchema, valid);
    expect(next).toHaveBeenCalled();
  });

  it('amount = 0 → 400 (מינימום 0.01)', () => {
    const { res } = runValidate(schemas.createExpenseSchema, { ...valid, amount: 0 });
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('amount שלילי → 400', () => {
    const { res } = runValidate(schemas.createExpenseSchema, { ...valid, amount: -1 });
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('category לא ברשימה → 400', () => {
    const { res } = runValidate(schemas.createExpenseSchema, { ...valid, category: 'UNKNOWN' });
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it.each(['שכר', 'ספקים', 'שכירות', 'ציוד', 'שיווק', 'אחר'])('category="%s" → תקין', (cat) => {
    const { next } = runValidate(schemas.createExpenseSchema, { ...valid, category: cat });
    expect(next).toHaveBeenCalled();
  });

  it('category ברירת מחדל "אחר"', () => {
    const { next, req } = runValidate(schemas.createExpenseSchema, { amount: 50 });
    expect(next).toHaveBeenCalled();
    expect(req.body.category).toBe('אחר');
  });
});

// ── logVisitSchema ────────────────────────────────────────────────────────────
describe('logVisitSchema', () => {
  it('amount תקין → עובר', () => {
    const { next } = runValidate(schemas.logVisitSchema, { amount: 120 });
    expect(next).toHaveBeenCalled();
  });

  it('amount שלילי → 400', () => {
    const { res } = runValidate(schemas.logVisitSchema, { amount: -5 });
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('amount > 99999 → 400', () => {
    const { res } = runValidate(schemas.logVisitSchema, { amount: 100000 });
    expect(res.status).toHaveBeenCalledWith(400);
  });
});

// ── uuidSchema ────────────────────────────────────────────────────────────────
describe('uuidSchema', () => {
  const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000';

  it('UUID תקין → עובר', () => {
    expect(schemas.uuidSchema.safeParse(VALID_UUID).success).toBe(true);
  });

  it('UUID v4 מלא → עובר', () => {
    expect(schemas.uuidSchema.safeParse('123e4567-e89b-12d3-a456-426614174000').success).toBe(true);
  });

  it('מחרוזת רנדומלית → נכשל', () => {
    expect(schemas.uuidSchema.safeParse('not-a-uuid').success).toBe(false);
  });

  it('מספר → נכשל', () => {
    expect(schemas.uuidSchema.safeParse(12345).success).toBe(false);
  });

  it('מחרוזת ריקה → נכשל', () => {
    expect(schemas.uuidSchema.safeParse('').success).toBe(false);
  });

  it('SQL injection → נכשל', () => {
    expect(schemas.uuidSchema.safeParse("' OR 1=1 --").success).toBe(false);
  });
});

// ── validate middleware response shape ────────────────────────────────────────
describe('validate middleware — response shape', () => {
  it('שגיאת validation מחזירה { error, details }', () => {
    const { res } = runValidate(schemas.registerSchema, { email: 'bad' });
    const jsonCall = res.json.mock.calls[0][0];
    expect(jsonCall).toHaveProperty('error');
    expect(jsonCall).toHaveProperty('details');
    expect(Array.isArray(jsonCall.details)).toBe(true);
  });

  it('details מכיל field ו-message לכל שגיאה', () => {
    const { res } = runValidate(schemas.registerSchema, { email: 'bad', password: 'x' });
    const { details } = res.json.mock.calls[0][0];
    details.forEach(d => {
      expect(d).toHaveProperty('field');
      expect(d).toHaveProperty('message');
    });
  });
});
