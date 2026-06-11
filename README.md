# Waylo Backend

Backend server for Waylo - an AI-powered Android app that helps elderly users navigate smartphone apps through guided instructions with visual indicators and voice guidance.

## Features

- **Multilingual Support**: Detects and responds in 10 Indian languages + English
- **AI-Powered Instructions**: Uses AWS Bedrock (Claude) to generate step-by-step guides
- **App Package Resolution**: Each step is enriched with the target app's Android `appPackage`
  so the on-device element finder prefers the real app over look-alikes
- **Vision Fallback** (`POST /vision`): Claude (Bedrock) vision locates missing elements on a screenshot
  (`locate`) or generates recovery steps when the screen looks wrong (`troubleshoot`)
- **Persistent Guides**: Saves guides to Supabase with 30-day expiry
- **Rate Limiting**: Protects the /plan endpoint from abuse
- **CORS Enabled**: Ready for cross-origin requests

Set `WAYLO_DEBUG=1` to log full vision prompts and raw Gemini responses.

## Supported Languages

- Hindi (hi)
- English (en)
- Tamil (ta)
- Telugu (te)
- Bengali (bn)
- Marathi (mr)
- Gujarati (gu)
- Kannada (kn)
- Malayalam (ml)
- Punjabi (pa)

## Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment Variables

Copy `.env.example` to `.env` and fill in your credentials:

```bash
cp .env.example .env
```

Required variables:
- `AWS_ACCESS_KEY_ID`: Your AWS access key
- `AWS_SECRET_ACCESS_KEY`: Your AWS secret key
- `AWS_REGION`: Bedrock region (e.g. `us-east-1`)
- `BEDROCK_MODEL_ID`: Claude model id / inference profile (e.g. `us.anthropic.claude-3-5-sonnet-20241022-v2:0`)
- `SUPABASE_URL`: Your Supabase project URL
- `SUPABASE_ANON_KEY`: Your Supabase anonymous key
- `PORT`: Server port (default: 3000)

### 3. Setup Supabase Database

Run this SQL in your Supabase SQL editor:

```sql
CREATE TABLE guides (
  id TEXT PRIMARY KEY,
  task_name TEXT NOT NULL,
  language TEXT NOT NULL DEFAULT 'hi',
  steps JSONB NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  expires_at TIMESTAMP NOT NULL
);

-- Create index for faster lookups
CREATE INDEX idx_guides_expires_at ON guides(expires_at);
```

### 4. Start the Server

Development mode (with auto-reload):
```bash
npm run dev
```

Production mode:
```bash
npm start
```

## API Endpoints

### GET /health

Health check endpoint.

**Response:**
```json
{
  "status": "ok",
  "timestamp": "2024-01-15T10:30:00.000Z"
}
```

### POST /plan

Generate step-by-step instructions for a task.

**Rate Limit:** 20 requests per minute per IP

**Request:**
```json
{
  "task": "व्हाट्सएप पर अपनी प्रोफाइल फोटो कैसे बदलें"
}
```

**Response:**
```json
{
  "success": true,
  "language": "hi",
  "steps": [
    {
      "stepNumber": 1,
      "instruction": "व्हाट्सएप खोलें",
      "findDescription": "WhatsApp icon",
      "appName": "WhatsApp",
      "expectedScreenTitle": "WhatsApp",
      "appPackage": "com.whatsapp"
    }
  ],
  "totalSteps": 5
}
```

### POST /vision

Layer 3 fallback. Sends a Base64 JPEG screenshot to Gemini Vision.

**Request:**
```json
{
  "mode": "locate | troubleshoot",
  "screenshotBase64": "<base64 jpeg>",
  "task": "open youtube history",
  "currentStepIndex": 2,
  "totalSteps": 4,
  "findDescription": "History tab in YouTube library",
  "screenWidth": 1080,
  "screenHeight": 2400,
  "language": "en"
}
```

**Response (`locate`):** `{ "found", "x", "y", "confidence", "whatYouSee", "updatedFindDescription" }`

**Response (`troubleshoot`):** `{ "recoverable", "rootCause", "explanation", "newSteps": [...] }`

Gemini calls have a 60s timeout; a 429 from Gemini is retried once after 5s.

### POST /guide

Save a guide and get a shareable link.

**Request:**
```json
{
  "steps": [...],
  "taskName": "Change WhatsApp profile photo",
  "language": "hi"
}
```

**Response:**
```json
{
  "success": true,
  "id": "abc12345",
  "link": "https://waylo.app/g/abc12345"
}
```

### GET /guide/:id

Retrieve a saved guide by ID.

**Response:**
```json
{
  "success": true,
  "taskName": "Change WhatsApp profile photo",
  "language": "hi",
  "steps": [...],
  "totalSteps": 5
}
```

**Error Responses:**
- `404` - Guide not found
- `410` - Guide has expired (>30 days old)

## Project Structure

```
waylo-backend/
├── index.js          # Main Express server
├── bedrock.js        # AWS Bedrock (Claude) integration with multilingual prompts + appPackage enrichment
├── routes/
│   ├── vision.js          # /vision — Claude vision: locate + troubleshoot (Android)
│   └── vision-fallback.js # /vision-fallback — desktop (macOS) screenshot analysis
├── supabase.js       # Supabase database client
├── langdetect.js     # Language detection utility
├── package.json      # Dependencies and scripts
├── .env.example      # Environment variables template
└── README.md         # This file
```

## Android Element-Finding Pipeline (frontend_systemsettings_overlay)

The app finds each step's target element through layered search, fastest first:

| Layer | What | Where | Budget |
|---|---|---|---|
| 0 | Accessibility tree scoring (threshold 70, `appPackage` bonus +60, cached tree) | `ElementFinder.kt` | 300ms (+1 retry after 500ms) |
| 1 | ML Kit text recognition, Latin + Devanagari, on a downscaled screenshot | `MLKitFinder.kt` | 800ms |
| 2 | Icon recognition: colour signature → ML Kit labeling → TFLite classifier | `icon/IconFinder.kt` | 600ms |
| 3a | Gemini Vision `locate` via backend | `GeminiVisionClient.kt` | 15s |
| 3b | Gemini Vision `troubleshoot` → recovery steps spliced into the plan | `GeminiVisionClient.kt` | 20s |

Layer 2 Part C needs `app/src/main/assets/icon_classifier.tflite` (bundled; any
224×224 float32 ImageNet classifier works) — it degrades gracefully if absent.

## Deployment

This backend is designed to be deployed on Railway, Render, or any Node.js hosting platform.

### Environment Variables Required:
- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`
- `AWS_REGION`
- `BEDROCK_MODEL_ID`
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `PORT` (auto-set by most platforms)

## Logging

The server logs important events for monitoring:
- Plan requests with detected language
- Bedrock responses with step count
- Guide saves with generated IDs

## Error Handling

All endpoints return consistent error responses:
```json
{
  "success": false,
  "error": "Error description",
  "details": "Detailed error message"
}
```

## License

Proprietary - Waylo
