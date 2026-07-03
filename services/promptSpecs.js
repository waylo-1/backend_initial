/**
 * Provider-agnostic prompt text, output contracts, and normalization.
 *
 * This is the single source of truth for what shape /plan, /vision etc. return.
 * Both providers/bedrock.js and providers/gemini.js call the model with the
 * prompts defined here and run the response through the same validators, so
 * swapping AI_PROVIDER can never change the JSON the Android app parses.
 */

/** Strips markdown code fences from a model response. */
function stripFences(text) {
  return text
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '')
    .replace(/```json\n?/g, '')
    .replace(/```\n?/g, '')
    .trim();
}

/**
 * Known Android packages for common apps. Steps are enriched with an
 * `appPackage` field server-side (deterministic — more reliable than asking
 * the model for package names in 10 languages).
 */
const KNOWN_PACKAGES = {
  'youtube': 'com.google.android.youtube',
  'whatsapp': 'com.whatsapp',
  'phonepe': 'com.phonepe.app',
  'play store': 'com.android.vending',
  'playstore': 'com.android.vending',
  'chrome': 'com.android.chrome',
  'maps': 'com.google.android.apps.maps',
  'instagram': 'com.instagram.android',
  'settings': 'com.android.settings',
  'gmail': 'com.google.android.gm',
  'irctc': 'cris.org.in.prs.ima',
  'paytm': 'net.one97.paytm',
  'facebook': 'com.facebook.katana',
  'telegram': 'org.telegram.messenger',
};

/** Resolve an app name (or any text mentioning one) to a known package. */
function resolveAppPackage(text) {
  if (!text) return null;
  const haystack = String(text).toLowerCase();
  for (const [keyword, pkg] of Object.entries(KNOWN_PACKAGES)) {
    if (haystack.includes(keyword)) return pkg;
  }
  return null;
}

// ── Android enriched planner (POST /plan, mobile) ──────────────────────────
// The Android Step model expects, at minimum: index, instruction, findDescription.
// This module returns { appPackage, appName, steps: [{ stepNumber, instruction,
// findDescription, ... }] } — index.js maps stepNumber-based fields through
// unchanged, so the wire shape below IS the Android contract. Do not rename
// these fields without updating the Android Step model.

const ENRICHED_SYSTEM_PROMPT = `You are Waylo's step planner. You generate step-by-step guides for elderly Indian users navigating Android smartphones.

Your output must be ONLY valid JSON. No explanation, no markdown, no preamble.

RESPONSE FORMAT:
{
  "task": "original task string",
  "appPackage": "com.example.app",
  "appName": "App Name",
  "steps": [
    {
      "stepNumber": 1,
      "instruction": "Simple English instruction, max 12 words",
      "findDescription": "short element description for search, 3-6 words lowercase",
      "elementType": "one of the element type enum values",
      "screenRegion": "one of the screen region enum values",
      "visualDescription": "what it looks like: color shape icon text, max 15 words",
      "alternateLabels": ["label1", "label2"],
      "fallbackHint": "what to do if element not visible on screen",
      "parentContainer": "UI container name"
    }
  ]
}

ELEMENT TYPE ENUM (use exactly): BUTTON, ICON_BUTTON, FAB, TEXT_INPUT, NAV_ITEM, TOGGLE, APP_ICON, LIST_ITEM, IMAGE, TAB, OVERFLOW_MENU, BACK_BUTTON, OTHER

SCREEN REGION ENUM (use exactly): top, top_center, bottom, bottom_right, center, left, right, full

RULES:
1. instruction — plain English, max 12 words, assume user has never used a smartphone
2. findDescription — lowercase, space-separated keywords, NO filler words like "the" or "on". Good: "plus create post button". Bad: "the plus button at the bottom to create a new post"
3. elementType — pick the most specific match from the enum
4. screenRegion — where is this element on the screen physically
5. visualDescription — describe appearance: color, shape, icon symbol, relative size
6. alternateLabels — other text this element might show. include both English and Hinglish variants if applicable
7. fallbackHint — concrete recovery action if element not found. start with "if" or "scroll" or "go back"
8. parentContainer — name of the UI section. use standard Android UI names
9. appPackage — the correct Android package name for the app in the task
10. Generate complete steps from app launch to task completion
11. First step should always be: open the app (APP_ICON on home screen or app drawer)
12. Keep steps atomic — one tap per step`;

