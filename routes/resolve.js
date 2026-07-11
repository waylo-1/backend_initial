/**
 * POST /resolve/spotify
 *
 * Resolves a free-text query ("drake", "one dance") to a playable Spotify URI
 * so the macOS app can start playback locally via AppleScript — fully
 * autonomous "play X on Spotify" with no on-device vision.
 *
 * Uses the Spotify Web API **client-credentials** flow: an app-level token
 * (no user login) that can SEARCH the catalogue. Playback itself happens on
 * the user's machine (AppleScript `play track <uri>`), so we never need a
 * user-scoped OAuth token.
 *
 * Requires SPOTIFY_CLIENT_ID + SPOTIFY_CLIENT_SECRET in the environment. When
 * they're absent this route returns 501 and the client falls back to opening
 * the in-app search — so the feature degrades gracefully and needs zero setup
 * to be useful.
 *
 * Request:  { query: string, type?: "artist"|"track"|"album"|"playlist" }
 * Response: { uri: "spotify:artist:..." , name, kind }  |  404 { error }
 */
const express = require('express');
const router = express.Router();

const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const SEARCH_URL = 'https://api.spotify.com/v1/search';

// Cache the app token in-process (Spotify tokens live ~1h); refresh a little early.
let cachedToken = null;
let tokenExpiresAt = 0;

async function getAppToken() {
  const id = process.env.SPOTIFY_CLIENT_ID;
  const secret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!id || !secret) return null;

  if (cachedToken && Date.now() < tokenExpiresAt - 60_000) return cachedToken;

  const basic = Buffer.from(`${id}:${secret}`).toString('base64');
  const resp = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!resp.ok) throw new Error(`token ${resp.status}`);
  const json = await resp.json();
  cachedToken = json.access_token;
  tokenExpiresAt = Date.now() + (json.expires_in || 3600) * 1000;
  return cachedToken;
}

router.post('/spotify', async (req, res) => {
  try {
    const query = (req.body && req.body.query ? String(req.body.query) : '').trim();
    if (!query) return res.status(400).json({ error: 'query required' });

    const token = await getAppToken();
    if (!token) {
      return res.status(501).json({ error: 'Spotify not configured on the server' });
    }

    // Prefer the type the user implies; default to artist ("play drake" wants
    // the artist, which plays their top tracks), then fall back to track.
    const requested = ['artist', 'track', 'album', 'playlist'].includes(req.body.type)
      ? req.body.type
      : null;
    const types = requested ? [requested] : ['artist', 'track'];

    const url = `${SEARCH_URL}?q=${encodeURIComponent(query)}&type=${types.join(',')}&limit=1`;
    const sResp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!sResp.ok) throw new Error(`search ${sResp.status}`);
    const data = await sResp.json();

    // Pick the first non-empty result in preference order.
    for (const kind of types) {
      const item = data[`${kind}s`] && data[`${kind}s`].items && data[`${kind}s`].items[0];
      if (item && item.uri) {
        return res.json({ uri: item.uri, name: item.name, kind });
      }
    }
    return res.status(404).json({ error: 'no match' });
  } catch (err) {
    console.error('[resolve/spotify]', err.message);
    return res.status(502).json({ error: 'resolve failed' });
  }
});

module.exports = router;
