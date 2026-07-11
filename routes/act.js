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
{"act":"wait","seconds":3,"say":"..."} — wait (countdowns, loading).
{"act":"done","summary":"..."} — the WHOLE task is complete.
{"act":"ask_user","question":"..."} — you need the user: a personal choice (which chat/photo/file), a login, or you are genuinely stuck.

Rules:
1. Element ids MUST come from the list. Never invent an id.
2. Prefer, in order: a keyboard shortcut you are certain of (e.g. cmd+s to save) > a menu path > pressing a listed element. Menus and shortcuts are the most reliable channels on macOS.
3. The history shows each action's RESULT. If an action produced "no visible change", do NOT repeat it — try a different channel (menu instead of button, shortcut instead of menu).
4. Add "confirm":true to any action that sends, deletes, empties, pays, posts, shares, or otherwise acts irreversibly or outward. The app will ask the user before executing.
5. Personal choices are the user's: which chat, which photo, which contact, which file → ask_user, never guess.
6. "say" is spoken aloud: one short, friendly, present-tense sentence ("Opening the File menu"). No jargon.
7. Use menu paths with the app's EXACT current menu titles when visible in the element list or context; otherwise standard macOS names.
8. Say done only when the FULL task is finished, not after a promising step.
9. If the same approach failed twice, change strategy or ask_user. Never loop.
10. Typing into a search field usually needs submit:true to run the search.`;

function fmtElements(elements) {
  if (!Array.isArray(elements) || elements.length === 0) return '(none — the app exposes no accessibility elements)';
  return elements.slice(0, 120).map((e) => {
    const bits = [`[${e.id}] ${e.role || '?'}`];
    if (e.title) bits.push(`"${String(e.title).slice(0, 60)}"`);
    if (e.desc && e.desc !== e.title) bits.push(`(${String(e.desc).slice(0, 60)})`);
    if (e.value) bits.push(`value="${String(e.value).slice(0, 40)}"`);
    if (e.pos) bits.push(`@${e.pos}`);
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

    const rawText = await askText({ system: SYSTEM, prompt, maxTokens: 300, temperature: 0.1 });
    let action;
    try {
      action = JSON.parse(stripFences(rawText));
    } catch {
      // Model wrapped it in prose — salvage the first {...} block.
      const m = String(rawText).match(/\{[\s\S]*\}/);
      if (m) { try { action = JSON.parse(m[0]); } catch { /* fall through */ } }
    }
    const valid = new Set(['press', 'type', 'key', 'menu', 'open_app', 'scroll', 'wait', 'done', 'ask_user']);
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
