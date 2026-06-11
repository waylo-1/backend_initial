// backend_initial/routes/vision-fallback.js
// POST /vision-fallback — desktop (macOS) screenshot analysis.
//
// Waylo Desktop sends a full-screen JPEG (base64) when its local Accessibility
// search fails to locate an element. Claude (AWS Bedrock) inspects the
// screenshot and returns a corrected element description the app can re-search.
//
// Uses the shared Bedrock Converse client (bedrock.js). AWS credentials stay
// server-side. The screenshot is never logged or persisted.

const express = require('express');
const router = express.Router();

const { converse, stripFences } = require('../bedrock');

const FALLBACK_PROMPT = (task, stepIndex, totalSteps, findDescription) => `
You help a desktop guidance app find UI elements when normal methods fail.
Task: ${task}
Current step: ${stepIndex} of ${totalSteps}
Expected element: ${findDescription}
The element was not found. Analyze this screenshot and find where the user should click.
Return ONLY valid JSON:
{
  "elementFound": true/false,
  "updatedFindDescription": "new English description matching the AX element's role and label",
  "instruction": "updated instruction if needed",
  "reasoning": "brief note on what you see"
}
`.trim();

router.post('/', async (req, res) => {
  const { screenshot, task, stepIndex = 0, totalSteps = 1, findDescription } = req.body || {};

  if (!screenshot || !task || !findDescription) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    const prompt = FALLBACK_PROMPT(task, stepIndex, totalSteps, findDescription);

    const rawText = await converse({
      content: [
        { text: prompt },
        {
          image: {
            format: 'jpeg',
            source: { bytes: Buffer.from(screenshot, 'base64') },
          },
        },
      ],
      maxTokens: 1000,
      temperature: 0.2,
    });

    const cleaned = stripFences(rawText);

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      console.error('[vision-fallback] JSON parse failed:', e.message);
      return res.status(500).json({ error: 'Model returned invalid JSON' });
    }

    // IMPORTANT: never log or store the screenshot data.
    return res.json(parsed);
  } catch (err) {
    console.error('[vision-fallback] error:', err.message);
    const msg = err.message || 'Vision fallback failed';
    const status = /throttl|429|rate/i.test(msg) ? 429 : 500;
    return res.status(status).json({ error: msg });
  }
});

module.exports = router;
