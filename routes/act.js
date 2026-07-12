/**
 * POST /act — the agent-mode decider (observe → decide ONE action → act loop).
 *
 * The macOS app sends the CURRENT accessibility tree as a numbered element
 * list plus the action history so far; this returns exactly ONE next action.
 * No upfront multi-step plan, no element *descriptions* to fuzzy-match later —
 * the model chooses from the real elements by id, so grounding is exact by
 * construction. This is the architecture browser agents (accessibility-tree +
 * element ids) use, applied to the Mac AX tree.
 *
 * Request:
 *   { task, appName, context,             // context = ScreenContextBuilder text
 *     elements: [{ id, role, title, desc, value, pos }],
 *     history:  [ "press #7 'File' → screen changed", ... ] }
 *
 * Response (one of):
 *   { act:"press",   id, say }
 *   { act:"type",    id?, text, submit?, say }      // submit=true → press Return after
 *   { act:"key",     combo, say }                   // "cmd+shift+4"
 *   { act:"menu",    path:["File","Export…"], say } // pressed via AX menu tree, no coords
 *   { act:"open_app", name, say }
 *   { act:"scroll",  direction:"up|down", say }
 *   { act:"wait",    seconds, say }
 *   { act:"done",    summary }
 *   { act:"ask_user", question }                    // needs the user (choice/login/unclear)
 * plus optional  confirm:true  → the app must get user confirmation first
 * (destructive / outward-facing: send, delete, empty, pay, post, share).
 */
const express = require('express');
const router = express.Router();
const { askText, stripFences, isQuotaOrThrottleError } = require('../services/llm');

const SYSTEM = `You are Waylo, an agent operating a macOS computer for a non-technical user.
Each turn you see: the user's TASK, the frontmost app, a numbered list of the REAL
UI elements currently on screen (from the accessibility tree), and the actions taken
so far with their observed results. Decide the SINGLE best next action and reply with
ONE JSON object only — no markdown, no commentary.

Actions (choose exactly one):
{"act":"press","id":<n>,"say":"<short narration>"} — click element #n from the list.
{"act":"type","id":<n>,"text":"...","submit":true|false,"say":"..."} — type into field #n (omit id to type into the focused field); submit=true presses Return after.
{"act":"key","combo":"cmd+s","say":"..."} — press a keyboard shortcut (modifiers: cmd, shift, alt/option, ctrl; keys: a-z, 0-9, return, tab, space, escape, delete, arrows as up/down/left/right, comma).
{"act":"menu","path":["File","Export…"],"say":"..."} — invoke a menu-bar item by exact path. Works even if not in the element list; menus are ALWAYS reachable this way.
{"act":"open_app","name":"Photo Booth","say":"..."} — launch or focus an app.
{"act":"scroll","direction":"down","say":"..."} — scroll the frontmost window.
{"act":"wait","seconds":3,"say":"..."} — wait (countdowns, capture timers, loading).
{"act":"point","id":<n>,"question":"..."} — the USER must click this themselves (a personal choice among similar items, or something you can see but they should decide). The app draws an outline on element #n, speaks the question, waits for their click, then you get the next turn.
{"act":"ask_user","question":"..."} — you need the user to DO something you can't (log in, pick something not in the list, drag). They will do it and the loop CONTINUES — you get another turn after. Phrase it as a doable instruction.
{"act":"done","summary":"..."} — the WHOLE task is complete.

Rules:
0. FIRST make sure the RIGHT app is in front. If the task is about an app that is not the FRONTMOST app — or the element list is empty / clearly belongs to a different app — your first action MUST be open_app for the correct app. Never run menus or presses against the wrong app. ("write a note" → Notes; "email X" → Mail; "take a photo" → Photo Booth.)
1. Element ids MUST come from the list. Never invent an id.
2. Prefer, in order: a keyboard shortcut you are certain of (e.g. cmd+s to save) > a menu path > pressing a listed element. Menus and shortcuts are the most reliable channels on macOS.
3. NEVER repeat an action that is already in the history, whatever its result. Pressing the same menu or button again does not make it work — if your action didn't achieve what you expected, the next attempt MUST use a different channel or ask_user/point. This is the most important rule.
4. AXPress reports success even when it achieves nothing (disabled menus, sheets already open). Trust the ELEMENT LIST, not the action result: after opening a dialog, the list will contain its Save/Cancel buttons — act on those.
4b. Elements marked ** IN OPEN DIALOG ** mean a modal dialog/sheet is open. You MUST act on the dialog's elements (fill its fields, press its buttons). Menus and everything behind it are FROZEN and will silently do nothing until the dialog is completed or cancelled.
5. Actions that start a timed process (camera countdown, capture, export, loading) show no immediate change — use wait (3-5s) after them instead of re-triggering. Example: after pressing a camera/record/take-photo button, the countdown is invisible to the element list; the ONLY correct next action is {"act":"wait","seconds":4}. Pressing it again cancels or retakes.
6. Add "confirm":true to any action that sends, deletes, empties, pays, posts, shares, or otherwise acts irreversibly or outward. The app will ask the user before executing.
7. Personal choices are the user's: which chat, which photo, which contact, which file. When the choices (or their area) appear in the element list, use point with one of their ids — the outline shows the user where to look; otherwise ask_user. Never guess for them.
8. "say" is spoken aloud: one short, friendly, present-tense sentence ("Opening the File menu"). No jargon.
9. Use menu paths with the app's EXACT current menu titles when visible in the element list or context; otherwise standard macOS names.
10. Say done only when the FULL task is finished. A save/export is finished once the Save button was pressed and the dialog's elements are GONE from the list.
11. Typing into a search field usually needs submit:true to run the search.`;

