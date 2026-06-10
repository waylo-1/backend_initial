// routes/vision.js
// POST /vision — Gemini Vision for element location and troubleshooting.
//
// Two modes:
//   "locate"       — find an expected element on screen, return (x, y)
//   "troubleshoot" — element missing, analyze screen and generate new steps
//
// Uses the Gemini REST API via node-fetch (same approach as gemini.js), so no
// extra npm dependency is required. The Gemini key stays server-side.
//
// Set WAYLO_DEBUG=1 to log full prompts and raw Gemini responses.

const express = require('express');
const router = express.Router();

const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

const DEBUG = process.env.WAYLO_DEBUG === '1';
const GEMINI_TIMEOUT_MS = 60000; // vision calls on Gemini Flash can be slow

// ── Prompts ─────────────────────────────────────────────────────────────────
const LOCATE_PROMPT = (task, stepIndex, totalSteps, findDescription, width, height) => `
You are helping an elderly user tap the correct element on their Android phone screen.

Task: "${task}"
We are on step ${stepIndex + 1} of ${totalSteps}.
We are looking for: "${findDescription}"

Look at this screenshot carefully.

If you can see the element (even if named slightly differently): return its center pixel coordinates.
The phone screen resolution is ${width}x${height}. Top-left is (0,0).
If you genuinely cannot see it anywhere: set found=false.

Return ONLY this JSON, nothing else:
{
  "found": true/false,
  "x": <pixel x of element center>,
  "y": <pixel y of element center>,
  "confidence": 0.0-1.0,
  "whatYouSee": "<one line description of what's at that location>",
  "updatedFindDescription": "<corrected description if element name was wrong>"
}
`.trim();

const TROUBLESHOOT_PROMPT = (task, stepIndex, totalSteps, findDescription, language, width, height) => `
You are helping an elderly Indian user complete a task on their Android phone.
The guidance app got stuck because an expected element is missing from the screen.

Original task: "${task}"
Stuck on step ${stepIndex + 1} of ${totalSteps}: looking for "${findDescription}"
Screen resolution: ${width}x${height}

Analyze the screenshot and figure out:
1. WHY is the element missing? (signed out, wrong screen, feature needs subscription, UI changed, etc.)
2. What should the user do to get back on track?

Generate clear, simple recovery steps. Instructions must be short and warm —
this user is elderly and not tech-savvy.
Write the "instruction" fields in ${language === 'hi' ? 'Hindi' : 'simple English'}.
The "findDescription" fields must always be in English.

Return ONLY this JSON:
{
  "recoverable": true/false,
  "rootCause": "<one line: why the element is missing>",
  "explanation": "<spoken aloud to user, 1 sentence, simple language>",
  "newSteps": [
    {
      "stepNumber": 1,
      "instruction": "<what to do, simple language>",
      "findDescription": "<English description of UI element to tap>"
    }
  ]
}

If not recoverable (feature doesn't exist, needs paid plan, etc.):
set recoverable=false, newSteps=[], and explain clearly in "explanation".
`.trim();

// ── Gemini call with timeout + one retry on 429 ─────────────────────────────
async function callGemini(prompt, screenshotBase64) {
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent` +
    `?key=${process.env.GEMINI_API_KEY}`;

  const body = {
    contents: [
      {
        parts: [
          { text: prompt },
          { inlineData: { mimeType: 'image/jpeg', data: screenshotBase64 } },
        ],
      },
    ],
    generationConfig: { temperature: 0.2, maxOutputTokens: 1500 },
  };

  const doFetch = async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const data = await response.json();
      return { response, data };
    } finally {
      clearTimeout(timer);
    }
  };

  let { response, data } = await doFetch();

  // Rate limited — wait 5s and retry once before failing.
  if (response.status === 429) {
    console.warn('[vision] Gemini 429 — retrying once in 5s');
    await new Promise((r) => setTimeout(r, 5000));
    ({ response, data } = await doFetch());
  }

  return { response, data };
}

// ── Route Handler ────────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  const {
    mode,
    screenshotBase64,
    task,
    currentStepIndex = 0,
    totalSteps = 1,
    findDescription,
    screenWidth = 1080,
    screenHeight = 2400,
    language = 'en',
  } = req.body || {};

  if (!screenshotBase64 || !task || !findDescription) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  if (!['locate', 'troubleshoot'].includes(mode)) {
    return res.status(400).json({ error: "mode must be 'locate' or 'troubleshoot'" });
  }
  if (!process.env.GEMINI_API_KEY) {
    return res.status(500).json({ error: 'GEMINI_API_KEY not configured' });
  }

  try {
    const prompt =
      mode === 'locate'
        ? LOCATE_PROMPT(task, currentStepIndex, totalSteps, findDescription, screenWidth, screenHeight)
        : TROUBLESHOOT_PROMPT(task, currentStepIndex, totalSteps, findDescription, language, screenWidth, screenHeight);

    if (DEBUG) console.log(`[vision/${mode}] prompt:\n${prompt}`);

    const { response, data } = await callGemini(prompt, screenshotBase64);

    if (!response.ok) {
      const msg = data.error?.message || 'Gemini Vision API failed';
      console.error(`[vision/${mode}] Gemini error (${response.status}):`, msg);
      const status = response.status === 429 ? 429 : 500;
      return res.status(status).json({ error: msg });
    }

    const rawText = (data.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
    if (DEBUG) {
      console.log(`[vision/${mode}] raw response:\n${rawText}`);
    } else {
      console.log(`[vision/${mode}] raw: ${rawText.substring(0, 300)}`);
    }

    const cleaned = rawText
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/```\s*$/i, '')
      .trim();

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      console.error('[vision] JSON parse failed:', e.message, 'raw:', rawText);
      return res.status(500).json({ error: 'Gemini returned invalid JSON', raw: rawText });
    }

    console.log(`[vision/${mode}] parsed:`, JSON.stringify(parsed).substring(0, 200));
    return res.json(parsed);
  } catch (err) {
    const message = err.name === 'AbortError' ? 'Gemini Vision timed out' : err.message;
    console.error('[vision] error:', message);
    return res.status(500).json({ error: message || 'Vision API failed' });
  }
});

module.exports = router;