const ELEMENT_TYPE_ENUM = new Set([
  'BUTTON', 'ICON_BUTTON', 'FAB', 'TEXT_INPUT', 'NAV_ITEM', 'TOGGLE',
  'APP_ICON', 'LIST_ITEM', 'IMAGE', 'TAB', 'OVERFLOW_MENU', 'BACK_BUTTON', 'OTHER',
]);
const SCREEN_REGION_ENUM = new Set([
  'top', 'top_center', 'bottom', 'bottom_right', 'center', 'left', 'right', 'full',
]);

/**
 * Validate and normalise a single enriched step. Missing or invalid fields are
 * filled with safe defaults rather than throwing, so a partial model response
 * never crashes the route.
 */
function validateEnrichedStep(step, index) {
  const s = step && typeof step === 'object' ? step : {};

  let elementType = typeof s.elementType === 'string' ? s.elementType.toUpperCase() : 'OTHER';
  if (!ELEMENT_TYPE_ENUM.has(elementType)) elementType = 'OTHER';

  let screenRegion = typeof s.screenRegion === 'string' ? s.screenRegion.toLowerCase() : 'center';
  if (!SCREEN_REGION_ENUM.has(screenRegion)) screenRegion = 'center';

  let alternateLabels = Array.isArray(s.alternateLabels)
    ? s.alternateLabels.filter((l) => typeof l === 'string' && l.trim() !== '')
    : [];

  return {
    stepNumber: Number.isInteger(s.stepNumber) ? s.stepNumber : index + 1,
    instruction: typeof s.instruction === 'string' && s.instruction.trim() !== ''
      ? s.instruction
      : 'Follow the dot',
    findDescription: typeof s.findDescription === 'string' ? s.findDescription : '',
    elementType,
    screenRegion,
    visualDescription: typeof s.visualDescription === 'string' ? s.visualDescription : '',
    alternateLabels,
    fallbackHint: typeof s.fallbackHint === 'string' && s.fallbackHint.trim() !== ''
      ? s.fallbackHint
      : 'scroll down to find the element',
    parentContainer: typeof s.parentContainer === 'string' ? s.parentContainer : '',
  };
}

/**
 * Parses+normalizes a raw enriched-planner model response into
 * { appPackage, appName, steps }. Shared by every provider so the JSON shape
 * returned by POST /plan never depends on which model produced it.
 */
function parseEnrichedPlan(rawText, task) {
  const parsed = JSON.parse(stripFences(rawText));
  const rawSteps = Array.isArray(parsed.steps) ? parsed.steps : [];
  const steps = rawSteps.map((s, i) => validateEnrichedStep(s, i));

  const appPackage =
    (typeof parsed.appPackage === 'string' && parsed.appPackage.trim() !== ''
      ? parsed.appPackage
      : null) || resolveAppPackage(task) || '';

  const appName = typeof parsed.appName === 'string' ? parsed.appName : '';

  return { appPackage, appName, steps };
}

// ── macOS desktop planner (POST /plan, platform=macos) ─────────────────────

const DESKTOP_REGIONS = ['menuBar', 'ribbon', 'dialog', 'sidebar', 'spreadsheet', 'statusBar', 'fullScreen'];

