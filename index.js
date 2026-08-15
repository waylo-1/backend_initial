/**
 * Waylo Backend - Main Express Server
 * AI-powered smartphone guide for elderly users
 *
 * Required env vars:
 *   DATABASE_URL          - AWS RDS/Aurora Postgres connection string (pgvector)
 *   AI_PROVIDER            - "bedrock" (default) or "gemini" — see services/llm.js
 *   AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION  - required if AI_PROVIDER=bedrock
 *   BEDROCK_TEXT_MODEL_ID, BEDROCK_VISION_MODEL_ID, BEDROCK_OBJECT_DETECT_MODEL_ID,
 *   BEDROCK_EMBED_MODEL_ID                                - Bedrock model ids
 *   GEMINI_API_KEY, GEMINI_TEXT_MODEL, GEMINI_VISION_MODEL - required if AI_PROVIDER=gemini
 *   PORT                  - server port (default 3000)
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { detectLanguage } = require('./langdetect');
const { generateDesktopSteps, generateEnrichedSteps, recoverDesktopStep, detectObject, answerConcept, answerWithScreen, isQuotaOrThrottleError, pickElement } = require('./services/llm');
const planCache = require('./planCache');
const db = require('./db');
const semanticPlanCache = require('./semanticPlanCache');
const stepLabelCache = require('./stepLabelCache');
const pickMemory = require('./pickMemory');
const users = require('./users');
const visionRouter = require('./routes/vision');
const visionFallbackRouter = require('./routes/vision-fallback');
const failureRouter = require('./routes/failure');
const yoloDetectRoute = require('./routes/yolo-detect');
const resolveRouter = require('./routes/resolve');
const actRouter = require('./routes/act');
const actVisionRouter = require('./routes/act-vision');
const actComputerRouter = require('./routes/act-computer');
const iconMemoryRouter = require('./routes/icon-memory');
const { CURRICULA, findCurriculum } = require('./curricula');

const app = express();
const PORT = process.env.PORT || 3000;

// Don't advertise the framework.
app.disable('x-powered-by');

// Basic security response headers (no external dependency).
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-DNS-Prefetch-Control', 'off');
  next();
});

// CORS: if ALLOWED_ORIGINS is set (comma-separated), restrict to it; otherwise
// allow all (the macOS app is a native client and sends no Origin header).
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);
app.use(cors(allowedOrigins.length
  ? { origin: (origin, cb) => cb(null, !origin || allowedOrigins.includes(origin)) }
  : {}));

// Raised limit: /vision receives Base64 JPEG screenshots which exceed the
// default 100kb body limit.
app.use(express.json({ limit: '12mb' }));

// Global rate limiter — protects every endpoint from abuse. /plan keeps its
// own tighter limiter below.
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please slow down' },
});
app.use(globalLimiter);

// Rate limiter for /plan endpoint
const planLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 20, // 20 requests per minute
  message: { error: 'Too many requests, please wait a minute' },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Health check endpoint
 */
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString()
  });
});

/**
 * POST /plan
 * Generate step-by-step instructions for a task
 */
