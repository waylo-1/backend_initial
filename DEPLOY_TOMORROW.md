# Deploying the provider-swap + quota-fallback changes to EC2

Covers three local commits made 2026-07-03 → 2026-07-05 on `main`:

- `cb59d6c` — Make AI provider swappable (default: Bedrock Nova); fix `/failure` schema mismatch
- `50b024f` — Bedrock provider: accept old env var names, new name wins if both set
- `637553d` — `/plan`: fall back to a degraded pgvector cache match on quota/throttle, 429 not 500

`cb59d6c` is already on `origin/main`. **`50b024f` and `637553d` are only local — push them before doing anything on EC2:**

```bash
git push origin main
```

## What actually changes on disk

- `bedrock.js` is gone. All AI calls now go through `services/llm.js` → `services/providers/{bedrock,gemini}.js`, selected by `AI_PROVIDER` (defaults to `bedrock` if unset — **so if EC2's `.env` doesn't already set `AI_PROVIDER`, nothing changes here**).
- Model-selection env vars were renamed (`BEDROCK_TEXT_MODEL_ID` / `BEDROCK_VISION_MODEL_ID` / `BEDROCK_OBJECT_DETECT_MODEL_ID`), but the code reads the **old names too** (`BEDROCK_MODEL_ID`, `BEDROCK_PLAN_MODEL_ID`) as a fallback — EC2's existing `.env` keeps working without editing it. See `.env.example` for the full precedence table.
- `/plan` now returns `429` (not `500`) with `{ "code": "quota_exceeded" }` when Bedrock throttles and there's no cache fallback, instead of a raw 500.

## 1. SSH in and pull

```bash
cd /path/to/waylo-backend   # wherever this repo lives on the instance
git pull origin main
```

Expect to see `50b024f` and `637553d` (and `cb59d6c` if this box hasn't pulled since 2026-07-03) come down.

## 2. Install dependencies

No new dependencies were added (Gemini support uses Node's built-in `fetch`, not a new SDK), but run it anyway since `package-lock.json` did change:

```bash
npm install
```

## 3. Set nova-pro as the plan model

By default the new code uses **Nova Micro** for plan generation (cheaper). To use **Nova Pro** instead, add or edit this line in `.env`:

```bash
BEDROCK_TEXT_MODEL_ID=us.amazon.nova-pro-v1:0
```

This is the new var name, so it wins over any existing `BEDROCK_PLAN_MODEL_ID` line — you don't need to delete the old line, just add this one (or edit it in place if it's already there from a previous attempt).

Quick one-liner if you'd rather not open an editor:

```bash
grep -q '^BEDROCK_TEXT_MODEL_ID=' .env \
  && sed -i 's|^BEDROCK_TEXT_MODEL_ID=.*|BEDROCK_TEXT_MODEL_ID=us.amazon.nova-pro-v1:0|' .env \
  || echo 'BEDROCK_TEXT_MODEL_ID=us.amazon.nova-pro-v1:0' >> .env
```

## 4. Restart with PM2

```bash
pm2 restart waylo-backend --update-env
```

`--update-env` makes sure PM2 refreshes its own environment snapshot for the process, not just relies on what it cached from the last start.

## 5. Verify

Check the boot log — it should print the resolved model ids, and you should see `text=us.amazon.nova-pro-v1:0`:

```bash
pm2 logs waylo-backend --lines 20 --nostream
```

Expected line:
```
[bedrock] text=us.amazon.nova-pro-v1:0 vision=us.amazon.nova-lite-v1:0 objectDetect=us.amazon.nova-2-lite-v1:0
[llm] AI_PROVIDER=bedrock
Waylo backend running on port <PORT>
```

Then hit the endpoints:

```bash
curl -s http://localhost:<PORT>/health

curl -s -X POST http://localhost:<PORT>/plan \
  -H "Content-Type: application/json" \
  -d '{"task": "open youtube and search for a song"}'
```

Expect a `200` with `"success": true` and a `steps` array where each step has at least `stepNumber`/`instruction`/`findDescription` (the Android app needs nothing changed to parse this).

## If something's wrong

- **500 instead of 200 on `/plan`**: check `pm2 logs waylo-backend` for the actual error — likely an AWS credentials/permissions issue, unrelated to this deploy (the code path is unchanged from what was already live).
- **429 with `quota_exceeded`**: Bedrock is throttling or the account has a temporary access hold, and no cached plan was similar enough to serve instead. Not a regression — this used to be a silent 500, now it's a labeled 429. Retry in a bit.
- **Roll back**: `git log --oneline -5` to find the prior commit, then `git checkout <commit> -- .` or `git reset --hard <commit>` (only if you're sure there's nothing uncommitted on the box), then repeat steps 2 and 4.

## Local verification already done (2026-07-05, this repo, not on EC2)

- Confirmed the server boots cleanly with both old-style and new-style Bedrock env var names, and logs the resolved model ids at startup.
- Confirmed a live `/plan` call reaches Bedrock and returns a valid plan with the exact fields the Android app expects.
- Unit-tested the quota/throttle error classifier against 5 realistic error shapes (Bedrock throttle, Bedrock access-denied/verification-hold, Gemini 429, a plain JSON parse error, and a Bedrock invalid-credentials error) — the classifier correctly ignores the last two so genuine bugs aren't silently downgraded to "retry later".
- Exercised the full `/plan` route with the model call mocked to throw a throttle error: with no cache configured locally, it correctly returned `429` + `{ "code": "quota_exceeded" }` instead of a `500`.
- Did **not** test the Gemini provider path (no Gemini quota available) or the pgvector cache-hit branch of the quota fallback (no `DATABASE_URL` configured locally) — worth a quick sanity check on EC2 where the real database is reachable.
