/**
 * AI Orchestrator — Tier Routing Tests
 * מוק את שירותי ה-AI ומוודא שהניתוב נכון לפי הציון
 */

jest.mock('../src/utils/db', () => ({
  query:   jest.fn().mockResolvedValue({ rows: [] }),
  migrate: jest.fn(),
}));
jest.mock('../src/services/ai/grokService');
jest.mock('../src/services/ai/geminiService');
jest.mock('../src/services/ai/responseValidator');

const grokService      = require('../src/services/ai/grokService');
const geminiService    = require('../src/services/ai/geminiService');
const { validate }     = require('../src/services/ai/responseValidator');
const { route }        = require('../src/services/ai/aiOrchestrator.service');

const BIZ_ID  = 'biz-123';
const USER_ID = 'user-456';

const mockGroqOk = { text: 'תשובת Groq', tokensUsed: 100, costUsd: 0, responseTimeMs: 200 };
const mockGemOk  = { text: 'תשובת Gemini', tokensUsed: 150, costUsd: 0.001, responseTimeMs: 300 };

function makeBase(overrides = {}) {
  return {
    message:       'שאלה פשוטה',
    systemPrompt:  'sys',
    messages:      [{ role: 'user', content: 'שאלה פשוטה' }],
    claudeCallFn:  jest.fn().mockResolvedValue({ text: 'תשובת Claude', tokensUsed: 200, costUsd: 0.01 }),
    businessId:    BIZ_ID,
    userId:        USER_ID,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  grokService.chat   = jest.fn().mockResolvedValue(mockGroqOk);
  geminiService.chat = jest.fn().mockResolvedValue(mockGemOk);
  validate.mockReturnValue({ acceptable: true });
});

describe('Tier 1 — Groq בלבד (ציון ≤ 35)', () => {
  it('מחזיר תשובת Groq כשהציון נמוך', async () => {
    // שאלה קצרה וכללית — ציון נמוך
    const result = await route(makeBase({ message: 'שלום', userRole: 'employee', historyLength: 0 }));
    expect(grokService.chat).toHaveBeenCalledTimes(1);
    expect(result.provider).toBe('groq');
    expect(result.tier).toBe('free');
    expect(result.fallbackTriggered).toBe(false);
  });

  it('Groq איכות ירודה → fallback ל-Gemini', async () => {
    validate.mockReturnValueOnce({ acceptable: false });
    const result = await route(makeBase({ message: 'שלום', userRole: 'employee', historyLength: 0 }));
    expect(geminiService.chat).toHaveBeenCalledTimes(1);
    expect(result.fallbackTriggered).toBe(true);
  });

  it('Groq נכשל → fallback ל-Gemini', async () => {
    grokService.chat.mockRejectedValueOnce(new Error('Groq down'));
    const result = await route(makeBase({ message: 'שלום', userRole: 'employee', historyLength: 0 }));
    expect(geminiService.chat).toHaveBeenCalledTimes(1);
    expect(result.fallbackTriggered).toBe(true);
  });
});

describe('Tier 3 — Gemini → Claude (ציון > 60)', () => {
  const premiumMsg = 'נתח את מגמות הרווח וההפסד הפיננסיות של העסק ב-6 חודשים האחרונים';

  it('מחזיר תשובת Gemini לשאלה מורכבת', async () => {
    const result = await route(makeBase({ message: premiumMsg, userRole: 'owner', historyLength: 10 }));
    expect(geminiService.chat).toHaveBeenCalledTimes(1);
    expect(grokService.chat).not.toHaveBeenCalled();
  });

  it('Gemini איכות ירודה → escalate ל-Claude', async () => {
    validate.mockReturnValueOnce({ acceptable: false });
    const params = makeBase({ message: premiumMsg, userRole: 'owner', historyLength: 10 });
    const result = await route(params);
    expect(params.claudeCallFn).toHaveBeenCalledTimes(1);
    expect(result.provider).toBe('claude');
    expect(result.tier).toBe('premium');
    expect(result.fallbackTriggered).toBe(true);
  });

  it('Gemini נכשל → escalate ל-Claude', async () => {
    geminiService.chat.mockRejectedValueOnce(new Error('Gemini down'));
    const params = makeBase({ message: premiumMsg, userRole: 'owner', historyLength: 10 });
    const result = await route(params);
    expect(params.claudeCallFn).toHaveBeenCalledTimes(1);
    expect(result.provider).toBe('claude');
  });
});

describe('Tool use → Claude ישירות', () => {
  it('הודעה עם "חפש באינטרנט" → Claude ישירות', async () => {
    const params = makeBase({ message: 'חפש באינטרנט מחירי עגבניות' });
    const result = await route(params);
    expect(params.claudeCallFn).toHaveBeenCalledTimes(1);
    expect(grokService.chat).not.toHaveBeenCalled();
    expect(geminiService.chat).not.toHaveBeenCalled();
  });
});
