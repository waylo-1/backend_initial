/**
 * Semantic plan cache (AWS RDS Postgres + pgvector + Titan embeddings).
 *
 * Matches paraphrases: "freeze the top row" and "lock the first row" embed to
 * nearby vectors and hit the same cached plan. All failures are swallowed — on
 * error we return null so the caller falls through to live generation.
 *
 * AWS schema (plan_cache): id, task TEXT, platform TEXT, steps_json TEXT,
 *   embedding vector(1536). RPC: match_plan_cache(query_embedding, threshold,
 *   count, platform_filter) — filters platform with EXACT equality.
 */
const db = require('./db');
const { embedText } = require('./embeddings');

const PLAN_SIMILARITY_THRESHOLD = 0.92;

// Used only as a degraded fallback when the live model is throttled/unavailable —
// a slightly-looser match still beats a hard failure for the user.
const QUOTA_FALLBACK_SIMILARITY_THRESHOLD = 0.85;

/**
 * Bump the relevant platform's version whenever ITS planning prompt changes
 * meaningfully, to invalidate ALL previously cached plans for that platform
 * (tracked per-platform so improving one prompt doesn't also throw away the
 * other platform's still-good cached plans). The version is folded into the
 * `platform` value (which match_plan_cache filters on with exact equality), so
 * old rows simply stop matching. NOTE: we do NOT fold the version into the
 * embedding text — a short prefix barely moves a Titan vector, so stale plans
 * would still match.
 */