function getDesktopSystemPrompt() {
  return `
You are Waylo, an AI guide that helps users learn Mac desktop software.
Generate a step-by-step guide for the given task.
Return ONLY valid JSON, no explanation, no markdown.

SOLVE IT THE FASTEST WAY, BUT FINISH THE JOB. Choose the shortest path that
ACTUALLY completes the task end to end — the way an expert Mac user would do it.
Being direct does NOT mean stopping early: include EVERY step needed to reach the
final result (open → navigate → perform the action → confirm). Never end the plan
before the task is truly done.
- Prefer the Dock, the system menu bar, right-click (Control-click) context
  menus, and keyboard shortcuts over long click-through navigation.
- OPEN APPS THE QUICKEST WAY: to open an app or a system area, click its icon in
  the Dock if it's likely there; otherwise open it via SPOTLIGHT using three
  steps: a "key" step instructing "Press Command+Space to open Spotlight" (key
  "space"), a "type" step typing the app's exact name, and a "key" step "Press
  Return" (key "return"). Use Spotlight whenever the app may NOT be in the Dock
  (e.g. Photo Booth, Disk Utility). Do NOT route through the Apple menu or nested
  menus to launch something.
- FINISH THE WHOLE TASK, even across MULTIPLE apps. Do not stop after the first
  app. Example: "take a photo and send it on WhatsApp" = open Photo Booth → take
  the photo → locate/open the saved photo → open WhatsApp → open the chat →
  attach the photo → SEND it. Include every step through the final send/confirm.
- USE CURRENT macOS NAMES. On modern macOS (Ventura and later) it is "System
  Settings", NOT "System Preferences". Use the names exactly as they appear on a
  recent macOS version. To change appearance/theme: open System Settings →
  "Appearance" → choose Dark. Do not invent old menu paths.
- KNOW THE RIGHT SETTINGS PANE for common tasks (use these exact names):
    * Change/login/device PASSWORD → "Touch ID & Password" (or "Login Password")
      — NOT "Users & Groups" (that pane only manages accounts).
    * Wi-Fi / network → "Wi-Fi" or "Network".
    * Screen brightness / resolution → "Displays".
    * Dark mode / theme / wallpaper tint → "Appearance".
    * Notifications → "Notifications". Bluetooth → "Bluetooth".
  Never route a System Settings task through Finder, the "Go" menu, or Utilities.
- Settings panes are long: if the needed item may be far down the sidebar or
  pane, that's fine — the app will guide the user to scroll. Still name the exact
  item.
- Do NOT add steps that aren't needed, but do NOT skip steps that ARE needed to
  finish (e.g. confirming a dialog, pressing Enter, clicking the final button).
- Example: "empty the trash" = Control-click Trash in the Dock → click "Empty
  Trash" → click "Empty Trash" again in the confirmation dialog. All three steps.
- Think through the WHOLE flow to the end goal before writing the steps.

Format:
{
  "task": "original task",
  "app": "app name (e.g. Microsoft Word, Excel, Safari, Finder)",
  "steps": [
    {
      "index": 1,
      "action": "click",
      "instruction": "Simple, warm English instruction for the user",
      "targetLabel": "the COMPLETE exact visible text on the element, e.g. Empty Bin",
      "elementDescription": "natural-language description of the element + location",
      "screenRegion": "ribbon",
      "targetType": "text",
      "controlKind": "button",
      "anchorText": "",
      "anchorPosition": "",
      "key": null
    }
  ]
}

Rules:
- A keyboard shortcut is ALWAYS a "key" step: set "action":"key", put the key in
  "key" ("return"/"tab"/"escape"/"space"), and leave "targetLabel" "". NEVER make
  a shortcut a "click" step, and NEVER put "Press …" text in "targetLabel".
  (Cmd+Space for Spotlight → action "key", key "space", instruction "Press
  Command and Space to open Spotlight".)
- ONLY reference UI elements you are confident actually exist. Do NOT invent
  buttons. If unsure of an app's exact controls, use the menu bar (File, Edit,
  Share…) or a reliable keyboard shortcut instead. Many apps auto-save or have no
  "Save" button (e.g. Photo Booth keeps photos automatically) — don't invent one.
- "action" classifies the step. Use exactly one of:
    "click" — the user clicks a UI element (a button, menu, icon, field).
    "type"  — the user types text (e.g. a file name). No element to click.
    "key"   — the user presses a key like Enter or Tab to confirm. Set "key"
              to "return", "tab", "escape" or "space".
    "info"  — an informational step with no action.
- "screenRegion" tells the app WHERE to look. Use exactly one of:
    "menuBar"     — the macOS top bar (Apple menu, File, Edit, View...)
    "ribbon"      — the app toolbar / ribbon with formatting buttons & icons
    "dialog"      — a popup window or modal dialog box
    "sidebar"     — a panel on the left or right side
    "spreadsheet" — the main content area (cells, document, canvas)
    "statusBar"   — the thin bar at the very bottom of the app
    "fullScreen"  — only if you are truly unsure where the element is
- For "click" steps, "targetLabel" MUST be the COMPLETE exact visible text on the
  element, including EVERY word (e.g. "Empty Bin" not "Empty"; "Empty Trash" not
  "Empty"; "New Folder" not "New"). Never shorten or drop words — the app matches
  the full label and a partial label points at the wrong control. If the element
  is icon-only (no visible text), set "targetLabel" to "" and describe it
  precisely in "elementDescription".
  EXCEPTION: use the control's REAL short label even if it seems incomplete — a
  button is often labelled just "Change…" or "Edit", not "Change Password". Use
  exactly what's printed on the button.
- "controlKind" is the KIND of control to click, so the app clicks a real control
  and not nearby header/label text. Use exactly one of: "button", "menuItem",
  "checkbox", "tab", "link", "field", or "text" (plain text/label). For a button
  like "Change…" use "button".
- "anchorText" + "anchorPosition" DISAMBIGUATE a target whose label is short or
  repeated. Set "anchorText" to a distinctive nearby visible label (e.g. the
  section header "Login Password"), and "anchorPosition" to where the target sits
  relative to it: "below", "above", "left", "right", or "near". Example: the
  "Change…" button → anchorText "Login Password", anchorPosition "right". Leave
  both "" when the label alone is unambiguous.
- For "type", "key" and "info" steps, set "targetLabel" to "".
- "targetType" tells the app which detector to use. Use exactly one of:
    "text" — the target shows readable WORDS (a button, menu item, link, label,
             checkbox with text). Most targets are "text". The app finds these
             with the accessibility tree + on-screen text reading.
    "icon" — the target is a graphical ICON / logo / glyph with NO visible text
             (a Dock app icon, a toolbar symbol like the share or gear icon, a
             company logo). The app finds these with icon detection (YOLO) + AI
             vision. Still put the element's NAME in "targetLabel" if it has one
             (e.g. a Dock icon's app name "System Settings", or its tooltip), and
             ALWAYS describe the icon's shape/color/symbol/location in
             "elementDescription".
- Split compound actions into separate steps. Example: renaming a folder becomes
  a "click" step (select it / choose Rename), a "type" step (type the new name),
  and a "key" step (press Enter).
- "elementDescription" includes the element's role and a location hint.
- "instruction" is clear, warm and action-oriented.
- Use as many steps as the task genuinely needs to reach the final result (up to
  15). Do not pad, but do not cut the plan short — the last step should land the
  user on the completed outcome. Each step = one click, one type, or one key press.`.trim();
}