app.post('/plan', planLimiter, async (req, res) => {
  try {
    const { task, platform } = req.body;

    if (!task || typeof task !== 'string' || task.trim().length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Task is required and must be a non-empty string'
      });
    }

    // FREE-TIER PAYWALL: block once the signed-in user is out of free tasks,
    // BEFORE spending a Gemini call. The app surfaces `details` to the user.
    if (req.body.userEmail) {
      const status = await users.usageStatus(req.body.userEmail);
      if (!status.allowed) {
        const upgrade = process.env.UPGRADE_URL || 'your Waylo account page';
        return res.status(402).json({
          success: false, code: 'limit_reached',
          plan: status.plan, used: status.used, limit: status.limit,
          error: 'Free tasks used up',
          details: `You've used all ${status.limit} free tasks. Upgrade to the ₹100 / 100-task plan at ${upgrade} to keep going.`,
        });
      }
    }

    // Usage tracking (business evidence + the free-tier counter). The app sends
    // the signed-in user's email; fire-and-forget so it never slows a plan.
    if (req.body.userEmail) {
      users.trackUsage(req.body.userEmail, task, 'task', platform || '').catch(() => {});
    }

    // macOS desktop companion (Waylo Desktop) uses a different element model
    // and expects { task, app, steps:[{ index, instruction, findDescription }] }.
    if (platform === 'macos') {
      console.log(`Plan requested (macOS): ${task}`);

      // Learning-session context (a compact summary of what the user just did
      // in this skill session). A follow-up like "now make it bold" is only
      // meaningful WITH this context, so session plans skip the semantic cache
      // in both directions.
      const sessionContext = typeof req.body.sessionContext === 'string'
        ? req.body.sessionContext.slice(0, 1200) : '';

      // Optional free-text "where am I now" the user typed — ground truth for the
      // plan's starting point (native apps the AX snapshot can't fully see).
      const userContext = typeof req.body.userContext === 'string'
        ? req.body.userContext.slice(0, 400).trim() : '';

      // Semantic cache: a paraphrase of a prior task returns instantly, no LLM
      // call. Skip it when the user gave explicit starting context — the same
      // task from a different starting state needs a different plan.
      if (!sessionContext && !userContext) {
        const cachedPlan = await semanticPlanCache.getPlanFromCache('macos', task);
        if (cachedPlan) {
          console.log(`Plan semantic-cache HIT (macOS) for: ${task}`);
          return res.json({ ...cachedPlan, cached: true });
        }
      }

      // Optional live-screen grounding from the macOS client (AX-tree snapshot).
      const screenContext = typeof req.body.screenContext === 'string'
        ? req.body.screenContext : '';
      if (screenContext) {
        console.log(`Plan grounding (macOS): ${screenContext.length} chars of screen context`);
      }

      let plan;
      try {
        plan = await generateDesktopSteps(task, screenContext, sessionContext, userContext);
      } catch (genError) {
        if (!isQuotaOrThrottleError(genError)) throw genError;

        console.warn(`Plan generation throttled (macOS) for "${task}" — trying a degraded semantic-cache match`);
        const fallbackPlan = await semanticPlanCache.getPlanFromCache(
          'macos', task, semanticPlanCache.QUOTA_FALLBACK_SIMILARITY_THRESHOLD
        );
        if (fallbackPlan) {
          console.log(`Plan quota-fallback HIT (macOS, degraded similarity) for: ${task}`);
          return res.json({ ...fallbackPlan, cached: true, degraded: true });
        }

        console.error('Plan generation throttled (macOS) and no cache fallback available:', genError.message);
        return res.status(429).json({
          success: false,
          error: 'AI service is temporarily busy. Please try again in a moment.',
          code: 'quota_exceeded',
        });
      }

      // A syntactically-valid but EMPTY plan is a transient model hiccup, not
      // an answer — a client can't guide with 0 steps. Regenerate once, then
      // fail honestly (never serve or cache an empty plan).
      if (!plan.steps || plan.steps.length === 0) {
        console.warn(`Empty plan for "${task}" — regenerating once`);
        try { plan = await generateDesktopSteps(task, screenContext, sessionContext); } catch { /* fall through */ }
        if (!plan?.steps || plan.steps.length === 0) {
          return res.status(502).json({
            success: false,
            error: "I couldn't work out the steps for that — please try rephrasing the task.",
          });
        }
      }

      console.log(`Bedrock desktop response received, ${plan.steps?.length || 0} steps parsed`);

      // Store for next time (fire-and-forget; only cache non-empty plans).
      // Grounded plans are NOT cached: a plan that (correctly) skips opening
      // the app because it was already frontmost would be wrong as the
      // general cached answer for this task from a cold start.
      if (plan.steps && plan.steps.length > 0 && !screenContext && !sessionContext) {
        semanticPlanCache.storePlanInCache('macos', task, plan).then(() => {}, () => {});
      }
      return res.json(plan);
    }

    // Detect language
    const language = detectLanguage(task);
    console.log(`Plan requested: ${task} | Language detected: ${language}`);

    // Serve from the server-side cache when possible — repeat tasks cost $0.
    const cached = planCache.get(task);
    if (cached) {
      console.log(`Plan cache HIT for: ${task}`);
      return res.json({
        success: true,
        appPackage: cached.appPackage,
        appName: cached.appName,
        language,
        steps: cached.steps,
        totalSteps: cached.steps.length,
        cached: true
      });
    }

    // Generate enriched 8-field steps. The richer per-step metadata gives the
    // Android detection layers much more signal to match against, reducing
    // costly vision fallbacks.
    let plan;
    try {
      plan = await generateEnrichedSteps(task);
    } catch (genError) {
      if (!isQuotaOrThrottleError(genError)) throw genError;

      console.warn(`Plan generation throttled for "${task}" — trying a degraded semantic-cache match`);
      const fallbackPlan = await semanticPlanCache.getPlanFromCache(
        'android', task, semanticPlanCache.QUOTA_FALLBACK_SIMILARITY_THRESHOLD
      );
      if (fallbackPlan) {
        console.log(`Plan quota-fallback HIT (degraded similarity) for: ${task}`);
        return res.json({
          success: true,
          appPackage: fallbackPlan.appPackage,
          appName: fallbackPlan.appName,
          language,
          steps: fallbackPlan.steps,
          totalSteps: fallbackPlan.steps.length,
          cached: true,
          degraded: true,
        });
      }

      console.error('Plan generation throttled and no cache fallback available:', genError.message);
      return res.status(429).json({
        success: false,
        error: 'AI service is temporarily busy. Please try again in a moment.',
        code: 'quota_exceeded',
      });
    }
    console.log(`Bedrock response received, ${plan.steps.length} enriched steps parsed`);

    // Cache for next time (only worth caching a non-empty plan).
    if (plan.steps.length > 0) {
      planCache.set(task, '', plan);
      // Also store in the semantic (pgvector) cache so a paraphrase can still
      // be served — including as a degraded fallback above — if the live model
      // is throttled later. Fire-and-forget; failures are swallowed.
      semanticPlanCache.storePlanInCache('android', task, {
        appPackage: plan.appPackage,
        appName: plan.appName,
        steps: plan.steps,
      }).then(() => {}, () => {});
    }

    res.json({
      success: true,
      appPackage: plan.appPackage,
      appName: plan.appName,
      language,
      steps: plan.steps,
      totalSteps: plan.steps.length
    });

  } catch (error) {
    console.error('Error in /plan:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to generate plan',
      details: error.message
    });
  }
});

