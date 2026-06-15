/**
 * POST /failure
 *
 * Records a detection failure: every on-device layer (L0/L1/L2) missed the
 * target element for a step, so the app fell back to vision. We store the event
 * (including the screenshot) in Supabase as future YOLO training material.
 */
const express = require('express');
const router = express.Router();
const supabase = require('../supabase');

router.post('/', async (req, res) => {
  try {
    const {
      sessionId,
      taskDescription,
      stepNumber,
      findDescription,
      elementType,
      screenRegion,
      visualDescription,
      targetPackage,
      layerReached,
      screenshotBase64,
      screenWidth,
      screenHeight,
      timestamp
    } = req.body;

    // Validate required fields
    if (!sessionId || !findDescription || !screenshotBase64) {
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }

    // Store in Supabase
    const { error } = await supabase
      .from('detection_failures')
      .insert({
        session_id: sessionId,
        task_description: taskDescription,
        step_number: stepNumber,
        find_description: findDescription,
        element_type: elementType,
        screen_region: screenRegion,
        visual_description: visualDescription,
        target_package: targetPackage,
        layer_reached: layerReached,
        screenshot_base64: screenshotBase64,
        screen_width: screenWidth,
        screen_height: screenHeight,
        created_at: new Date(timestamp || Date.now()).toISOString()
      });

    if (error) {
      console.error('Supabase insert error:', error);
      return res.status(500).json({ success: false, error: 'Database error' });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('/failure error:', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

module.exports = router;