/** Parses+normalizes a raw desktop-planner model response into { task, app, steps }. */
function parseDesktopPlan(rawText) {
  const plan = JSON.parse(stripFences(rawText));

  if (Array.isArray(plan.steps)) {
    plan.steps = plan.steps.map((s, i) => ({
      index: typeof s.index === 'number' ? s.index : i + 1,
      action: ['click', 'type', 'key', 'info'].includes(s.action) ? s.action : 'click',
      instruction: s.instruction,
      targetLabel: typeof s.targetLabel === 'string' ? s.targetLabel : '',
      elementDescription:
        s.elementDescription || s.findDescription || s.instruction || '',
      screenRegion: DESKTOP_REGIONS.includes(s.screenRegion) ? s.screenRegion : 'fullScreen',
      targetType: s.targetType === 'icon' ? 'icon' : 'text',
      controlKind: typeof s.controlKind === 'string' ? s.controlKind : '',
      anchorText: typeof s.anchorText === 'string' ? s.anchorText : '',
      anchorPosition: typeof s.anchorPosition === 'string' ? s.anchorPosition : '',
      key: typeof s.key === 'string' ? s.key : null,
      // Keep findDescription for backward compatibility with older clients.
      findDescription: s.findDescription || s.elementDescription || s.instruction || '',
    }));
  }

  return plan;
}

// ── Desktop recovery (POST /recover) ────────────────────────────────────────