const PLAN_PROMPT_VERSIONS = {
  // v9 (2026-07-10): submenus/galleries/pickers must get their own choosing
  // step — old cached plans stop on the item that merely opens a chooser
  // (e.g. "insert a table" ended at Insert > Table, leaving the style gallery
  // open with nothing selected).
  // v10 (2026-07-10): per-app control locations (Pages colour lives in the
  // Format PANEL not the menu bar; Spotify's playlist is the "+" in the
  // sidebar; Night Shift is in Displays, never Appearance) — old cached plans
  // routed through the wrong menus entirely.
  // v11 (2026-07-10): Pages "Format" is the toolbar PAINTBRUSH button (icon),
  // not the menu-bar Format menu; the colour control is the round colour WHEEL
  // to the RIGHT of the Text Colour swatch, not the swatch itself.
  // v12 (2026-07-10): elementDescription must be a SHORT object name, not a
  // location sentence (the app feeds it to a vision model) — location goes in
  // anchorText/anchorPosition. Old cached plans have verbose descriptions.
  // v13 (2026-07-11): user-choice steps (which chat/file) → advanceOnAnyClick;
  // WhatsApp send-photo flow (attachment=+/paperclip, Photos&Videos, file
  // picker, Open, Send) spelled out. Old cached plans point at one chat and
  // assume a paperclip.
  // v14 (2026-07-11): Nova detection returns a self-reported confidence so the
  // app can describe instead of pointing at a low-confidence guess.
  // v15 (2026-07-11): Photo Booth flow (red camera button, 3s countdown wait,
  // newest thumbnail, File>Export, Save) — old plans skipped the countdown and
  // pointed at the wrong button; colour-described icons ("red camera button").
  // v16 (2026-07-11): colour-first descriptions for distinctive controls +
  // dark/light-aware shades; Photo Booth thumbnail is a user-choice step.
  // v17 (2026-07-13): hard NEVER-menu-bar rule for Pages/Numbers/Keynote text
  // formatting (a learned v16 plan routed Format>Font>Show Colors into the
  // unlabeled Colors window); invalidates that learned plan.
  // v18 (2026-08-03): web-app icon guidance — formatting/action buttons on a
  // web TOOLBAR (Gmail paperclip/star, Docs Bold B / image / link, Sheets chart)
  // are icon-only glyphs → mark targetType "icon" + anchorText to a nearby
  // label; menus stay "text"; prefer a text menu path over a toolbar icon. Old
  // cached web plans mislabel these as text and mis-ground on the page.
  // v19 (2026-08-04): in-web-app delete/trash/archive is an ICON on the page's
  // toolbar, never the macOS Finder Bin. "Delete an email in Gmail" = select the
  // email (user-choice) then click the trash ICON — old plans opened the Bin.
  // v20 (2026-08-04): prefer the visible TOOLBAR button (archive/delete/reply/
  // share/flag/view-toggle) over the menu bar for common NATIVE-app actions —
  // one obvious click, AX-named, and it exercises icon detection. Old plans
  // routed "archive mail" / "gallery view" through the menu bar and confused.
  // v21 (2026-08-10): every ICON target now carries "accessibleName" — the exact
  // aria-label / AXDescription a screen reader announces (Gmail paperclip =
  // "Attach files", Docs comment = "Add comment"). The client resolves icons by
  // a deep accessibility-tree search for that name — pixel-exact, free, first
  // run, no vision. Old cached plans lack the field, so re-plan to populate it.
  // v22 (2026-08-10): the live snapshot now carries the current web-page URL, and
  // the planner must START from where the user already is — no "open a tab /
  // search for Gmail" steps when they're already on mail.google.com. Old cached
  // plans front-load redundant navigation; re-plan without it.
  // v23 (2026-08-10): web-app navigation rules — a word like "History"/"Settings"
  // inside a site is the PAGE's item, never Chrome's menu bar; open a collapsed
  // ☰/More menu BEFORE its items (YouTube History = click Guide ☰ then History);
  // don't assume bookmarks. Old cached plans grounded on browser chrome / guessed
  // bookmark shortcuts; re-plan.
  // v24 (2026-08-10): open a site by typing the URL in the address bar, NEVER by
  // clicking a bookmark (they may not exist / look alike → wrong one). Personal
  // account-dropdown items ("your username/profile") are advanceOnAnyClick +
  // described, not pointed at (vision mislocates a fresh dropdown). Re-plan.
  // v25 (2026-08-10): opening a site is ONE url-gated step (action info + awaitURL
  // domain) — the client watches the browser URL and auto-advances however the
  // user navigates, no click→type→Return sequence, no bookmark. Re-plan.
  // v26 (2026-08-10): the avatar/profile icon that OPENS an account menu is a
  // POINTED icon (accessibleName Avatar/Account/…), NOT advanceOnAnyClick — v24
  // over-broadened and made it describe-only. Only the username entry INSIDE the
  // dropdown stays describe+any-click. Re-plan.
  // v27 (2026-08-10): XPRIZE curricula — Google AI Studio "get an API key" flow
  // taught end-to-end (Get API key → Create API key → project user-choice → Copy);
  // AI Studio accessible-name seeds; VIEW/CHECK tasks end on an auto-advancing
  // info step (no click on a value you only read). Re-plan.
  // v28 (2026-08-10): AI Studio flow corrected from a live run — after Create API
  // key: Choose an imported project → pick project (user-choice) → silent wait
  // step → Copy API key (full name; "Copy" matched nothing). Re-plan.
  // v29 (2026-08-10): AI Studio flow r2 from live run — project box is BELOW the
  // "Choose an imported project" label (anchor below + describe); a SECOND "Create
  // API key" confirm after picking the project; longer wait; copy is a describe
  // step (copy icon appears late & unfindable, stale cache had "Close dialog").
  // Also (client): accessibleName deep-AX now runs BEFORE OCR so a duplicate
  // visible label can't win over the real control. Re-plan.
  // v30 (2026-08-10): AI Studio copy is now a POINTED click icon (Gemini dots it,
  // like the 'Create key' confirm) instead of describe-only. Paired with a client
  // guard that ignores a stale close/cancel cached label for a non-close step
  // (kills the 'Close dialog' pollution). Re-plan.
  // v31 (2026-08-10): XPRIZE curriculum 2 — macOS System Settings navigation
  // (sidebar category → right-pane control) with exact flagship paths (bigger
  // text, Wi-Fi, Dark Mode, Bluetooth, wallpaper). Re-plan.
  // v32 (2026-08-10): XPRIZE curriculum 3 — Google Docs "write a resume" flow +
  // expanded Docs toolbar accessible-name seeds (bold/italic/lists/link/styles/
  // font-size, File>Download>PDF). Learn-the-app follow-ups use sessionContext.
  // v33 (2026-08-15): AI Studio flow polish — step 1 speech shortened to "Let's
  // open Google AI Studio." (URL auto-advance), and the COPY-key step no longer
  // uses bare accessibleName "Copy" (which hit "Copy project name to clipboard");
  // it points at the copy control on the generated key's row via vision. Re-plan.
  // v34 (2026-08-15): AI Studio copy step targets the "Copy key" BUTTON by its
  // visible text (targetType text, label "Copy key") instead of hunting a copy
  // icon by anchor — the anchor matched the wrong "API key" text and the dot
  // landed top-right. Text match is reliable (OCR score 1.0). Re-plan.
  // v35 (2026-08-15): AI Studio confirm button is "Create key" not "Create API
  // key" — the old label OCR-missed (0.30) and burned a slow Gemini miss before
  // recovery relabelled it. Target "Create key" as text (OCR 1.0). Copy step
  // label ("Copy key") kept identical so the user's ⌃⌥⌘N-taught location is
  // reused across runs. Re-plan.
  // v36 (2026-08-15): XPRIZE demo 2 — Photo Booth "take a photo" flow + WhatsApp
  // "send a photo" flow, plus the FOLLOW-UP MEMORY rule so "send this photo on
  // WhatsApp" after a Photo Booth shot references the just-taken photo. Re-plan.
  // v37 (2026-08-16): "make text bigger" rebuilt — click "Text size" to open the
  // sheet, BOX the whole slider (controlKind "slider", now mapped to AXSlider in
  // the app) instead of dotting the "Default" tick, then click "Done". Re-plan.
  macos: 'v37',
  // v9 (2026-07-06): granular/landmark-based/elderly-friendly rewrite of
  // ENRICHED_SYSTEM_PROMPT — old shallow plans (e.g. "open app" with no
  // completion steps) must not keep being served from cache.
  // v10 (2026-07-06): stop hard-committing to a screen corner when unsure —
  // old cached plans may assert stale/wrong absolute positions (e.g. account
  // button "top right" when it's actually bottom right in current app UIs).
  // v11 (2026-07-06): app-icon fallbackHint now routes through launcher search
  // instead of sideways swiping; added shortest-in-app-path rule (don't route
  // through Settings when a direct menu entry exists) — old cached plans may
  // still have swipe-paging fallbacks or Settings-routed detours.
  // v12 (2026-07-07): instructions must name exactly ONE element, never hedge
  // between layout variants ("tap either X or Y") — old cached plans may still
  // contain confusing either/or instructions.
  android: 'v13',
};
const versioned = (platform) => `${platform}__${PLAN_PROMPT_VERSIONS[platform] || PLAN_PROMPT_VERSIONS.macos}`;

