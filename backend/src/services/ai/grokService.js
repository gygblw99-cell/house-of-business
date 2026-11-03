/**
 * Groq Service — Groq API integration (FREE tier)
 * OpenAI-compatible API format — groq.com
 *
 * המודל היה מקובע ל-`llama-3.3-70b-versatile`, והוא הוצא משירות בחשבון הזה —
 * כל קריאה חזרה 404 ("The model does not exist"), כלומר **שכבת ה-AI החינמית
 * הייתה מושבתת לחלוטין** בכל הפלטפורמה: כל בקשה נפלה בשקט ל-Gemini או ל-Claude
 * בתשלום, עם אזהרה בלוג ועוד round-trip מבוזבז בכל קריאה.
 *
 * אומת מול `GET /v1/models` של החשבון — אין יותר אף מודל Llama; המודלים
 * הכלליים הזמינים הם openai/gpt-oss-120b, openai/gpt-oss-20b ו-qwen/qwen3.8-27b.
 * נבחר ה-120b (הגדול מהם), ונבדק על חילוץ מרכיבים בעברית — החזיר יחידות
 * מדויקות ("20 מיליליטר", לא "0.018 ליטר").
 *
 * אם גם זה יוצא משירות: להריץ את אותה בדיקת /v1/models ולעדכן כאן.
 * ניתן לעקוף בלי דיפלוי דרך משתנה הסביבה GROQ_MODEL.
 */

const GROK_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROK_MODEL   = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';

// Groq free tier — effectively $0
const COST_PER_INPUT_TOKEN  = 0;
const COST_PER_OUTPUT_TOKEN = 0;

async function chat(systemPrompt, messages, options = {}) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('GROQ_API_KEY לא מוגדר ב-.env');

  const payload = {
    model: GROK_MODEL,
    messages: [
      { role: 'system', content: systemPrompt },
      ...messages,
    ],
    max_tokens:  options.maxTokens  || 1200,
    temperature: options.temperature ?? 0.6,
  };

  const start = Date.now();

  const res = await fetch(GROK_API_URL, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
  });

  const responseTimeMs = Date.now() - start;

  if (!res.ok) {
    const errData = await res.json().catch(() => ({}));
    const msg = errData?.error?.message || res.statusText;
    throw new Error(`Grok API ${res.status}: ${msg}`);
  }

  const data = await res.json();

  const text         = data.choices?.[0]?.message?.content || '';
  const inputTokens  = data.usage?.prompt_tokens     || 0;
  const outputTokens = data.usage?.completion_tokens || 0;
  const totalTokens  = data.usage?.total_tokens      || 0;
  const costUsd      = (inputTokens * COST_PER_INPUT_TOKEN) + (outputTokens * COST_PER_OUTPUT_TOKEN);

  return {
    text,
    model:         data.model || GROK_MODEL,
    tokensUsed:    totalTokens,
    inputTokens,
    outputTokens,
    costUsd,
    responseTimeMs,
  };
}

module.exports = { chat };
