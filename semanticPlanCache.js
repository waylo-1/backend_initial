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

/**
 * Bump this whenever the planning prompt changes meaningfully to invalidate ALL
 * previously cached plans. The version is folded into the `platform` value
 * (which match_plan_cache filters on with exact equality), so old rows simply
 * stop matching. NOTE: we do NOT fold the version into the embedding text — a
 * short prefix barely moves a Titan vector, so stale plans would still match.
 */
const PLAN_PROMPT_VERSION = 'v5';
const versioned = (platform) => `${platform}__${PLAN_PROMPT_VERSION}`;

/** pgvector text literal, e.g. "[0.1,0.2,...]". */
function toVector(arr) {
  return `[${arr.join(',')}]`;
}

/** Returns a cached step plan (parsed object) for a similar task, or null. */
async function getPlanFromCache(platform, taskText) {
  try {
    const embedding = await embedText(taskText);
    const { rows } = await db.query(
      'SELECT * FROM match_plan_cache($1::vector, $2, $3, $4)',
      [toVector(embedding), PLAN_SIMILARITY_THRESHOLD, 1, versioned(platform)]
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

module.exports = { getPlanFromCache, storePlanInCache, learnPlan };
