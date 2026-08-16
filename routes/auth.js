/**
 * Unified accounts + entitlement + revenue API for Waylo (shared with the Mac
 * app + website). ONE source of truth: the `users` table, keyed by email.
 *
 *   plan                 'free' | 'paid'  (Yash's Mac checks this by email)
 *   free_tasks_used      0..FREE_LIMIT    (5 free tasks)
 *   paid_tasks_remaining +TASKS_PER_UPGRADE per ₹100 payment (25 tasks)
 *
 *   POST /auth/google        { email, name, googleId }  -> upsert + state
 *   GET  /entitlement?email= -> { plan, freeUsed, paidRemaining, canUse }
 *   POST /entitlement/consume { email }                 -> count one task
 *   POST /upgrade            { email, ref }             -> plan='paid', +25 tasks
 *   GET  /admin/stats?key=   -> users / paid / revenue (ADMIN_KEY-gated)
 *   POST /feedback           { email, rating, text, device }
 *
 * Non-destructive: extends the existing `users` table via ADD COLUMN IF NOT
 * EXISTS — no data is dropped.
 */
const express = require('express');
const router = express.Router();
const db = require('../db');

const FREE_LIMIT = 5;
const TASKS_PER_UPGRADE = 25;
const PRICE_INR = 100;

let ready = false;
async function ensureTables() {
  if (ready) return;
  // Create if the DB is fresh; otherwise the ALTERs below extend the existing
  // users table (Yash's) without touching its data.
  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      email TEXT PRIMARY KEY,
      name TEXT,
      plan TEXT DEFAULT 'free',
      google_id TEXT,
      free_tasks_used INTEGER DEFAULT 0,
      paid_tasks_remaining INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT now(),
      last_seen TIMESTAMPTZ DEFAULT now()
    )`);
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS plan TEXT DEFAULT 'free'`);
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS google_id TEXT`);
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS free_tasks_used INTEGER DEFAULT 0`);
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS paid_tasks_remaining INTEGER DEFAULT 0`);
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen TIMESTAMPTZ DEFAULT now()`);
  await db.query(`
    CREATE TABLE IF NOT EXISTS account_purchases (
      id BIGSERIAL PRIMARY KEY, email TEXT NOT NULL, upi_ref TEXT,
      amount_inr INTEGER DEFAULT ${PRICE_INR}, tasks_granted INTEGER DEFAULT ${TASKS_PER_UPGRADE},
      created_at TIMESTAMPTZ DEFAULT now())`);
  await db.query(`
    CREATE TABLE IF NOT EXISTS feedback (
      id BIGSERIAL PRIMARY KEY, email TEXT, rating INTEGER, text TEXT, device TEXT,
      created_at TIMESTAMPTZ DEFAULT now())`);
  ready = true;
}

const norm = (e) => String(e || '').trim().toLowerCase();
const stateOf = (u) => {
  const freeUsed = u.free_tasks_used || 0;
  const paidRemaining = u.paid_tasks_remaining || 0;
  const isPaid = paidRemaining > 0 || u.plan === 'paid';
  return {
    plan: u.plan || 'free',
    freeUsed,
    freeLimit: FREE_LIMIT,
    paidRemaining,
    isPaid,
    canUse: freeUsed < FREE_LIMIT || paidRemaining > 0,
  };
};

router.post('/auth/google', async (req, res) => {
  try {
    const email = norm(req.body && req.body.email);
    const name = String((req.body && req.body.name) || '').trim().slice(0, 120);
    const googleId = String((req.body && req.body.googleId) || '').trim().slice(0, 64);
    if (!email || !email.includes('@')) return res.status(400).json({ ok: false, error: 'valid email required' });
    await ensureTables();
    const r = await db.query(
      `INSERT INTO users (email, name, google_id, last_seen) VALUES ($1,$2,$3, now())
       ON CONFLICT (email) DO UPDATE SET
         name = COALESCE(NULLIF(EXCLUDED.name, ''), users.name),
         google_id = COALESCE(NULLIF(EXCLUDED.google_id, ''), users.google_id),
         last_seen = now()
       RETURNING plan, free_tasks_used, paid_tasks_remaining`,
      [email, name, googleId]
    );
    return res.json({ ok: true, email, ...stateOf(r.rows[0]) });
  } catch (e) { console.error('[auth/google]', e.message); return res.status(500).json({ ok: false, error: 'auth failed' }); }
});

router.get('/entitlement', async (req, res) => {
  try {
    const email = norm(req.query && req.query.email);
    if (!email) return res.status(400).json({ ok: false, error: 'email required' });
    await ensureTables();
    const r = await db.query('SELECT plan, free_tasks_used, paid_tasks_remaining FROM users WHERE email=$1', [email]);
    return res.json({ ok: true, ...stateOf(r.rows[0] || {}) });
  } catch (e) { console.error('[entitlement]', e.message); return res.status(500).json({ ok: false, error: 'lookup failed' }); }
});