/** pgvector text literal, e.g. "[0.1,0.2,...]". */
function toVector(arr) {
  return `[${arr.join(',')}]`;
}

/**
 * Returns a cached step plan (parsed object) for a similar task, or null.
 * @param {number} [threshold] - overrides PLAN_SIMILARITY_THRESHOLD. Used to
 *   widen the match (a lower threshold) when the live model is unavailable and
 *   a slightly-less-similar cached plan beats a hard failure.
 */
async function getPlanFromCache(platform, taskText, threshold = PLAN_SIMILARITY_THRESHOLD) {
  try {
    const embedding = await embedText(taskText);
    const { rows } = await db.query(
      'SELECT * FROM match_plan_cache($1::vector, $2, $3, $4)',
      [toVector(embedding), threshold, 1, versioned(platform)]
    );
    if (!rows || rows.length === 0) return null;
    try {
      return JSON.parse(rows[0].steps_json);
    } catch {
      return null;
    }
  } catch (e) {
    console.error('[semanticPlanCache] getPlanFromCache:', e.message);
    return null;
  }
}

/** Stores a generated plan. Non-fatal on error. */
async function storePlanInCache(platform, taskText, stepPlan) {
  try {
    const embedding = await embedText(taskText);
    await db.query(
      'INSERT INTO plan_cache (task, platform, steps_json, embedding) VALUES ($1, $2, $3, $4::vector)',
      [taskText, versioned(platform), JSON.stringify(stepPlan), toVector(embedding)]
    );
  } catch (e) {
    console.error('[semanticPlanCache] storePlanInCache:', e.message);
  }
}

/**
 * Learns a CORRECTED plan: removes any near-duplicate cached plans for this task
 * (so the stale/wrong one can't win) and inserts the corrected one. Called after
 * a guide completes whose plan was changed mid-run — the system remembers the
 * fix so the same task is right next time, with no prompt edit or redeploy.
 */
async function learnPlan(platform, taskText, stepPlan) {
  try {
    const embedding = await embedText(taskText);
    const vec = toVector(embedding);
    const plat = versioned(platform);
    // Drop stale near-identical plans for this task (cosine sim > 0.95).
    await db.query(
      'DELETE FROM plan_cache WHERE platform = $1 AND 1 - (embedding <=> $2::vector) > 0.95',
      [plat, vec]
    );
    await db.query(
      'INSERT INTO plan_cache (task, platform, steps_json, embedding) VALUES ($1, $2, $3, $4::vector)',
      [taskText, plat, JSON.stringify(stepPlan), vec]
    );
    console.log(`[semanticPlanCache] learned corrected plan for "${taskText}"`);
  } catch (e) {
    console.error('[semanticPlanCache] learnPlan:', e.message);
  }
}

/**
 * Forgets a plan the user marked WRONG: deletes cached plans for this task so
 * the bad path is never reused (the next run regenerates fresh).
 */
async function forgetPlan(platform, taskText) {
  try {
    const embedding = await embedText(taskText);
    const { rowCount } = await db.query(
      'DELETE FROM plan_cache WHERE platform = $1 AND 1 - (embedding <=> $2::vector) > 0.90',
      [versioned(platform), toVector(embedding)]
    );
    console.log(`[semanticPlanCache] forgot ${rowCount} plan(s) for "${taskText}"`);
  } catch (e) {
    console.error('[semanticPlanCache] forgetPlan:', e.message);
  }
}

module.exports = {
  getPlanFromCache,
  storePlanInCache,
  learnPlan,
  forgetPlan,
  PLAN_SIMILARITY_THRESHOLD,
  QUOTA_FALLBACK_SIMILARITY_THRESHOLD,
};
