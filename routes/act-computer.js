/**
 * POST /act-computer — agent decider backed by Gemini's COMPUTER-USE tool.
 *
 * Google exposes a purpose-built GUI-operation tool on gemini-3.5-flash via
 * the Interactions API: given a plain screenshot it returns grounded actions
 * ("click at (x,y)", "type ...") on a 0-999 normalized grid — i.e. the model
 * IS the grounding layer, trained for exactly this. Where /act-vision needs
 * YOLO boxes + numbered badges first, this needs only the raw screenshot.
 *
 * EXPERIMENTAL and flag-gated on the client: any error here makes the app fall
 * back to the Set-of-Mark /act-vision path for that turn, so reliability can
 * only go up. Stateless: task + history are resent each call (no
 * previous_interaction_id bookkeeping to lose).
 *
 * Request:  { task, appName, imageBase64 (plain JPEG), history:[...] }
 * Response: our normal action schema, extended with grid coordinates:
 *   { act:"press_at", x, y, say }              // x,y on the 0-999 grid
 *   { act:"type_at",  x, y, text, submit, say }
 *   { act:"type", text, submit, say } | { act:"key", combo } |
 *   { act:"scroll", direction } | { act:"wait", seconds } |
 *   { act:"done", summary } | { act:"ask_user", question }
 * plus confirm:true when the model flags the action as needing user consent.
 */
const express = require('express');
const router = express.Router();

const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.COMPUTER_USE_MODEL || 'gemini-3.5-flash';
const INTERACTIONS_URL = 'https://generativelanguage.googleapis.com/v1beta/interactions';

const GUIDANCE = `You are Waylo, operating a macOS desktop for a non-technical user.
Work strictly toward the TASK. One action at a time. Personal choices (which chat,
which photo, which file) belong to the USER — do not guess; explain what they should
click instead of clicking it yourself. Never repeat an action listed in the history.

STOPPING RULE (most important): the moment the screen shows the TASK is achieved,
STOP ACTING — reply in plain text starting with "DONE:" and one sentence of what was
accomplished. Do NOT perform extra actions beyond the literal task: no renaming,
no verifying, no tidying, no exploring. Fewer actions is better.`;

/** "Control+Shift+A" / "ctrl-a" → our combo syntax "ctrl+shift+a". */
function normalizeCombo(keys) {
  return String(keys || '')
    .replaceAll('-', '+')
    .split('+')
    .map((k) => {
      const t = k.trim().toLowerCase();
      if (t === 'control') return 'ctrl';
      if (t === 'meta' || t === 'command' || t === 'super') return 'cmd';
      if (t === 'option') return 'alt';
      if (t === 'enter') return 'return';
      return t;
    })
    .filter(Boolean)
    .join('+');
}

/** Recursively collect {name, args} function calls from an unknown-shaped response. */
function findFunctionCalls(node, out) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { node.forEach((n) => findFunctionCalls(n, out)); return; }
  const args = node.arguments ?? node.args ?? node.input;
  if (typeof node.name === 'string' && args && typeof args === 'object') {
    out.push({ name: node.name, args });
  }
  Object.values(node).forEach((v) => findFunctionCalls(v, out));
}

/** Recursively collect text fragments (for done/ask_user fallbacks). */
function findTexts(node, out) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { node.forEach((n) => findTexts(n, out)); return; }
  if (typeof node.text === 'string' && node.text.trim()) out.push(node.text.trim());
  Object.values(node).forEach((v) => findTexts(v, out));
}

