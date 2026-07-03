/**
 * POST /failure
 *
 * Records a detection failure (every on-device layer missed) for future YOLO
 * training material. AWS schema (detection_failures): id UUID, session_id TEXT
 * NOT NULL, task_description TEXT, step_number INTEGER, find_description TEXT
 * NOT NULL, element_type TEXT, screen_region TEXT, visual_description TEXT,
 * target_package TEXT, layer_reached INTEGER, screenshot_base64 TEXT NOT NULL,
 * screen_width INTEGER, screen_height INTEGER, created_at, reviewed,
 * yolo_label_exported. See sql/detection_failures.sql.
 */
const crypto = require('crypto');
const express = require('express');
const router = express.Router();
const db = require('../db');

router.post('/', async (req, res) => {
  try {
    const {
      sessionId,
      taskDescription,
      stepNumber,
      findDescription,
      stepDescription, // legacy alias
      elementType,
      screenRegion,
      visualDescription,
      targetPackage,
      layerReached,
      screenshotBase64,
      screenWidth,
      screenHeight,
    } = req.body || {};

    const description = findDescription || stepDescription;
    if (!description) {
      return res.status(400).json({ success: false, error: 'findDescription is required' });
    }
    if (!screenshotBase64) {
      return res.status(400).json({ success: false, error: 'screenshotBase64 is required' });
    }

    await db.query(
      `INSERT INTO detection_failures
        (session_id, task_description, step_number, find_description, element_type,
         screen_region, visual_description, target_package, layer_reached,
         screenshot_base64, screen_width, screen_height)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        sessionId || crypto.randomUUID(),
        taskDescription || null,
        Number.isInteger(stepNumber) ? stepNumber : null,
        description,
        elementType || null,
        screenRegion || null,
        visualDescription || null,
        targetPackage || null,
        Number.isInteger(layerReached) ? layerReached : null,
        screenshotBase64,
        Number.isInteger(screenWidth) ? screenWidth : null,
        Number.isInteger(screenHeight) ? screenHeight : null,
      ]
    );

    res.json({ success: true });
  } catch (err) {
    console.error('/failure error:', err.message);
    res.status(500).json({ success: false, error: 'Database error' });
  }
});

module.exports = router;