// Vision endpoint (Layer 3: locate + troubleshoot)
app.use('/vision', visionRouter);

// Vision fallback endpoint for the macOS desktop companion
app.use('/vision-fallback', visionFallbackRouter);

/**
 * POST /label/lookup
 * Returns a previously-cached working AX label for a step, if any.
 * Body: { appName, stepDescription }
 */
app.post('/label/lookup', async (req, res) => {
  try {
    const { appName, stepDescription } = req.body || {};
    if (!appName || !stepDescription) return res.json({ found: false });
    const label = await stepLabelCache.getLabelFromCache(appName, stepDescription);
    return res.json(label ? { found: true, axLabel: label } : { found: false });
  } catch (e) {
    console.error('Error in /label/lookup:', e.message);
    return res.json({ found: false });
  }
});

/**
 * POST /label/store
 * Caches a working AX label for a step (fire-and-forget). 202 immediately.
 * Body: { appName, stepDescription, axLabel }
 */
app.post('/label/store', (req, res) => {
  const { appName, stepDescription, axLabel } = req.body || {};
  if (appName && stepDescription && axLabel) {
    stepLabelCache.storeLabelInCache(appName, stepDescription, axLabel).then(() => {}, () => {});
  }
  return res.status(202).json({ accepted: true });
});

/**
 * POST /pick/lookup
 * Fleet-wide ambiguity pick: the remembered relative position for a step.
 * Body: { app, stepKey } → { found, relX, relY }
 */
app.post('/pick/lookup', async (req, res) => {
  try {
    const { app: appName, stepKey } = req.body || {};
    if (!appName || !stepKey) return res.json({ found: false });
    const p = await pickMemory.lookupPick(appName, stepKey);
    return res.json(p ? { found: true, relX: p.relX, relY: p.relY } : { found: false });
  } catch (e) {
    console.error('Error in /pick/lookup:', e.message);
    return res.json({ found: false });
  }
});

/**
 * POST /pick/store
 * Remember the user's disambiguation choice (fire-and-forget). 202 immediately.
 * Body: { app, stepKey, relX, relY } (relX/relY are 0–1 fractions of the window)
 */
app.post('/pick/store', (req, res) => {
  const { app: appName, stepKey, relX, relY } = req.body || {};
  if (appName && stepKey && typeof relX === 'number' && typeof relY === 'number') {
    pickMemory.storePick(appName, stepKey, relX, relY).then(() => {}, () => {});
  }
  return res.status(202).json({ accepted: true });
});

/**
 * POST /qa
 * Mid-session concept question — plain text answer (no vision).
 * Body: { question, appName }
 */
