/**
 * Google Cloud Text-to-Speech — natural, human-sounding narration for the app's
 * spoken step instructions (replaces the tinny on-device compact voice). Another
 * Google Cloud product in the production path (XPRIZE story).
 *
 * Needs the Cloud Text-to-Speech API enabled and a key in GOOGLE_TTS_API_KEY
 * (falls back to GEMINI_API_KEY if that key's GCP project also has TTS enabled).
 * Returns base64-encoded MP3, or null when unavailable so the app falls back to
 * the on-device voice gracefully — TTS is never allowed to break guidance.
 */

const API_KEY = process.env.GOOGLE_TTS_API_KEY || process.env.GEMINI_API_KEY;
const ENDPOINT = 'https://texttospeech.googleapis.com/v1/text:synthesize';

// One natural Neural2 voice per supported language. Neural2 is high quality and
// far cheaper than Studio; override per deploy with GOOGLE_TTS_VOICE_<LANG>.
const VOICE_BY_LANG = {
  en: { languageCode: 'en-US', name: process.env.GOOGLE_TTS_VOICE_EN || 'en-US-Neural2-C' },
  hi: { languageCode: 'hi-IN', name: process.env.GOOGLE_TTS_VOICE_HI || 'hi-IN-Neural2-A' },
  pa: { languageCode: 'pa-IN', name: process.env.GOOGLE_TTS_VOICE_PA || 'pa-IN-Wavenet-A' },
};

const available = () => !!API_KEY;

/**
 * Synthesize `text` in `language` (e.g. "en-US"). Returns base64 MP3 or null.
 */
async function synthesize(text, language = 'en-US') {
  if (!API_KEY) return null;
  const clean = String(text || '').trim();
  if (!clean) return null;
  const short = String(language || 'en').toLowerCase().slice(0, 2);
  const voice = VOICE_BY_LANG[short] || VOICE_BY_LANG.en;

  const body = {
    input: { text: clean.slice(0, 900) },
    voice: { languageCode: voice.languageCode, name: voice.name },
    audioConfig: { audioEncoding: 'MP3', speakingRate: 1.0, pitch: 0.0 },
  };

  try {
    const res = await fetch(`${ENDPOINT}?key=${API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = (await res.text()).slice(0, 200);
      console.warn(`[tts] Google TTS ${res.status}: ${err}`);
      return null;
    }
    const data = await res.json();
    return data.audioContent || null; // base64 MP3
  } catch (e) {
    console.warn('[tts] Google TTS request failed:', e.message);
    return null;
  }
}

module.exports = { synthesize, available };
