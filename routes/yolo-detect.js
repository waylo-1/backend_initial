// routes/yolo-detect.js
// CommonJS. Proxies /detect-elements to the Python YOLO microservice (Layer 2.5).
// The Python service (yolo-service/) runs as a SEPARATE Railway service; set its
// internal URL in the YOLO_SERVICE_URL env var on this Node service.

const express = require('express');
const router = express.Router();

const PYTHON_SERVICE_URL = process.env.YOLO_SERVICE_URL;
// A CPU-only box running two YOLO models (plus optional CLIP/SigLIP matching)
// legitimately needs more than the old 5s. Configurable via YOLO_TIMEOUT_MS.
const YOLO_TIMEOUT_MS = parseInt(process.env.YOLO_TIMEOUT_MS || '12000', 10);

// Learn a new icon concept (user-verified detections teach the captioner).
router.post('/vocab/add', async (req, res) => {
  if (!PYTHON_SERVICE_URL) return res.status(503).json({ error: 'YOLO service not configured' });
  try {
    const r = await fetch(`${PYTHON_SERVICE_URL}/vocab`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: req.body?.name, phrase: req.body?.phrase }),
    });
    return res.status(r.status).json(await r.json());
  } catch (err) {
    console.error('[YOLO] vocab/add failed:', err.message);
    return res.status(502).json({ error: 'vocab add failed' });
  }
});

router.post('/detect-elements', async (req, res) => {
  const { screenshot_b64, target_label, step_instruction, screen_region } = req.body || {};

  if (!screenshot_b64) {
    return res.status(400).json({ error: 'screenshot_b64 is required', elements: [] });
  }
  if (!PYTHON_SERVICE_URL) {
    console.error('[YOLO] YOLO_SERVICE_URL env var not set');
    return res.status(503).json({ error: 'YOLO service not configured', elements: [] });
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), YOLO_TIMEOUT_MS);

    const response = await fetch(`${PYTHON_SERVICE_URL}/detect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ screenshot_b64, target_label, step_instruction, screen_region }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) {
      const text = await response.text();
      console.error(`[YOLO] Python service error ${response.status}: ${text}`);
      return res.status(502).json({ error: 'YOLO service error', elements: [] });
    }

    const data = await response.json();
    console.log(`[YOLO] Detected ${data.elements?.length ?? 0} elements`);
    return res.json(data);
  } catch (err) {
    if (err.name === 'AbortError') {
      console.error('[YOLO] Timeout calling Python service');
      return res.status(504).json({ error: 'YOLO service timeout', elements: [] });
    }
    console.error('[YOLO] Proxy error:', err.message);
    return res.status(500).json({ error: err.message, elements: [] });
  }
});

module.exports = router;