router.post('/entitlement/consume', async (req, res) => {
  try {
    const email = norm(req.body && req.body.email);
    if (!email) return res.status(400).json({ ok: false, error: 'email required' });
    await ensureTables();
    await db.query('INSERT INTO users (email) VALUES ($1) ON CONFLICT (email) DO NOTHING', [email]);
    let r = await db.query(
      `UPDATE users SET free_tasks_used = COALESCE(free_tasks_used,0) + 1, last_seen = now()
       WHERE email=$1 AND COALESCE(free_tasks_used,0) < $2
       RETURNING plan, free_tasks_used, paid_tasks_remaining`, [email, FREE_LIMIT]);
    if (r.rowCount === 1) return res.json({ ok: true, allowed: true, ...stateOf(r.rows[0]) });
    r = await db.query(
      `UPDATE users SET paid_tasks_remaining = paid_tasks_remaining - 1, last_seen = now()
       WHERE email=$1 AND COALESCE(paid_tasks_remaining,0) > 0
       RETURNING plan, free_tasks_used, paid_tasks_remaining`, [email]);
    if (r.rowCount === 1) return res.json({ ok: true, allowed: true, ...stateOf(r.rows[0]) });
    const s = await db.query('SELECT plan, free_tasks_used, paid_tasks_remaining FROM users WHERE email=$1', [email]);
    return res.json({ ok: true, allowed: false, ...stateOf(s.rows[0] || {}) });
  } catch (e) { console.error('[consume]', e.message); return res.status(500).json({ ok: false, error: 'consume failed' }); }
});

// ₹100 UPI upgrade: mark paid + grant 25 tasks + store the reference.
router.post('/upgrade', async (req, res) => {
  try {
    const email = norm(req.body && req.body.email);
    const ref = String((req.body && req.body.ref) || '').trim().slice(0, 64);
    if (!email || !email.includes('@')) return res.status(400).json({ ok: false, error: 'valid email required' });
    if (ref.length < 4) return res.status(400).json({ ok: false, error: 'UPI reference required' });
    await ensureTables();
    await db.query('INSERT INTO users (email) VALUES ($1) ON CONFLICT (email) DO NOTHING', [email]);
    await db.query('INSERT INTO account_purchases (email, upi_ref) VALUES ($1,$2)', [email, ref]);
    const r = await db.query(
      `UPDATE users SET plan = 'paid', paid_tasks_remaining = COALESCE(paid_tasks_remaining,0) + $2, last_seen = now()
       WHERE email=$1 RETURNING plan, free_tasks_used, paid_tasks_remaining`, [email, TASKS_PER_UPGRADE]);
    return res.json({ ok: true, email, ...stateOf(r.rows[0]) });
  } catch (e) { console.error('[upgrade]', e.message); return res.status(500).json({ ok: false, error: 'upgrade failed' }); }
});

// Revenue + usage stats. Gated by ADMIN_KEY (locked if key unset).
router.get('/admin/stats', async (req, res) => {
  try {
    const key = process.env.ADMIN_KEY;
    if (!key || req.query.key !== key) return res.status(403).json({ ok: false, error: 'forbidden' });
    await ensureTables();
    const users = await db.query('SELECT COUNT(*)::int c FROM users');
    const paid = await db.query("SELECT COUNT(*)::int c FROM users WHERE plan='paid' OR COALESCE(paid_tasks_remaining,0)>0");
    const purchases = await db.query('SELECT COUNT(*)::int c, COALESCE(SUM(amount_inr),0)::int rev FROM account_purchases');
    const fb = await db.query('SELECT COUNT(*)::int c FROM feedback');
    return res.json({
      ok: true,
      users: users.rows[0].c,
      paidCustomers: paid.rows[0].c,
      purchases: purchases.rows[0].c,
      revenueInr: purchases.rows[0].rev,
      feedbackCount: fb.rows[0].c,
    });
  } catch (e) { console.error('[admin/stats]', e.message); return res.status(500).json({ ok: false, error: 'stats failed' }); }
});

router.post('/feedback', async (req, res) => {
  try {
    const email = norm(req.body && req.body.email);
    const rating = Math.max(0, Math.min(5, parseInt((req.body && req.body.rating) || 0, 10) || 0));
    const text = String((req.body && req.body.text) || '').trim().slice(0, 2000);
    const device = String((req.body && req.body.device) || '').trim().slice(0, 120);
    if (!text && !rating) return res.status(400).json({ ok: false, error: 'rating or text required' });
    await ensureTables();
    await db.query('INSERT INTO feedback (email, rating, text, device) VALUES ($1,$2,$3,$4)',
      [email || null, rating || null, text || null, device || null]);
    return res.json({ ok: true });
  } catch (e) { console.error('[feedback]', e.message); return res.status(500).json({ ok: false, error: 'feedback failed' }); }
});

module.exports = router;