app.post('/qa', async (req, res) => {
  try {
    const { question, appName } = req.body || {};
    if (!question || typeof question !== 'string') {
      return res.status(400).json({ error: 'question is required' });
    }
    const answer = await answerConcept({ question, appName: appName || '' });
    return res.json({ answer });
  } catch (error) {
    console.error('Error in /qa:', error.message);
    return res.status(500).json({ error: 'qa failed', details: error.message });
  }
});

/**
 * POST /ask-screen
 * Vision Q&A — answers a free-form question about what's on the user's screen,
 * using a screenshot (for learning). No pointer, just an explanation.
 * Body: { question, screenshot, appName }
 */
app.post('/ask-screen', async (req, res) => {
  try {
    const { question, screenshot, appName } = req.body || {};
    if (!question || !screenshot) {
      return res.status(400).json({ error: 'question and screenshot are required' });
    }
    const answer = await answerWithScreen({ question, screenshot, appName: appName || '' });
    return res.json({ answer });
  } catch (error) {
    console.error('Error in /ask-screen:', error.message);
    return res.status(500).json({ error: 'ask-screen failed', details: error.message });
  }
});

/**
 * POST /nova-vision
 * Layer 3 grounding via Nova 2 Lite object detection.
 * Body: { image_base64, target_label, step_instruction }
 * Returns: { found, bbox: [xMin,yMin,xMax,yMax] (0-1000), label } or { found: false }
 */
// POST /pick-element — Judge-Mode disambiguation: Gemini picks the right badge
// among numbered candidates the client stamped on the screenshot.
app.post('/pick-element', async (req, res) => {
  try {
    const { image_base64, target, step_instruction, count } = req.body || {};
    if (!image_base64 || !target || !count) return res.status(400).json({ id: 0 });
    const result = await pickElement({
      screenshot: image_base64, target,
      stepInstruction: step_instruction || '', count,
    });
    return res.json(result);
  } catch (error) {
    console.error('Error in /pick-element:', error.message);
    return res.status(200).json({ id: 0 });
  }
});

app.post('/nova-vision', async (req, res) => {
  try {
    const { image_base64, target_label, step_instruction } = req.body || {};
    if (!image_base64 || !target_label) {
      return res.status(400).json({ found: false, error: 'image_base64 and target_label are required' });
    }
    const result = await detectObject({
      screenshot: image_base64,
      targetLabel: target_label,
      stepInstruction: step_instruction || '',
      // Words the client's local OCR read — free grounding context (capped).
      ocrContext: typeof req.body.ocr_context === 'string'
        ? req.body.ocr_context.slice(0, 1200) : '',
      // JUDGE / MAX-ACCURACY: the client asks Gemini to REASON about the exact
      // element (thinking budget) — more accurate grounding, more tokens.
      highAccuracy: req.body.high_accuracy === true,
    });
    return res.json(result);
  } catch (error) {
    console.error('Error in /nova-vision:', error.message);
    return res.status(200).json({ found: false });
  }
});

/**
 * POST /recover
 * Self-healing: when the desktop app can't locate an element, it sends a
 * screenshot. The model relabels the element or replans the remaining steps.
 */
app.post('/recover', async (req, res) => {
  try {
    const { screenshot, task, instruction, targetLabel, stepIndex = 0, totalSteps = 1, userMessage } = req.body || {};
    if (!screenshot || !task) {
      return res.status(400).json({ error: 'screenshot and task are required' });
    }
    const result = await recoverDesktopStep({
      screenshot,
      task,
      instruction: instruction || '',
      targetLabel: targetLabel || '',
      stepIndex,
      totalSteps,
      userMessage: userMessage || '',
    });
    return res.json(result);
  } catch (error) {
    console.error('Error in /recover:', error.message);
    return res.status(500).json({ error: 'recover failed', details: error.message });
  }
});

// Detection failure logging endpoint (stores misses for future YOLO training)
app.use('/failure', failureRouter);
app.use('/resolve', resolveRouter);
app.use('/act', actRouter);
app.use('/act-vision', actVisionRouter);
app.use('/act-computer', actComputerRouter);
app.use('/icon', iconMemoryRouter);

