/**
 * POST /failure
 *
 * Records a detection failure (every on-device layer missed) for future
 * training material. AWS schema (detection_failures): id BIGSERIAL,
 * step_description TEXT, platform TEXT, screenshot_path TEXT, created_at.
 */
const express = require('express');
const router = express.Router();
const db = require('../db');

router.post('/', async (req, res) => {
  try {
    const { findDescription, stepDescription, platform } = req.body || {};
    const description = stepDescription || findDescription;

    if (!description) {
      return res.status(400).json({ success: false, error: 'step_description is required' });
    }

    await db.query(
      'INSERT INTO detection_failures (step_description, platform) VALUES ($1, $2)',
      [description, platform || null]
    );

    res.json({ success: true });
  } catch (err) {
    console.error('/failure error:', err.message);
    res.status(500).json({ success: false, error: 'Database error' });
  }
});

module.exports = router;
