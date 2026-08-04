/**
 * Fleet-wide "pick memory".
 *
 * When detection is ambiguous (a target that looks the same in several places),
 * the desktop app shows numbered badges and the user clicks the right one. That
 * choice is stored here as a RELATIVE position (fractions 0–1) inside the app's
 * window, keyed by app + step. Because the position is relative and app layouts
 * are the same for everyone, one user's pick lets EVERY user's next run of that
 * step auto-resolve without asking — the same self-improving loop as the label
 * and icon caches.
 *
 * Single best position per (app, step_key): the latest confirmed pick wins
 * (upsert). The table is created on first use, so no separate migration step.
 */
const { query } = require('./db');

let ensured = false;
async function ensureTable() {
  if (ensured) return;
  await query(`
    CREATE TABLE IF NOT EXISTS pick_memory (
      app        TEXT NOT NULL,
      step_key   TEXT NOT NULL,
      rel_x      DOUBLE PRECISION NOT NULL,
      rel_y      DOUBLE PRECISION NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (app, step_key)
    )
  `);
  ensured = true;
}

/** Upsert the latest confirmed pick for a step. */
async function storePick(app, stepKey, relX, relY) {
  await ensureTable();
  await query(
    `INSERT INTO pick_memory (app, step_key, rel_x, rel_y, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (app, step_key)
     DO UPDATE SET rel_x = EXCLUDED.rel_x, rel_y = EXCLUDED.rel_y, updated_at = now()`,
    [app.toLowerCase(), stepKey.toLowerCase(), relX, relY]
  );
}

/** The remembered relative pick for a step, or null. */
async function lookupPick(app, stepKey) {
  await ensureTable();
  const r = await query(
    `SELECT rel_x, rel_y FROM pick_memory WHERE app = $1 AND step_key = $2 LIMIT 1`,
    [app.toLowerCase(), stepKey.toLowerCase()]
  );
  return r.rows[0] ? { relX: r.rows[0].rel_x, relY: r.rows[0].rel_y } : null;
}

module.exports = { storePick, lookupPick };