// Hand-authored learning curricula (lesson lists; each lesson plans via /plan).
app.get('/curriculum', (_req, res) => {
  res.json({ curricula: CURRICULA.map(({ id, displayName, description, lessons }) =>
    ({ id, displayName, description, lessonCount: lessons.length })) });
});
app.get('/curriculum/:query', (req, res) => {
  const c = findCurriculum(req.params.query);
  if (!c) return res.status(404).json({ error: 'no curriculum for that app yet' });
  const { id, displayName, description, lessons } = c;
  res.json({ id, displayName, description, lessons });
});

// ── Users + usage (business evidence) ───────────────────────────────────────
// POST /register — the Vercel sign-in page OR the app registers an email.
// Body: { email, name?, source? }  ("source": "website" | "app" | campaign tag)
app.post('/register', async (req, res) => {
  try {
    const email = await users.registerUser(req.body?.email, req.body?.name, req.body?.source);
    if (!email) return res.status(400).json({ ok: false, error: 'a valid email is required' });
    const user = await users.getUser(email);
    return res.json({ ok: true, email, plan: user?.plan || 'free' });
  } catch (e) {
    console.error('[users] register failed:', e.message);
    return res.status(500).json({ ok: false, error: 'register failed' });
  }
});

// POST /usage — generic event logger (task completions, page views, etc.).
// Body: { email?, task?, event? }  (event defaults to "task")
app.post('/usage', async (req, res) => {
  try {
    await users.trackUsage(req.body?.email, req.body?.task, req.body?.event || 'task', req.body?.platform || '');
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false });
  }
});

// GET /config — REMOTE CONFIG. The app fetches this at launch to control tunable
// behaviour (Judge Mode, thresholds, a broadcast message, update prompts) WITHOUT
// a re-download. Edit app-config.json and it takes effect on the next fetch — no
// restart, because it's read per request.
const fs = require('fs');
app.get('/config', (req, res) => {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(require('path').join(__dirname, 'app-config.json'), 'utf8')); }
  catch (e) { /* fall back to defaults below */ }
  res.json({
    maxAccuracy: typeof cfg.maxAccuracy === 'boolean' ? cfg.maxAccuracy : true,
    novaMinConfidence: typeof cfg.novaMinConfidence === 'number' ? cfg.novaMinConfidence : 0.55,
    message: typeof cfg.message === 'string' ? cfg.message : '',
    messageLevel: typeof cfg.messageLevel === 'string' ? cfg.messageLevel : 'info',
    latestVersion: typeof cfg.latestVersion === 'string' ? cfg.latestVersion : '1.0',
    updateURL: typeof cfg.updateURL === 'string' ? cfg.updateURL : '',
  });
});

// GET /me?email= — the app/website reads the user's plan + remaining free tasks.
app.get('/me', async (req, res) => {
  try { return res.json(await users.usageStatus(req.query.email || '')); }
  catch (e) { return res.status(500).json({ error: e.message }); }
});

// POST /upgrade — the ₹100 / 100-task plan. The customer paid you by UPI and
// submits their email + UPI reference (reconcile against your bank statement).
// Body: { email, ref?, name? }
app.post('/upgrade', async (req, res) => {
  try {
    const email = await users.registerUser(req.body?.email, req.body?.name, 'upgrade');
    if (!email) return res.status(400).json({ ok: false, error: 'A valid email is required' });
    await users.setPlan(email, 'paid');
    // Keep the UPI reference for reconciliation / audit trail.
    await users.trackUsage(email, 'UPI ' + String(req.body?.ref || 'n/a').slice(0, 60), 'payment', 'web').catch(() => {});
    const status = await users.usageStatus(email);
    return res.json({ ok: true, email, plan: 'paid', remaining: status.remaining });
  } catch (e) {
    console.error('[upgrade] failed:', e.message);
    return res.status(500).json({ ok: false, error: 'upgrade failed' });
  }
});

// GET /admin/stats(.json) — analytics dashboard (product + funnel evidence).
// Guarded by ?key=ADMIN_KEY when ADMIN_KEY is set; open otherwise (dev).
function adminAllowed(req) {
  const key = process.env.ADMIN_KEY;
  return !key || req.query.key === key;
}
app.get('/admin/stats.json', async (req, res) => {
  if (!adminAllowed(req)) return res.status(401).json({ error: 'unauthorized' });
  try { return res.json(await users.getStats()); }
  catch (e) { return res.status(500).json({ error: e.message }); }
});
app.get('/admin/stats', async (req, res) => {
  if (!adminAllowed(req)) return res.status(401).send('unauthorized');
  try {
    const s = await users.getStats();
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send(renderStatsHTML(s));
  } catch (e) {
    return res.status(500).send('error: ' + e.message);
  }
});

