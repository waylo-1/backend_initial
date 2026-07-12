/**
 * POST /act-vision — the agent decider for AX-HOSTILE apps (Set-of-Mark).
 *
 * When the accessibility tree is empty (Spotify, WhatsApp, some Electron
 * apps), the macOS client screenshots the screen, runs YOLO to box every UI
 * element, stamps a NUMBERED badge on each, and sends that annotated image
 * here with the numbered list. This asks a VISION model to pick ONE action by
 * badge number — the same contract as /act, but grounded in pixels the model
 * can see rather than an AX list it can't get. This is what lets agent mode
 * work on apps that expose no tree.
 *
 * Request:  { task, appName, imageBase64 (annotated), marks:[{id,pos,kind}],
 *             history:[...] }
 * Response: same action shapes as /act, where press/point ids are BADGE ids.
 */
const express = require('express');
const router = express.Router();
const { askVision, stripFences, isQuotaOrThrottleError } = require('../services/llm');

const SYSTEM = `You are Waylo, operating a macOS app for a non-technical user. This app hides its
accessibility data, so you are looking at a SCREENSHOT with numbered red badges drawn on
every clickable element (Set-of-Mark). Decide the SINGLE next action and reply with ONE JSON
object only — no markdown, no prose.

The numbered list gives each badge's id and screen position; the IMAGE shows what each badge
sits on. Read the image to understand what each numbered element actually is.

Actions (choose exactly one):
{"act":"press","id":<badge>,"say":"..."} — click the element under badge #id.
{"act":"type","text":"...","submit":true|false,"say":"..."} — type into whatever is focused (press the field's badge first in a previous turn); submit=true presses Return.
{"act":"key","combo":"cmd+k","say":"..."} — a keyboard shortcut (cmd, shift, alt, ctrl + a-z/0-9/return/tab/space/escape/arrows).
{"act":"menu","path":["File","New"],"say":"..."} — the native menu bar still works even here; use it when you know the path.
{"act":"scroll","direction":"down","say":"..."} — scroll to reveal more.
{"act":"wait","seconds":3,"say":"..."} — wait for loading.
{"act":"point","id":<badge>,"question":"..."} — the USER should click this (a personal choice: which song/chat/photo). Outlines it and waits for them.
{"act":"ask_user","question":"..."} — you need the user to do something you can't; they do it and the loop continues.
{"act":"done","summary":"..."}

Rules:
1. ids MUST be badge numbers from the list. If the element you want has no badge, use a keyboard shortcut, a menu path, or scroll to bring it into view.
2. Prefer keyboard shortcuts and menu paths when you're sure of them — they don't depend on reading a badge correctly.
3. Never repeat an action already in the history. If it didn't work, choose a DIFFERENT badge or channel.
4. Personal choices (which song/chat/photo/result) are the user's → point or ask_user, never guess.
5. Add "confirm":true to anything that sends, deletes, pays, posts, or shares.
6. "say" is one short spoken sentence. Say done only when the WHOLE task is finished.
7. To search: press the search field's badge, then next turn type with submit:true.`;

function fmtMarks(marks) {
  if (!Array.isArray(marks) || marks.length === 0) return '(no elements detected)';
  return marks.map((m) => `#${m.id}${m.kind ? ` ${m.kind}` : ''} @${m.pos}`).join('  ');
}

router.post('/', async (req, res) => {
  try {
    const { task, appName, imageBase64, marks, history } = req.body || {};
    if (!task || !imageBase64) return res.status(400).json({ error: 'task and imageBase64 required' });

    const hist = Array.isArray(history) && history.length
      ? history.slice(-12).map((h, i) => `${i + 1}. ${h}`).join('\n')
      : '(none yet)';

    const prompt = `TASK: ${task}
APP: ${appName || '(unknown)'} (accessibility tree unavailable — using the screenshot)

NUMBERED ELEMENTS (badge id, kind, position):
${fmtMarks(marks)}

ACTIONS SO FAR:
${hist}

Look at the screenshot, then reply with the single JSON action for the next step.`;

    const rawText = await askVision({
      system: SYSTEM, prompt, imageBase64, maxTokens: 300, temperature: 0.1,
      modelId: process.env.AGENT_VISION_MODEL_ID || process.env.BEDROCK_VISION_MODEL_ID || undefined,
    });

    let action;
    try { action = JSON.parse(stripFences(rawText)); }
    catch {
      const m = String(rawText).match(/\{[\s\S]*\}/);
      if (m) { try { action = JSON.parse(m[0]); } catch { /* ignore */ } }
    }
    const valid = new Set(['press', 'type', 'key', 'menu', 'scroll', 'wait', 'done', 'ask_user', 'point']);
    if (!action || !valid.has(action.act)) {
      return res.json({ act: 'ask_user', question: "I can't quite see how to do that here — can you do the next step?" });
    }
    return res.json(action);
  } catch (err) {
    console.error('[act-vision]', err.message);
    if (isQuotaOrThrottleError(err)) return res.status(429).json({ error: 'The AI is busy — try again shortly.' });
    return res.status(500).json({ error: 'act-vision failed' });
  }
});

module.exports = router;