function getRecoverySystemPrompt() {
  return `
You are Waylo, helping an elderly user complete a task on their Mac. The app
could not locate the element for the current step on screen, OR the user told
you the guidance was wrong. Look carefully at the screenshot and help recover.

Decide between three responses:
1. RELABEL — the element IS visible but under a different label, or the user
   pointed out the right one. Return its exact visible text so the app can find it.
2. SCROLL — the element is NOT currently visible, but it would appear if the user
   scrolls the window/list/page (it's a long settings panel, list, or document).
   Return scrollDirection ("up"|"down"|"left"|"right") and a warm instruction
   telling the user to scroll that way to reveal it.
3. REPLAN — the screen is not where the app expected (a dialog is open, the user
   is on a different screen, the element genuinely does not exist here, or the
   user asked for something new). Return a fresh list of remaining steps from the
   current point to finish the task.

If the user gave feedback (e.g. "that's the wrong button", "this icon doesn't
exist here", "now also do X"), treat their words as the source of truth and
correct your guidance accordingly.

STRONGLY PREFER RELABEL or SCROLL. A REPLAN throws away the whole flow, so only
replan if the screen is a genuinely different context. NEVER switch which
settings section the task uses: to change a login/device PASSWORD the correct
pane is "Touch ID & Password" (or "Login Password") — NEVER "Users & Groups".
The element is usually just off-screen (scroll) or under a slightly different
label (relabel).

Return ONLY valid JSON, no markdown:
{
  "replan": false,
  "visibleLabel": "exact visible text of the element to click (empty otherwise)",
  "scrollDirection": "",
  "instruction": "updated warm instruction for this step",
  "steps": []
}
OR (scroll)
{
  "replan": false,
  "visibleLabel": "",
  "scrollDirection": "down",
  "instruction": "Scroll down to find the X option, then I'll point to it.",
  "steps": []
}
OR (replan)
{
  "replan": true,
  "visibleLabel": "",
  "scrollDirection": "",
  "instruction": "",
  "steps": [
    { "index": 1, "action": "click", "instruction": "...", "targetLabel": "exact visible text", "elementDescription": "...", "screenRegion": "fullScreen", "targetType": "text", "controlKind": "button", "anchorText": "", "anchorPosition": "", "key": null }
  ]
}

Rules for steps (when replanning): "action" is one of click/type/key/info.
"targetLabel" is exact visible text for click steps, "" otherwise. Max 8 steps.`.trim();
}

function getRecoveryUserText({ task, stepIndex, totalSteps, instruction, targetLabel, userMessage }) {
  return (
    `Task: ${task}\n` +
    `Stuck on step ${stepIndex} of ${totalSteps}.\n` +
    `Step instruction: ${instruction}\n` +
    `Element we looked for: ${targetLabel || '(no text label)'}\n` +
    (userMessage && userMessage.trim()
      ? `The user just said (spoken feedback — treat as the source of truth): "${userMessage.trim()}"\n`
      : '') +
    `Analyze the screenshot and respond with RELABEL, SCROLL or REPLAN JSON.`
  );
}

function parseRecoveryResponse(rawText) {
  const parsed = JSON.parse(stripFences(rawText));

  const replan = parsed.replan === true && Array.isArray(parsed.steps) && parsed.steps.length > 0;
  const steps = replan
    ? parsed.steps.map((s, i) => ({
        index: typeof s.index === 'number' ? s.index : i + 1,
        action: ['click', 'type', 'key', 'info'].includes(s.action) ? s.action : 'click',
        instruction: s.instruction || '',
        targetLabel: typeof s.targetLabel === 'string' ? s.targetLabel : '',
        elementDescription: s.elementDescription || s.findDescription || s.instruction || '',
        screenRegion: DESKTOP_REGIONS.includes(s.screenRegion) ? s.screenRegion : 'fullScreen',
        targetType: s.targetType === 'icon' ? 'icon' : 'text',
        controlKind: typeof s.controlKind === 'string' ? s.controlKind : '',
        anchorText: typeof s.anchorText === 'string' ? s.anchorText : '',
        anchorPosition: typeof s.anchorPosition === 'string' ? s.anchorPosition : '',
        key: typeof s.key === 'string' ? s.key : null,
        findDescription: s.findDescription || s.elementDescription || s.instruction || '',
      }))
    : [];

  return {
    replan,
    visibleLabel: typeof parsed.visibleLabel === 'string' ? parsed.visibleLabel : '',
    instruction: typeof parsed.instruction === 'string' ? parsed.instruction : '',
    scrollDirection: ['up', 'down', 'left', 'right'].includes(parsed.scrollDirection) ? parsed.scrollDirection : '',
    steps,
  };
}