/** Gemini computer-use action → our client action schema. */
function mapAction(call, responseJSON) {
  const a = call.args || {};
  const say = a.intent || a.reasoning || '';
  // Actions needing user consent surface as safety decisions in the response.
  const confirm = JSON.stringify(responseJSON).includes('require_confirmation') || undefined;
  const num = (v) => (typeof v === 'number' ? Math.round(v) : undefined);

  switch (call.name) {
    case 'click':
    case 'click_at':
    case 'left_click':
      return { act: 'press_at', x: num(a.x), y: num(a.y), say, confirm };
    case 'double_click':
      return { act: 'press_at', x: num(a.x), y: num(a.y), say, double: true, confirm };
    case 'type':
    case 'type_text':
      return { act: 'type', text: a.text || '', submit: !!a.press_enter, say, confirm };
    case 'type_text_at':
      return { act: 'type_at', x: num(a.x), y: num(a.y), text: a.text || '', submit: !!a.press_enter, say, confirm };
    case 'key_combination':
    case 'keypress':
      return { act: 'key', combo: normalizeCombo(a.keys || a.combination), say, confirm };
    case 'scroll':
    case 'scroll_at':
    case 'scroll_document':
      return { act: 'scroll', direction: (a.direction || 'down').toLowerCase(), say };
    case 'wait':
    case 'wait_seconds':
      return { act: 'wait', seconds: Math.min(Number(a.seconds || a.duration || 2), 10), say };
    case 'take_screenshot':
      // The loop re-screenshots every turn anyway — treat as a no-op wait.
      return { act: 'wait', seconds: 0, say };
    default:
      // drag_and_drop, navigate, open_app etc — not executable in v1.
      return { act: 'ask_user', question: `I need you to do this part: ${call.name.replaceAll('_', ' ')}${say ? ` (${say})` : ''}.` };
  }
}

router.post('/', async (req, res) => {
  try {
    if (!API_KEY) return res.status(501).json({ error: 'Gemini not configured' });
    const { task, appName, imageBase64, history } = req.body || {};
    if (!task || !imageBase64) return res.status(400).json({ error: 'task and imageBase64 required' });

    const hist = Array.isArray(history) && history.length
      ? `\nACTIONS ALREADY TAKEN (never repeat these):\n${history.slice(-12).map((h, i) => `${i + 1}. ${h}`).join('\n')}`
      : '';
    const prompt = `${GUIDANCE}\n\nTASK: ${task}\nFRONTMOST APP: ${appName || '(unknown)'}${hist}\n\nHere is the current screen. Decide the single next action.`;

    // NOTE: this Interactions API variant is STEPS-based — `input` is a flat
    // list of step items, NOT [{role, content}] turns (that shape 400s with
    // "use step_list input format instead of turn_list").
    const body = {
      model: MODEL,
      input: [
        { type: 'text', text: prompt },
        { type: 'image', data: imageBase64, mime_type: 'image/jpeg' },
      ],
      tools: [{ type: 'computer_use', environment: 'desktop' }],
    };

    const r = await fetch(INTERACTIONS_URL, {
      method: 'POST',
      headers: { 'x-goog-api-key': API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const raw = await r.text();
    if (!r.ok) {
      console.error('[act-computer]', r.status, raw.slice(0, 300));
      return res.status(502).json({ error: `computer-use ${r.status}` });
    }
    let json;
    try { json = JSON.parse(raw); } catch { return res.status(502).json({ error: 'unparseable response' }); }
    if (process.env.WAYLO_DEBUG) console.log('[act-computer] RAW:', raw.slice(0, 1200));

    const calls = [];
    findFunctionCalls(json, calls);
    if (calls.length) return res.json(mapAction(calls[0], json));

    // No function call — the model answered in words (finished, or needs the user).
    const texts = [];
    findTexts(json, texts);
    const text = texts.join(' ').slice(0, 300);
    if (/^\s*DONE:/i.test(text) || /\b(done|complete|finished|successfully)\b/i.test(text)) {
      return res.json({ act: 'done', summary: text.replace(/^\s*DONE:\s*/i, '') || 'Done.' });
    }
    return res.json({ act: 'ask_user', question: text || 'I need your help with this step.' });
  } catch (err) {
    console.error('[act-computer]', err.message);
    return res.status(502).json({ error: 'act-computer failed' });
  }
});

module.exports = router;
