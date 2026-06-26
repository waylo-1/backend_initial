/**
 * Step label cache (Supabase pgvector + Titan embeddings).
 *
 * When the on-device layers (AX / OCR) miss but a recovery relabel later makes
 * the element findable (e.g. "Format" → "Format Cells"), we cache that working
 * label keyed by {appName, stepDescription}. Future runs look it up first and
 * resolve via AX directly — skipping the vision fallback entirely.
 *
 * All failures are swallowed; callers fall through to live resolution.
 */
const supabase = require('./supabase');
const { embedText } = require('./embeddings');

const LABEL_SIMILARITY_THRESHOLD = 0.93;

async function getLabelFromCache(appName, stepDescription) {
  try {
    const embedding = await embedText(stepDescription);
    const { data, error } = await supabase.rpc('match_step_label_cache', {
      query_embedding: embedding,
      app_name_filter: appName,
      similarity_threshold: LABEL_SIMILARITY_THRESHOLD,
      match_count: 1,
    });
    if (error || !data || data.length === 0) {
      if (error) console.error('[stepLabelCache] rpc error:', error.message);
      return null;
    }
    const hit = data[0];
    supabase
      .from('step_label_cache')
      .update({ hit_count: (hit.hit_count || 0) + 1, last_hit_at: new Date().toISOString() })
      .eq('id', hit.id)
      .then(() => {}, () => {});
    return hit.ax_label;
  } catch (e) {
    console.error('[stepLabelCache] getLabelFromCache:', e.message);
    return null;
  }
}

async function storeLabelInCache(appName, stepDescription, axLabel) {
  try {
    const embedding = await embedText(stepDescription);
    const { error } = await supabase.from('step_label_cache').insert({
      app_name: appName,
      step_description: stepDescription,
      step_embedding: embedding,
      ax_label: axLabel,
    });
    if (error) console.error('[stepLabelCache] insert error:', error.message);
  } catch (e) {
    console.error('[stepLabelCache] storeLabelInCache:', e.message);
  }
}

module.exports = { getLabelFromCache, storeLabelInCache };
