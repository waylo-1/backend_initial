/**
 * Semantic plan cache (AWS RDS Postgres + pgvector + Titan embeddings).
 *
 * Matches paraphrases: "freeze the top row" and "lock the first row" embed to
 * nearby vectors and hit the same cached plan. All failures are swallowed — on
 * error we return null so the caller falls through to live generation.
 *
 * AWS schema (plan_cache): id BIGSERIAL, task TEXT, platform TEXT,
 *   steps_json TEXT, embedding vector(1536), created_at.
 * RPC: match_plan_cache(query_embedding vector, match_threshold float,
 *   match_count int, platform_filter text)
 *   -> (id, task, platform, steps_json, similarity)
 */
const db = require('./db');
const { embedText } = require('./embeddings');

const PLAN_SIMILARITY_THRESHOLD = 0.92;

/**
 * Bump this whenever the desktop planning prompt changes meaningfully. It is
 * folded into the embedding input so plans cached under an OLD prompt version no
 * longer match new lookups — effectively invalidating stale plans (e.g. the old
 * "Apple menu → System Preferences" route) without touching the database.
 */
const PLAN_PROMPT_VERSION = 'v4-target-type';

function embedInput(taskText) {
  return `[${PLAN_PROMPT_VERSION}] ${taskText}`;
}

/** pgvector text literal, e.g. "[0.1,0.2,...]". */
function toVector(arr) {
  return `[${arr.join(',')}]`;
}

/** Returns a cached step plan (parsed object) for a similar task, or null. */
async function getPlanFromCache(platform, taskText) {
  try {
    const embedding = await embedText(embedInput(taskText));
    const { rows } = await db.query(
      'SELECT * FROM match_plan_cache($1::vector, $2, $3, $4)',
      [toVector(embedding), PLAN_SIMILARITY_THRESHOLD, 1, platform]
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
    const embedding = await embedText(embedInput(taskText));
    await db.query(
      'INSERT INTO plan_cache (task, platform, steps_json, embedding) VALUES ($1, $2, $3, $4::vector)',
      [taskText, platform, JSON.stringify(stepPlan), toVector(embedding)]
    );
  } catch (e) {
    console.error('[semanticPlanCache] storePlanInCache:', e.message);
  }
}

module.exports = { getPlanFromCache, storePlanInCache };