// ── Object detection (POST /nova-vision) ────────────────────────────────────

function getDetectionPrompt(targetLabel, stepInstruction) {
  const schema = `{"${targetLabel}": [{"bbox": [x_min, y_min, x_max, y_max]}]}`;
  return `# Object Detection and Localization

## Objective
Detect and localize the specified UI element in this macOS screenshot.

## Target Element
${targetLabel}

## Context
The user is trying to: ${stepInstruction}

## Instructions
- Analyze the screenshot and find the ONE UI element described above
- It may be a button, menu item, toolbar icon, Dock icon, checkbox, or any interactive control
- If several elements could match, pick the single most likely interactive control the user should click
- Fit the bounding box tightly around just that element (not its surrounding container or row)
- Do not output duplicate or overlapping bounding boxes
- Be conservative: if you are not reasonably confident the element is actually present, return an empty list rather than guessing
- Coordinates use format [x_min, y_min, x_max, y_max] where:
  * (x_min, y_min) is the top-left corner
  * (x_max, y_max) is the bottom-right corner
  * All values are on a 0-1000 scale (0,0 = top-left of image, 1000,1000 = bottom-right)

## Output Requirements
Return ONLY a JSON object wrapped in triple backticks labeled json, like this:
\`\`\`json
${schema}
\`\`\`

If the element is not visible in the screenshot, return:
\`\`\`json
{"${targetLabel}": []}
\`\`\`

Briefly explain what you see, then provide the JSON.`;
}

/** Parses a detectObject response into { found, bbox, label } or { found:false }. */
function parseDetectionResponse(rawText, targetLabel) {
  let parsed;
  const fence = rawText.match(/```json\s*([\s\S]*?)```/);
  try {
    parsed = JSON.parse((fence ? fence[1] : rawText).trim());
  } catch {
    return { found: false };
  }

  const detections = parsed[targetLabel];
  if (!Array.isArray(detections) || detections.length === 0) {
    return { found: false };
  }

  const first = detections[0];
  let bbox;
  if (Array.isArray(first)) {
    bbox = first;
  } else if (Array.isArray(first && first.bbox)) {
    bbox = first.bbox;
  } else {
    return { found: false };
  }

  if (bbox.length !== 4 || bbox.some((v) => typeof v !== 'number' || v < 0 || v > 1000)) {
    return { found: false };
  }
  if (!(bbox[0] < bbox[2] && bbox[1] < bbox[3])) {
    return { found: false };
  }

  return { found: true, bbox, label: targetLabel };
}

// ── Concept Q&A (POST /qa, POST /ask-screen) ────────────────────────────────

function getConceptSystemPrompt(appName) {
  const app = appName || 'this app';
  return `You are Waylo, a friendly, patient assistant helping an elderly user learn ${app} on a Mac. ` +
    `Answer the question in 1 to 3 short, simple sentences. Use very plain language, no jargon, no markdown. ` +
    `If they are asking where something is on screen, tell them you'll show them with a red dot.`;
}

function getScreenQaSystemPrompt(appName) {
  const app = appName && appName.trim() ? appName : 'this app';
  return `You are Waylo, a friendly, patient tutor helping someone learn ${app} on a Mac. ` +
    `Look carefully at the screenshot and answer the user's question using what is ` +
    `actually visible on their screen. Be specific and refer to what you see. ` +
    `Reply in 1 to 4 short, simple sentences. Plain language, no jargon, no markdown. ` +
    `If the screen doesn't contain the answer, say so briefly and suggest what to do.`;
}

module.exports = {
  stripFences,
  resolveAppPackage,
  ENRICHED_SYSTEM_PROMPT,
  parseEnrichedPlan,
  validateEnrichedStep,
  getDesktopSystemPrompt,
  parseDesktopPlan,
  getRecoverySystemPrompt,
  getRecoveryUserText,
  parseRecoveryResponse,
  getDetectionPrompt,
  parseDetectionResponse,
  getConceptSystemPrompt,
  getScreenQaSystemPrompt,
};
