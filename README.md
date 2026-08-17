<div align="center">

# 🔴 Waylo — Backend

**The shared brain for the Waylo apps: Gemini planning + vision, YOLO detection, a semantic plan cache, accounts, and remote config.**

[![Node](https://img.shields.io/badge/Node.js-Express-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![Gemini](https://img.shields.io/badge/AI-Google%20Gemini-4285F4?logo=googlegemini&logoColor=white)](https://ai.google.dev)
[![pgvector](https://img.shields.io/badge/Postgres-pgvector-336791?logo=postgresql&logoColor=white)](https://github.com/pgvector/pgvector)
[![Website](https://img.shields.io/badge/website-waylo--web.vercel.app-6C4CF1)](https://waylo-web-virid.vercel.app)

</div>

Node.js / Express service that both the [**macOS and Android apps**](https://github.com/waylo-1/frontend_systemsettings_overlay) talk to. It turns a plain-language task into a step-by-step plan with **Google Gemini**, is the **main vision fallback** for grounding on-screen elements, and gets faster and cheaper over time via a semantic plan cache and fleet learning.

---

## 🧠 What it does

1. **Plans the task** — `POST /plan` sends the task + a live screen snapshot to **Gemini**, which returns a step-by-step plan (one click / type / key per step). Plans are cached **semantically** (pgvector embeddings) so a paraphrase of a prior task returns instantly, shared across all users.
2. **Grounds vision** — when the apps' cheap on-device layers can't locate a target, they call the backend's **Gemini vision** (and a **YOLO** microservice) to find the exact element, returning a bounding box + a plain-language hint. Set-of-Mark disambiguation stamps numbered badges and lets Gemini pick among look-alikes.
3. **Learns** — verified clicks and labelled icons are stored and reused; `POST /plan/learn` / `POST /plan/forget` update the cached plan for a task.
4. **Runs the business** — email accounts, a freemium limit (free vs paid tasks), and an analytics dashboard.
5. **Tunes the apps remotely** — `GET /config` serves `app-config.json` so behaviour changes with no app re-download.

---

## 🔌 Key endpoints

| Endpoint | Purpose |
|----------|---------|
| `POST /plan` | Generate (or semantic-cache) a step plan for a task |
| `POST /vision`, `/vision-fallback` | Ground an element via Gemini/YOLO vision |
| `POST /pick-element` | Set-of-Mark: Gemini picks the right numbered candidate |
| `POST /plan/learn`, `/plan/forget` | Remember / drop a corrected plan |
| `GET /config` | Remote config (Judge Mode, voice engine, messages, update prompt) |
| `POST /tts` | Google Cloud Text-to-Speech (natural voice) |
| `GET /me`, `POST /register`, `POST /upgrade` | Accounts + freemium (macOS/web) |
| `POST /auth/google`, `GET /entitlement`, `POST /entitlement/consume`, `POST /feedback` | Accounts + entitlement (Android) |
| `GET /admin/stats` | Analytics dashboard (ADMIN_KEY-gated) |

---

## 🏗 Architecture

```
apps ──► /plan ──► semantic plan cache (pgvector)  ── hit? return instantly
                    │ miss
                    ▼
                 Gemini  (services/llm.js → providers/gemini.js)  → step plan
apps ──► /vision ─► Gemini vision  ── still hard? ─► YOLO microservice (Python)
                    ▼
             bounding box + hint  → the app draws the red dot
```

- `index.js` — routes + the freemium paywall + remote config
- `services/llm.js`, `services/providers/gemini.js` — Gemini planning + vision
- `services/promptSpecs.js` — the planner's app-specific flow knowledge
- `semanticPlanCache.js` — pgvector cache, versioned per platform
- `users.js`, `routes/auth.js` — accounts, entitlement, freemium
- `services/googleTTS.js` — Google Cloud TTS
- `routes/yolo-detect.js` + the Python YOLO service — object detection

---

## 🚀 Running & deploying

**Local:**
```bash
npm install
cp .env.example .env    # fill in the keys below
node index.js           # starts on :3000
```

**Production (AWS EC2 + pm2):** two processes — `waylo-backend` and `yolo-service`.
```bash
cd ~/backend_initial
git pull
pm2 restart waylo-backend
```

### Environment variables

| Var | Purpose |
|-----|---------|
| `GEMINI_API_KEY` | Google Gemini (planning + vision) — **required** |
| `AI_PROVIDER` | `gemini` |
| `DATABASE_URL` | Postgres + pgvector (plan cache, accounts) |
| `GOOGLE_TTS_API_KEY` | Google Cloud TTS (optional; falls back to on-device) |
| `FREE_TASK_LIMIT`, `PAID_TASK_LIMIT` | Freemium limits (default 5 / 25) |
| `DEVELOPER_EMAILS` | Emails with unlimited tasks |
| `JUDGE_BUILD_KEY` | Key the reviewer app sends to waive the paywall |
| `ADMIN_KEY` | Guards `/admin/stats` |
| `UPGRADE_URL` | Link shown when a user hits the free limit |

*(Never commit real secrets — use environment variables / `.env`.)*

---

## 🎛 Remote config (`app-config.json`)

Edit this file, `git pull` on the server, and it takes effect on the next `/config` fetch — **no app re-download**:

```json
{
  "maxAccuracy": true,
  "novaMinConfidence": 0.55,
  "voiceEngine": "system",
  "message": "",
  "messageLevel": "info",
  "latestVersion": "1.1",
  "updateURL": ""
}
```

To push a **new app build**: upload the `.dmg`, then set `latestVersion` + `updateURL` — running apps show a "Download update" prompt.

---

<div align="center">

**Part of [Waylo](https://github.com/waylo-1)** · [Website](https://waylo-web-virid.vercel.app) · [Apps](https://github.com/waylo-1/frontend_systemsettings_overlay)

</div>
