/**
 * Semantic plan cache (Supabase pgvector + Titan embeddings).
 *
 * Unlike the in-process exact-match cache (planCache.js), this matches
 * paraphrases: "freeze the top row" and "how do I lock the first row" map to
 * nearby vectors and hit the same cached plan. Survives restarts and is shared
 * across instances.
 *
 * All failures are swallowed — on any error we return null so the caller falls
 * through to live generation.
 */
const supabase = require('./supabase');
const { embedText } = require('./embeddings');

const PLAN_SIMILARITY_THRESHOLD = 0.92;

/** Returns a cached step plan for a semantically-similar task, or null. */
async function getPlanFromCache(appName, taskText) {
  try {
    const embedding = await embedText(taskText);
    const { data, error } = await supabase.rpc('match_plan_cache', {
      query_embedding: embedding,
      app_name_filter: appName,
      similarity_threshold: PLAN_SIMILARITY_THRESHOLD,
      match_count: 1,
    });
    if (error || !data || data.length === 0) {
      if (error) console.error('[semanticPlanCache] rpc error:', error.message);
      return null;
    }
    const hit = data[0];
    // Bump hit stats without blocking.
    supabase
      .from('plan_cache')
      .update({ hit_count: (hit.hit_count || 0) + 1, last_hit_at: new Date().toISOString() })
      .eq('id', hit.id)
      .then(() => {}, () => {});
    return hit.step_plan;
  } catch (e) {
    console.error('[semanticPlanCache] getPlanFromCache:', e.message);
    return null;
  }
}

/** Stores a generated plan. Non-fatal on error. */
async function storePlanInCache(appName, taskText, stepPlan) {
  try {
    const embedding = await embedText(taskText);
    const { error } = await supabase.from('plan_cache').insert({
      app_name: appName,
      task_text: taskText,
      task_embedding: embedding,
      step_plan: stepPlan,
    });
    if (error) console.error('[semanticPlanCache] insert error:', error.message);
  } catch (e) {
    console.error('[semanticPlanCache] storePlanInCache:', e.message);
  }
}

module.exports = { getPlanFromCache, storePlanInCache };
