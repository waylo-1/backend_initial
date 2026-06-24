/**
 * Waylo Backend - Main Express Server
 * AI-powered smartphone guide for elderly users
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { detectLanguage } = require('./langdetect');
const { generateSteps, generateDesktopSteps, generateEnrichedSteps, recoverDesktopStep, detectObject } = require('./bedrock');
const supabase = require('./supabase');
const visionRouter = require('./routes/vision');
const visionFallbackRouter = require('./routes/vision-fallback');
const failureRouter = require('./routes/failure');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
// Raised limit: /vision receives Base64 JPEG screenshots which exceed the
// default 100kb body limit.
app.use(express.json({ limit: '12mb' }));

// Rate limiter for /plan endpoint
const planLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 20, // 20 requests per minute
  message: { error: 'Too many requests, please wait a minute' },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Health check endpoint
 */
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString()
  });
});

/**
 * POST /plan
 * Generate step-by-step instructions for a task
 */
app.post('/plan', planLimiter, async (req, res) => {
  try {
    const { task, platform } = req.body;

    if (!task || typeof task !== 'string' || task.trim().length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Task is required and must be a non-empty string'
      });
    }

    // macOS desktop companion (Waylo Desktop) uses a different element model
    // and expects { task, app, steps:[{ index, instruction, findDescription }] }.
    if (platform === 'macos') {
      console.log(`Plan requested (macOS): ${task}`);
      const plan = await generateDesktopSteps(task);
      console.log(`Bedrock desktop response received, ${plan.steps?.length || 0} steps parsed`);
      return res.json(plan);
    }

    // Detect language
    const language = detectLanguage(task);
    console.log(`Plan requested: ${task} | Language detected: ${language}`);

    // Generate enriched 8-field steps. The richer per-step metadata gives the
    // Android detection layers much more signal to match against, reducing
    // costly vision fallbacks.
    const plan = await generateEnrichedSteps(task);
    console.log(`Bedrock response received, ${plan.steps.length} enriched steps parsed`);

    res.json({
      success: true,
      appPackage: plan.appPackage,
      appName: plan.appName,
      language,
      steps: plan.steps,
      totalSteps: plan.steps.length
    });

  } catch (error) {
    console.error('Error in /plan:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to generate plan',
      details: error.message
    });
  }
});

// Vision endpoint (Layer 3: locate + troubleshoot)
app.use('/vision', visionRouter);

// Vision fallback endpoint for the macOS desktop companion
app.use('/vision-fallback', visionFallbackRouter);

/**
 * POST /nova-vision
 * Layer 3 grounding via Nova 2 Lite object detection.
 * Body: { image_base64, target_label, step_instruction }
 * Returns: { found, bbox: [xMin,yMin,xMax,yMax] (0-1000), label } or { found: false }
 */
app.post('/nova-vision', async (req, res) => {
  try {
    const { image_base64, target_label, step_instruction } = req.body || {};
    if (!image_base64 || !target_label) {
      return res.status(400).json({ found: false, error: 'image_base64 and target_label are required' });
    }
    const result = await detectObject({
      screenshot: image_base64,
      targetLabel: target_label,
      stepInstruction: step_instruction || '',
    });
    return res.json(result);
  } catch (error) {
    console.error('Error in /nova-vision:', error.message);
    return res.status(200).json({ found: false });
  }
});

/**
 * POST /recover
 * Self-healing: when the desktop app can't locate an element, it sends a
 * screenshot. The model relabels the element or replans the remaining steps.
 */
app.post('/recover', async (req, res) => {
  try {
    const { screenshot, task, instruction, targetLabel, stepIndex = 0, totalSteps = 1 } = req.body || {};
    if (!screenshot || !task) {
      return res.status(400).json({ error: 'screenshot and task are required' });
    }
    const result = await recoverDesktopStep({
      screenshot,
      task,
      instruction: instruction || '',
      targetLabel: targetLabel || '',
      stepIndex,
      totalSteps,
    });
    return res.json(result);
  } catch (error) {
    console.error('Error in /recover:', error.message);
    return res.status(500).json({ error: 'recover failed', details: error.message });
  }
});

// Detection failure logging endpoint (stores misses for future YOLO training)
app.use('/failure', failureRouter);

/**
 * POST /guide
 * Save a guide to database and return shareable link
 */
app.post('/guide', async (req, res) => {
  try {
    const { steps, taskName, language } = req.body;

    // Validation
    if (!steps || !Array.isArray(steps) || steps.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Steps array is required and must not be empty'
      });
    }

    if (!taskName || typeof taskName !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'Task name is required'
      });
    }

    if (!language || typeof language !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'Language is required'
      });
    }

    // Generate random 8-character alphanumeric ID
    const id = generateRandomId(8);

    // Calculate expiry date (30 days from now)
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 30);

    // Insert into Supabase
    const { error } = await supabase
      .from('guides')
      .insert({
        id,
        task_name: taskName,
        language,
        steps,
        expires_at: expiresAt.toISOString()
      });

    if (error) {
      throw error;
    }

    console.log(`Guide saved: ${id}`);

    res.json({
      success: true,
      id,
      link: `https://waylo.app/g/${id}`
    });

  } catch (error) {
    console.error('Error in /guide:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to save guide',
      details: error.message
    });
  }
});


/**
 * GET /guide/:id
 * Retrieve a saved guide by ID
 */
app.get('/guide/:id', async (req, res) => {
  try {
    const { id } = req.params;

    if (!id || id.length !== 8) {
      return res.status(400).json({
        success: false,
        error: 'Invalid guide ID'
      });
    }

    // Query Supabase
    const { data, error } = await supabase
      .from('guides')
      .select('*')
      .eq('id', id)
      .single();

    if (error || !data) {
      return res.status(404).json({
        success: false,
        error: 'Guide not found'
      });
    }

    // Check if expired
    const now = new Date();
    const expiresAt = new Date(data.expires_at);

    if (now > expiresAt) {
      return res.status(410).json({
        success: false,
        error: 'This guide has expired'
      });
    }

    res.json({
      success: true,
      taskName: data.task_name,
      language: data.language,
      steps: data.steps,
      totalSteps: data.steps.length
    });

  } catch (error) {
    console.error('Error in /guide/:id:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve guide',
      details: error.message
    });
  }
});

/**
 * Utility function to generate random alphanumeric ID
 * @param {number} length - Length of the ID
 * @returns {string} Random alphanumeric string
 */
function generateRandomId(length) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

// Start server
app.listen(PORT, () => {
  console.log(`Waylo backend running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});
