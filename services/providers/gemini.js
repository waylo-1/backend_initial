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
const TEXT_MODEL = process.env.GEMINI_TEXT_MODEL || 'gemini-flash-latest';
const VISION_MODEL = process.env.GEMINI_VISION_MODEL || 'gemini-pro-latest';
const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

if (!API_KEY) {
  throw new Error('AI_PROVIDER=gemini requires GEMINI_API_KEY in the environment');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Google returns 503 UNAVAILABLE ("high demand") and 429 RESOURCE_EXHAUSTED on
// transient capacity spikes — common on popular GA models. These are NOT the
// caller's fault and clear in seconds, so we retry with backoff+jitter instead
// of surfacing a failure. Genuine errors (400/404/permission) are not retried.
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 4;

async function generateContent({ model, system, parts, maxTokens = 1500, temperature = 0.3, json = false }) {
  const body = {
    contents: [{ role: 'user', parts }],
    generationConfig: { temperature, maxOutputTokens: maxTokens },
  };
  // Force valid JSON out (no prose preamble, no ```json fences) for callers that
  // parse it — Gemini otherwise adds "Sure, here's…" and breaks JSON.parse.
  if (json) {
    body.generationConfig.responseMimeType = 'application/json';
  }
  if (system) {
    body.systemInstruction = { parts: [{ text: system }] };
  }

  let res, errText;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    res = await fetch(`${BASE_URL}/${model}:generateContent?key=${API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.ok) break;
    errText = await res.text();
    if (attempt < MAX_ATTEMPTS && RETRY_STATUSES.has(res.status)) {
      const wait = Math.round(400 * 2 ** (attempt - 1) + Math.random() * 300); // 0.4s,0.8s,1.6s +jitter
      console.warn(`[gemini] ${model} ${res.status} — retry ${attempt}/${MAX_ATTEMPTS - 1} in ${wait}ms`);
      await sleep(wait);
      continue;
    }
    throw new Error(`Gemini API error ${res.status}: ${(errText || '').substring(0, 300)}`);
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

/** Text-only call (no image). `modelId` overrides the model; `json` forces JSON. */
async function askText({ system, prompt, maxTokens = 1500, temperature = 0.3, modelId, json = false }) {
  return generateContent({
    model: modelId || TEXT_MODEL,
    system,
    parts: [{ text: prompt }],
    maxTokens,
    temperature,
    json,
  });
}

/** Single-image call. `modelId` overrides the model; `json` forces JSON. */
async function askVision({ system, prompt, imageBase64, maxTokens = 1500, temperature = 0.3, modelId, json = false }) {
  return generateContent({
    model: modelId || VISION_MODEL,
    system,
    parts: [
      { text: prompt },
      { inlineData: { mimeType: 'image/jpeg', data: imageBase64 } },
    ],
    maxTokens,
    temperature,
    json,
  });
}

/** Object-detection call (bbox grounding). */
async function askObjectDetection({ prompt, imageBase64, maxTokens = 400, temperature = 0.0, modelId, json = false }) {
  return generateContent({
    model: modelId || VISION_MODEL,
    parts: [
      { inlineData: { mimeType: 'image/jpeg', data: imageBase64 } },
      { text: prompt },
    ],
    maxTokens,
    temperature,
    json,
  });
}

module.exports = { askText, askVision, askObjectDetection };
