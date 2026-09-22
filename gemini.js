import process from 'node:process';

const GEMINI_API_KEY = String(process.env.GEMINI_API_KEY || '').trim();
const GEMINI_MODEL = String(process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite').trim();
const GEMINI_TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS || 90000);

function extractText(data) {
  const candidates = Array.isArray(data?.candidates) ? data.candidates : [];
  const parts = candidates[0]?.content?.parts;
  if (Array.isArray(parts)) {
    return parts.map((part) => part?.text || '').filter(Boolean).join('\n').trim();
  }
  if (typeof data?.text === 'string') return data.text.trim();
  return '';
}

export function geminiConfigured() {
  return Boolean(GEMINI_API_KEY);
}

export async function askGemini(prompt) {
  if (!GEMINI_API_KEY) {
    const error = new Error('GEMINI_API_KEY is not configured in Render environment variables.');
    error.code = 'GEMINI_NOT_CONFIGURED';
    throw error;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);
  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': GEMINI_API_KEY
        },
        body: JSON.stringify({
          contents: [{
            role: 'user',
            parts: [{
              text: `You are Orihime MD, a helpful WhatsApp assistant. Be clear, friendly, concise, and useful.\n\nUser request:\n${prompt}`
            }]
          }],
          generationConfig: {
            maxOutputTokens: 4096
          }
        }),
        signal: controller.signal
      }
    );

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = data?.error?.message || `Gemini HTTP ${response.status}`;
      const error = new Error(message);
      error.status = response.status;
      error.details = data?.error || data;
      throw error;
    }

    const text = extractText(data);
    if (!text) throw new Error('Gemini returned an empty response.');
    return text;
  } catch (error) {
    if (error?.name === 'AbortError') {
      const timeout = new Error(`Gemini timed out after ${GEMINI_TIMEOUT_MS} ms.`);
      timeout.code = 'GEMINI_TIMEOUT';
      throw timeout;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export { GEMINI_MODEL };
