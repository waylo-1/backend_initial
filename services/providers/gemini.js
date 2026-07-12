/**
 * Google Gemini raw model access (Generative Language REST API — no SDK
 * dependency needed since Node 22 has a global fetch).
 *
 * One model handles both text and vision (Gemini's flash models are natively
 * multimodal), configurable separately in case that changes later.
 *
 * Only loaded when AI_PROVIDER=gemini (see services/llm.js). NOTE: untested
 * against a live Gemini quota as of writing (see project notes) — verify
 * responses before relying on this path in production.
 */

const API_KEY = process.env.GEMINI_API_KEY;
// Defaults track the current stable line (gemini-2.x is retired). Override per
// deploy with GEMINI_TEXT_MODEL / GEMINI_VISION_MODEL. Verify what your key can
// see with:  curl "https://generativelanguage.googleapis.com/v1beta/models?key=$GEMINI_API_KEY"
const TEXT_MODEL = process.env.GEMINI_TEXT_MODEL || 'gemini-3.5-flash';
const VISION_MODEL = process.env.GEMINI_VISION_MODEL || 'gemini-3.1-pro';
const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

if (!API_KEY) {
  throw new Error('AI_PROVIDER=gemini requires GEMINI_API_KEY in the environment');
}

async function generateContent({ model, system, parts, maxTokens = 1500, temperature = 0.3 }) {
  const body = {
    contents: [{ role: 'user', parts }],
    generationConfig: { temperature, maxOutputTokens: maxTokens },
  };
  if (system) {
    body.systemInstruction = { parts: [{ text: system }] };
  }

  const res = await fetch(`${BASE_URL}/${model}:generateContent?key=${API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini API error ${res.status}: ${errText.substring(0, 300)}`);
  }

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts
    ?.map((p) => p.text || '')
    .join('')
    .trim();

  if (!text) {
    throw new Error('Gemini returned an empty response');
  }
  return text;
}

/** Text-only call (no image). `modelId` overrides the default text model. */
async function askText({ system, prompt, maxTokens = 1500, temperature = 0.3, modelId }) {
  return generateContent({
    model: modelId || TEXT_MODEL,
    system,
    parts: [{ text: prompt }],
    maxTokens,
    temperature,
  });
}

/** Single-image call. `modelId` overrides the default vision model. */
async function askVision({ system, prompt, imageBase64, maxTokens = 1500, temperature = 0.3, modelId }) {
  return generateContent({
    model: modelId || VISION_MODEL,
    system,
    parts: [
      { text: prompt },
      { inlineData: { mimeType: 'image/jpeg', data: imageBase64 } },
    ],
    maxTokens,
    temperature,
  });
}

/** Object-detection call (bbox grounding). */
async function askObjectDetection({ prompt, imageBase64, maxTokens = 400, temperature = 0.0, modelId }) {
  return generateContent({
    model: modelId || VISION_MODEL,
    parts: [
      { inlineData: { mimeType: 'image/jpeg', data: imageBase64 } },
      { text: prompt },
    ],
    maxTokens,
    temperature,
  });
}

module.exports = { askText, askVision, askObjectDetection };
