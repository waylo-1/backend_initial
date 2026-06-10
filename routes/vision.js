// backend_initial/routes/vision.js
// POST /vision — Gemini Vision for element location and troubleshooting.
//
// Two modes:
//   "locate"       — find an expected element on screen, return (x, y)
//   "troubleshoot" — element missing, analyze screen and generate new steps
//
// Uses the Gemini REST API via node-fetch (same approach as gemini.js), so no
// extra npm dependency is required. The Gemini key stays server-side.

const express = require('express');
const router = express.Router();

const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

// ── Prompts ─────────────────────────────────────────────────────────────────
const LOCATE_PROMPT = (task, stepIndex, totalSteps, findDescription) => `
You are helping an Android guidance app find a UI element on screen.

Task: "${task}"
Step: ${stepIndex + 1} of ${totalSteps}
Expected element: "${findDescription}"

Look at the screenshot carefully.

If you can find the element (or something close enough to tap):
- Set "found": true
- Give the pixel coordinates (x, y) of the CENTER of the element
- The image dimensions match the phone screen. Top-left is (0,0).
- If the element label was slightly wrong, give an updated description

If the element is genuinely NOT on screen (e.g. History tab requires sign-in,
tab doesn't exist):
- Set "found": false
- Explain briefly why

Return ONLY valid JSON, no markdown, no text outside the JSON:
{
  "found": true or false,
  "x": <center x pixel if found>,
  "y": <center y pixel if found>,
  "updatedFindDescription": "<corrected element description>",
  "instruction": "<brief instruction update if needed, else empty string>",
  "reasoning": "<one line why>"
}
`.trim();

const TROUBLESHOOT_PROMPT = (task, stepIndex, totalSteps, findDescription, language) => `
You are helping an elderly user complete a task on their Android phone.
The guidance app got stuck because an expected element was not found.

Task the user wants to complete: "${task}"
Step we got stuck on: ${stepIndex + 1} of ${totalSteps}
Element we were looking for: "${findDescription}"
Instruction language: ${language}

Look at the current screenshot.
Figure out WHY the element is missing and what the user needs to do differently.

Common reasons:
- User needs to sign in first
- User is on the wrong screen/app
- The UI has changed (element has a different name or location)
- The app needs a different flow to reach the goal

Generate recovery steps that get the user back on track to complete their
original task. Use simple, warm language an elderly person can follow.
Instructions in: ${language === 'hi' ? 'Hindi' : 'English'}

Return ONLY valid JSON, no markdown:
{
  "recoverable": true or false,
  "explanation": "<one sentence spoken aloud explaining what happened>",
  "newSteps": [
    {
      "stepNumber": 1,
      "instruction": "<spoken instruction for user>",
      "findDescription": "<English description of UI element to find>"
    }
  ]
}

If not recoverable (feature truly doesn't exist, needs paid subscription, etc.):
set "recoverable": false, "newSteps": [], and explain in "explanation".
`.trim();

// ── Route Handler ─────────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  const {
    mode,
    screenshotBase64,
    task,
    currentStepIndex = 0,
    totalSteps = 1,
    findDescription,
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
        ? LOCATE_PROMPT(task, currentStepIndex, totalSteps, findDescription)
        : TROUBLESHOOT_PROMPT(task, currentStepIndex, totalSteps, findDescription, language);

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

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const data = await response.json();

    if (!response.ok) {
      const msg = data.error?.message || 'Gemini Vision API failed';
      console.error(`[vision/${mode}] Gemini error:`, msg);
      const status = msg.includes('429') || msg.includes('quota') ? 429 : 500;
      return res.status(status).json({ error: msg });
    }

    const rawText = (data.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
    console.log(`[vision/${mode}] raw: ${rawText.substring(0, 300)}`);

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
    console.error('[vision] error:', err.message);
    return res.status(500).json({ error: err.message || 'Vision API failed' });
  }
});

module.exports = router;
