# Waylo Backend

Backend server for Waylo - an AI-powered Android app that helps elderly users navigate smartphone apps through guided instructions with visual indicators and voice guidance.

## Features

- **Multilingual Support**: Detects and responds in 10 Indian languages + English
- **AI-Powered Instructions**: Uses Google Gemini 1.5 Flash to generate step-by-step guides
- **Persistent Guides**: Saves guides to Supabase with 30-day expiry
- **Rate Limiting**: Protects the /plan endpoint from abuse
- **CORS Enabled**: Ready for cross-origin requests

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
- `GEMINI_API_KEY`: Your Google Gemini API key
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
      "expectedScreenTitle": "WhatsApp"
    }
  ],
  "totalSteps": 5
}
```

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
├── gemini.js         # Gemini API integration with multilingual prompts
├── supabase.js       # Supabase database client
├── langdetect.js     # Language detection utility
├── package.json      # Dependencies and scripts
├── .env.example      # Environment variables template
└── README.md         # This file
```

## Deployment

This backend is designed to be deployed on Railway, Render, or any Node.js hosting platform.

### Environment Variables Required:
- `GEMINI_API_KEY`
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `PORT` (auto-set by most platforms)

## Logging

The server logs important events for monitoring:
- Plan requests with detected language
- Gemini responses with step count
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
