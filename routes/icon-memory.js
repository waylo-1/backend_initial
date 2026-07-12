/**
 * Fleet-wide icon memory.
 *
 * The macOS app remembers located icons as perceptual hashes ("Spotify's +
 * icon looks like this"). That knowledge is universal — the same app renders
 * the same pixels on every Mac — so hashes are synced through this table and
 * one user's verified detection makes the icon instantly recognizable for
 * EVERY user. Hot-path lookups stay on-device; this is push-on-learn +
 * pull-on-launch.
 *
 *   POST /icon/store  { app, concept, hashes: ["1234…", …] }
 *   GET  /icon/sync   → { icons: [{ app, concept, hashes: [...] }, …] }
 *
 * Hashes are 64-bit aHashes sent as decimal strings (UInt64 > JSON int range).
 */
const express = require('express');
const router = express.Router();
const db = require('../db');

let tableReady = false;
async function ensureTable() {
  if (tableReady) return;
  await db.query(`
    CREATE TABLE IF NOT EXISTS icon_memory (
      id BIGSERIAL PRIMARY KEY,
      app TEXT NOT NULL,
      concept TEXT NOT NULL,
      hash TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now(),
      UNIQUE (app, concept, hash)
    )`);
  tableReady = true;
}

router.post('/store', async (req, res) => {
  try {
    await ensureTable();
    const app = String(req.body?.app || '').toLowerCase().trim();
    const concept = String(req.body?.concept || '').toLowerCase().trim();
    const hashes = Array.isArray(req.body?.hashes) ? req.body.hashes : [];
    if (!app || !concept || hashes.length === 0) {
      return res.status(400).json({ error: 'app, concept, hashes required' });
    }
    let added = 0;
    for (const h of hashes.slice(0, 16)) {
      const hash = String(h).slice(0, 24);
      if (!/^\d+$/.test(hash)) continue;
      const r = await db.query(
        'INSERT INTO icon_memory (app, concept, hash) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
        [app, concept, hash]
      );
      added += r.rowCount;
    }
    return res.json({ added });
  } catch (err) {
    console.error('[icon-memory] store:', err.message);
    return res.status(500).json({ error: 'store failed' });
  }
});

router.get('/sync', async (_req, res) => {
  try {
    await ensureTable();
    // Small table by construction (unique hashes of real icons); cap defensively.
    const { rows } = await db.query(
      'SELECT app, concept, hash FROM icon_memory ORDER BY id DESC LIMIT 5000');
    const grouped = new Map();
    for (const r of rows) {
      const key = `${r.app}|${r.concept}`;
      if (!grouped.has(key)) grouped.set(key, { app: r.app, concept: r.concept, hashes: [] });
      grouped.get(key).hashes.push(r.hash);
    }
    return res.json({ icons: [...grouped.values()] });
  } catch (err) {
    console.error('[icon-memory] sync:', err.message);
    return res.status(500).json({ error: 'sync failed' });
  }
});

module.exports = router;