function renderStatsHTML(s) {
  const esc = (x) => String(x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const maxDaily = Math.max(1, ...s.daily.map((d) => d.n));
  const bars = s.daily.map((d) =>
    `<div class="bar"><div class="fill" style="height:${Math.round((d.n / maxDaily) * 120)}px" title="${d.n}"></div><span>${esc(d.day.slice(5))}</span></div>`).join('');
  const rows = s.topTasks.map((t) => `<tr><td>${esc(t.task)}</td><td class="num">${t.n}</td></tr>`).join('') || '<tr><td colspan="2">No tasks yet</td></tr>';
  const signupRows = (s.recentUsers || []).map((u) =>
    `<tr><td>${esc(u.email)}</td><td>${esc(u.plan)}</td><td>${esc(u.source || '')}</td><td class="num">${esc(u.joined)}</td></tr>`).join('') || '<tr><td colspan="4">No signups yet</td></tr>';
  const card = (label, value, sub = '') =>
    `<div class="card"><div class="v">${esc(value)}</div><div class="l">${esc(label)}</div>${sub ? `<div class="s">${esc(sub)}</div>` : ''}</div>`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>Waylo · live metrics</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root{color-scheme:light dark}
  body{font:15px/1.5 -apple-system,system-ui,sans-serif;margin:0;padding:28px;background:#0b0d12;color:#e8ecf3}
  h1{font-size:20px;margin:0 0 4px} .sub{color:#8a93a6;margin:0 0 22px;font-size:13px}
  .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:14px;margin-bottom:26px}
  .card{background:#151924;border:1px solid #232838;border-radius:14px;padding:16px 18px}
  .card .v{font-size:30px;font-weight:700;letter-spacing:-.5px}
  .card .l{color:#8a93a6;font-size:13px;margin-top:2px}
  .card .s{color:#5f6b82;font-size:12px;margin-top:2px}
  .panel{background:#151924;border:1px solid #232838;border-radius:14px;padding:18px;margin-bottom:20px}
  .panel h2{font-size:14px;margin:0 0 14px;color:#b9c2d6;font-weight:600}
  .chart{display:flex;align-items:flex-end;gap:8px;height:150px}
  .bar{display:flex;flex-direction:column;align-items:center;gap:6px;flex:1}
  .bar .fill{width:70%;background:linear-gradient(#4f8cff,#2f6bf0);border-radius:5px 5px 0 0;min-height:3px}
  .bar span{color:#5f6b82;font-size:10px}
  table{width:100%;border-collapse:collapse} td{padding:7px 4px;border-bottom:1px solid #232838;font-size:13px}
  td.num{text-align:right;color:#4f8cff;font-weight:600}
</style></head><body>
  <h1>Waylo — live metrics</h1>
  <p class="sub">AI-native, in production · refreshed on load</p>
  <div class="cards">
    ${card('Registered users', s.registeredUsers)}
    ${card('Paying customers', s.paidUsers, s.conversionPct + '% conversion')}
    ${card('Tasks run (all time)', s.totalTasks)}
    ${card('Tasks (7 days)', s.tasks7d)}
    ${card('Active users (7d)', s.activeUsers7d)}
  </div>
  <div class="panel"><h2>Tasks per day (14 days)</h2><div class="chart">${bars || '<span class="sub">No data yet</span>'}</div></div>
  <div class="panel"><h2>Recent signups</h2><table><thead><tr style="color:var(--faint)"><td>Email</td><td>Plan</td><td>Source</td><td class="num">Joined</td></tr></thead><tbody>${signupRows}</tbody></table></div>
  <div class="panel"><h2>Top tasks</h2><table><tbody>${rows}</tbody></table></div>
</body></html>`;
}

/**
 * POST /plan/learn
 * Remembers a CORRECTED plan after a guide completed whose steps were changed
 * mid-run. Keyed by the original task text, so the same task is right next time.
 * Body: { task, platform, steps:[...] }
 */
app.post('/plan/learn', async (req, res) => {
  try {
    const { task, platform, steps } = req.body || {};
    if (!task || typeof task !== 'string' || !Array.isArray(steps) || steps.length === 0) {
      return res.status(400).json({ accepted: false, error: 'task and non-empty steps are required' });
    }
    if ((platform || 'macos') !== 'macos') {
      return res.status(202).json({ accepted: false }); // only desktop plans are cached this way
    }
    const REGIONS = ['menuBar', 'ribbon', 'dialog', 'sidebar', 'spreadsheet', 'statusBar', 'fullScreen'];
    const normalized = steps.map((s, i) => ({
      index: typeof s.index === 'number' ? s.index : i + 1,
      action: ['click', 'type', 'key', 'info'].includes(s.action) ? s.action : 'click',
      instruction: typeof s.instruction === 'string' ? s.instruction : '',
      targetLabel: typeof s.targetLabel === 'string' ? s.targetLabel : '',
      elementDescription: s.elementDescription || s.findDescription || s.instruction || '',
      screenRegion: REGIONS.includes(s.screenRegion) ? s.screenRegion : 'fullScreen',
      targetType: s.targetType === 'icon' ? 'icon' : 'text',
      controlKind: typeof s.controlKind === 'string' ? s.controlKind : '',
      anchorText: typeof s.anchorText === 'string' ? s.anchorText : '',
      anchorPosition: typeof s.anchorPosition === 'string' ? s.anchorPosition : '',
      key: typeof s.key === 'string' ? s.key : null,
      findDescription: s.findDescription || s.elementDescription || s.instruction || '',
    }));
    const plan = { task, app: 'Unknown', steps: normalized };
    // Fire-and-forget so the client isn't blocked.
    semanticPlanCache.learnPlan('macos', task, plan).then(() => {}, () => {});
    return res.status(202).json({ accepted: true });
  } catch (error) {
    console.error('Error in /plan/learn:', error.message);
    return res.status(500).json({ accepted: false, error: error.message });
  }
});

/**
 * POST /plan/forget
 * Marks a plan WRONG: removes it from the cache so it isn't reused.
 * Body: { task, platform }
 */
app.post('/plan/forget', (req, res) => {
  const { task, platform } = req.body || {};
  if (task && typeof task === 'string' && (platform || 'macos') === 'macos') {
    semanticPlanCache.forgetPlan('macos', task).then(() => {}, () => {});
  }
  return res.status(202).json({ accepted: true });
});

// Layer 2.5: dual-model YOLO detection (proxies to the Python microservice)
app.use('/', yoloDetectRoute);

/**
 * POST /guide
 * Save a guide to database and return shareable link
 */
app.post('/guide', async (req, res) => {
  try {
    const { steps, taskName } = req.body;

    if (!steps || !Array.isArray(steps) || steps.length === 0) {
      return res.status(400).json({ success: false, error: 'Steps array is required and must not be empty' });
    }
    if (!taskName || typeof taskName !== 'string') {
      return res.status(400).json({ success: false, error: 'Task name is required' });
    }

    const id = generateRandomId(8);
    await db.query(
      'INSERT INTO guides (id, task, steps_json) VALUES ($1, $2, $3)',
      [id, taskName, JSON.stringify(steps)]
    );

    console.log(`Guide saved: ${id}`);
    res.json({
      success: true,
      id,
      link: `https://waylo.app/g/${id}`
    });
  } catch (error) {
    console.error('Error in /guide:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to save guide',
      details: error.message
    });
  }
});


/**
 * GET /guide/:id
 * Retrieve a saved guide by ID
 */
app.get('/guide/:id', async (req, res) => {
  try {
    const { id } = req.params;

    if (!id || id.length !== 8) {
      return res.status(400).json({
        success: false,
        error: 'Invalid guide ID'
      });
    }

    const { rows } = await db.query('SELECT * FROM guides WHERE id = $1', [id]);
    if (!rows || rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Guide not found'
      });
    }

    const row = rows[0];
    let steps = [];
    try {
      steps = JSON.parse(row.steps_json);
    } catch (_) {
      steps = [];
    }

    // Best-effort open counter (column exists in the AWS schema).
    db.query('UPDATE guides SET opens = opens + 1 WHERE id = $1', [id]).catch(() => {});

    res.json({
      success: true,
      taskName: row.task,
      steps,
      totalSteps: steps.length
    });

  } catch (error) {
    console.error('Error in /guide/:id:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve guide',
      details: error.message
    });
  }
});

/**
 * Utility function to generate random alphanumeric ID
 * @param {number} length - Length of the ID
 * @returns {string} Random alphanumeric string
 */
function generateRandomId(length) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

// Start server
app.listen(PORT, () => {
  console.log(`Waylo backend running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});
