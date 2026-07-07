-- Waylo: add_correction_fields
--
-- Extends detection_failures (Aurora PostgreSQL, see sql/detection_failures.sql)
-- to also store two new event kinds alongside the original auto-miss rows:
--
--   - user_correction: the volume-button-double-press flow (Android
--     GuidanceEngine + a new correction-capture path) — the user says what
--     went wrong and/or taps the actually-correct element; we record the
--     spoken correction text and the corrected element's node info.
--   - auto_success: an opt-in (BuildConfig-flagged) log of a successful YOLO
--     detection, so the training set isn't only misses. No raw screenshot —
--     just a hash reference, to keep routine successes cheap to log.
--
-- `source` distinguishes the three kinds; existing rows backfill to
-- 'auto_miss' so nothing already stored changes meaning.
--
-- screenshot_base64 was NOT NULL — user_correction/auto_success rows don't
-- always have (or need) a full screenshot, so that constraint is relaxed.
-- The API layer (routes/failure.js) still requires it for auto_miss rows,
-- preserving the existing contract for existing callers.
--
-- Apply once against the Aurora instance — see the repo root README/
-- DEPLOY_TOMORROW.md-style runbook for the exact command to run on EC2.

ALTER TABLE detection_failures
  ALTER COLUMN screenshot_base64 DROP NOT NULL;

ALTER TABLE detection_failures
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'auto_miss',
  ADD COLUMN IF NOT EXISTS correction_text TEXT,
  ADD COLUMN IF NOT EXISTS corrected_target JSONB,
  ADD COLUMN IF NOT EXISTS current_package TEXT,
  ADD COLUMN IF NOT EXISTS current_activity TEXT,
  ADD COLUMN IF NOT EXISTS screenshot_hash TEXT,
  ADD COLUMN IF NOT EXISTS chosen_box JSONB;

ALTER TABLE detection_failures
  ADD CONSTRAINT detection_failures_source_check
    CHECK (source IN ('auto_miss', 'user_correction', 'auto_success'));

-- Query pattern: "show me the corrections/successes for retraining review",
-- separate from the original unreviewed-misses index.
CREATE INDEX IF NOT EXISTS idx_failures_source ON detection_failures(source);