function fmtElements(elements) {
  if (!Array.isArray(elements) || elements.length === 0) return '(none — the app exposes no accessibility elements)';
  return elements.slice(0, 120).map((e) => {
    const bits = [`[${e.id}] ${e.role || '?'}`];
    if (e.title) bits.push(`"${String(e.title).slice(0, 60)}"`);
    if (e.desc && e.desc !== e.title) bits.push(`(${String(e.desc).slice(0, 60)})`);
    if (e.tooltip) bits.push(`tooltip="${String(e.tooltip).slice(0, 50)}"`);
    if (e.value) bits.push(`value="${String(e.value).slice(0, 40)}"`);
    if (e.pos) bits.push(`@${e.pos}`);
    if (e.dialog) bits.push('** IN OPEN DIALOG **');
    return bits.join(' ');
  }).join('\n');
}

router.post('/', async (req, res) => {
  try {
    const { task, appName, context, elements, history } = req.body || {};
    if (!task) return res.status(400).json({ error: 'task required' });

    const hist = Array.isArray(history) && history.length
      ? history.slice(-14).map((h, i) => `${i + 1}. ${h}`).join('\n')
      : '(none yet — this is the first action)';

    const prompt = `TASK: ${task}

FRONTMOST APP: ${appName || '(unknown)'}
${context ? `\nSCREEN CONTEXT:\n${String(context).slice(0, 2000)}\n` : ''}
CURRENT UI ELEMENTS:
${fmtElements(elements)}

ACTIONS TAKEN SO FAR (with results):
${hist}

Reply with the single JSON action for the next step.`;

    // The decider is the brain of agent mode. AGENT_MODEL_ID picks a strong,
    // PROVIDER-APPROPRIATE model (a Bedrock id when AI_PROVIDER=bedrock, a
    // Gemini id when =gemini). When unset it uses the provider's default text
    // model — fine on Gemini (set GEMINI_TEXT_MODEL to a capable model), but on
    // Bedrock that default is Nova Micro, so set AGENT_MODEL_ID there.
    const rawText = await askText({
      system: SYSTEM, prompt, maxTokens: 900, temperature: 0.1, json: true,
      modelId: process.env.AGENT_MODEL_ID || undefined,
    });
    let action;
    try {
      action = JSON.parse(stripFences(rawText));
    } catch {
      // Model wrapped it in prose — salvage the first {...} block.
      const m = String(rawText).match(/\{[\s\S]*\}/);
      if (m) { try { action = JSON.parse(m[0]); } catch { /* fall through */ } }
    }
    const valid = new Set(['press', 'type', 'key', 'menu', 'open_app', 'scroll', 'wait', 'done', 'ask_user', 'point']);
    if (!action || !valid.has(action.act)) {
      return res.json({ act: 'ask_user', question: "I'm not sure what to do next — can you tell me more?" });
    }
    return res.json(action);
  } catch (err) {
    console.error('[act]', err.message);
    if (isQuotaOrThrottleError(err)) {
      return res.status(429).json({ error: 'The AI is busy right now — try again in a minute.' });
    }
    return res.status(500).json({ error: 'act failed' });
  }
});

module.exports = router;
