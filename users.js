/**
 * Users + usage tracking — the business-evidence layer for the XPRIZE.
 *
 * Two tables, auto-created on first use (no migration step):
 *   users(email, name, source, plan, created_at, last_seen)
 *   usage_events(email, task, event, platform, created_at)
 *
 * Both the Vercel sign-in page (POST /register) and the app (userEmail on /plan)
 * populate `users`, so "registered customers" = row count. Every task run logs a
 * `usage_events` row → powers the free-tier limit (task count per user), the
 * analytics dashboard (product evidence), and the funnel numbers. `plan` flips to
 * 'paid' after a successful payment (see the paywall work).
 */
const { query } = require('./db');

let ensured = false;
async function ensureTables() {
  if (ensured) return;
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      email      TEXT PRIMARY KEY,
      name       TEXT,
      source     TEXT,
      plan       TEXT NOT NULL DEFAULT 'free',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_seen  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS usage_events (
      id         BIGSERIAL PRIMARY KEY,
      email      TEXT,
      task       TEXT,
      event      TEXT NOT NULL DEFAULT 'task',
      platform   TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS usage_events_email_idx ON usage_events(email)`);
  await query(`CREATE INDEX IF NOT EXISTS usage_events_created_idx ON usage_events(created_at)`);
  ensured = true;
}

const normEmail = (e) => String(e || '').trim().toLowerCase();
const looksLikeEmail = (e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);

/** Upsert a user (from the website sign-in or the app). Returns the email or null. */
async function registerUser(email, name = '', source = '') {
  const e = normEmail(email);
  if (!looksLikeEmail(e)) return null;
  await ensureTables();
  await query(
    `INSERT INTO users (email, name, source, last_seen)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (email) DO UPDATE SET
       name = COALESCE(NULLIF(EXCLUDED.name, ''), users.name),
       source = COALESCE(NULLIF(EXCLUDED.source, ''), users.source),
       last_seen = now()`,
    [e, name || '', source || '']
  );
  return e;
}

/** Log a usage event (a task run by default). Safe to call with no email. */
async function trackUsage(email, task, event = 'task', platform = '') {
  await ensureTables();
  const e = normEmail(email);
  await query(
    `INSERT INTO usage_events (email, task, event, platform) VALUES ($1, $2, $3, $4)`,
    [looksLikeEmail(e) ? e : null, String(task || '').slice(0, 300), event, platform || null]
  );
  if (looksLikeEmail(e)) {
    await query(`UPDATE users SET last_seen = now() WHERE email = $1`, [e]).catch(() => {});
  }
}

/** Number of tasks this user has RUN (for the 5-free-tasks limit). */
async function taskCount(email) {
  await ensureTables();
  const e = normEmail(email);
  if (!looksLikeEmail(e)) return 0;
  const r = await query(
    `SELECT COUNT(*)::int AS n FROM usage_events WHERE email = $1 AND event = 'task'`,
    [e]
  );
  return r.rows[0]?.n || 0;
}

async function getUser(email) {
  await ensureTables();
  const e = normEmail(email);
  if (!looksLikeEmail(e)) return null;
  const r = await query(`SELECT email, name, plan, created_at FROM users WHERE email = $1`, [e]);
  return r.rows[0] || null;
}

async function setPlan(email, plan) {
  await ensureTables();
  await query(`UPDATE users SET plan = $2 WHERE email = $1`, [normEmail(email), plan]);
}

/** Aggregate metrics for the analytics dashboard (product + funnel evidence). */
async function getStats() {
  await ensureTables();
  const [users, paid, tasks, tasks7, active7, topTasks, daily] = await Promise.all([
    query(`SELECT COUNT(*)::int AS n FROM users`),
    query(`SELECT COUNT(*)::int AS n FROM users WHERE plan <> 'free'`),
    query(`SELECT COUNT(*)::int AS n FROM usage_events WHERE event = 'task'`),
    query(`SELECT COUNT(*)::int AS n FROM usage_events WHERE event = 'task' AND created_at > now() - interval '7 days'`),
    query(`SELECT COUNT(DISTINCT email)::int AS n FROM usage_events WHERE email IS NOT NULL AND created_at > now() - interval '7 days'`),
    query(`SELECT task, COUNT(*)::int AS n FROM usage_events WHERE event='task' AND COALESCE(task,'') <> '' GROUP BY task ORDER BY n DESC LIMIT 10`),
    query(`SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day, COUNT(*)::int AS n
           FROM usage_events WHERE event='task' AND created_at > now() - interval '14 days'
           GROUP BY day ORDER BY day`),
  ]);
  const registered = users.rows[0].n;
  const paidUsers = paid.rows[0].n;
  return {
    registeredUsers: registered,
    paidUsers,
    conversionPct: registered ? Math.round((paidUsers / registered) * 1000) / 10 : 0,
    totalTasks: tasks.rows[0].n,
    tasks7d: tasks7.rows[0].n,
    activeUsers7d: active7.rows[0].n,
    topTasks: topTasks.rows,
    daily: daily.rows,
  };
}

module.exports = {
  ensureTables, registerUser, trackUsage, taskCount, getUser, setPlan, getStats,
};
