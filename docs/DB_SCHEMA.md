# detection_failures schema (Aurora PostgreSQL)

This table's live schema has drifted from `sql/detection_failures.sql`, which
targets Supabase and was never applied to the live Aurora instance. This doc
reflects reality: what's live now, and what `migrations/add_correction_fields.sql`
adds on top.

## Live schema (before migration)

| Column | Type |
|---|---|
| id | bigint |
| step_description | text |
| platform | text |
| screenshot_path | text |
| created_at | timestamp |

## After `migrations/add_correction_fields.sql`

All added columns are nullable; nothing existing is altered or dropped.

| Column | Type | Added by migration | Notes |
|---|---|---|---|
| id | bigint | — | existing |
| step_description | text | — | existing, unrelated to `find_description` below |
| platform | text | — | existing |
| screenshot_path | text | — | existing |
| created_at | timestamp | — | existing |
| session_id | text | yes | |
| task_description | text | yes | |
| step_number | integer | yes | |
| find_description | text | yes | required by `routes/failure.js` at the application layer, not by a DB constraint |
| element_type | text | yes | |
| screen_region | text | yes | |
| visual_description | text | yes | |
| target_package | text | yes | |
| layer_reached | integer | yes | |
| screenshot_base64 | text | yes | required by `routes/failure.js` for `source = 'auto_miss'` only, at the application layer |
| screen_width | integer | yes | |
| screen_height | integer | yes | |
| source | text | yes | `'auto_miss' \| 'user_correction' \| 'auto_success'`, defaulted to `'auto_miss'` by `routes/failure.js` when absent/invalid — no DB-level default or CHECK constraint |
| correction_text | text | yes | |
| corrected_target | jsonb | yes | |
| current_package | text | yes | |
| current_activity | text | yes | |
| screenshot_hash | text | yes | |
| chosen_box | jsonb | yes | |

## Source of truth

`routes/failure.js`'s `INSERT` statement is the authoritative list of columns
the application writes. Any future column added there must also be added to
`migrations/add_correction_fields.sql` (or a new migration) before it's
deployed, since the live table only has what's been explicitly migrated.
