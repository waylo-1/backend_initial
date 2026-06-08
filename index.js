/**
 * Waylo Backend - Main Express Server
 * AI-powered smartphone guide for elderly users
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { detectLanguage } = require('./langdetect');
const { generateSteps } = require('./gemini');
const supabase = require('./supabase');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

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
    const { task } = req.body;

    if (!task || typeof task !== 'string' || task.trim().length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Task is required and must be a non-empty string'
      });
    }


    // Detect language
    const language = detectLanguage(task);
    console.log(`Plan requested: ${task} | Language detected: ${language}`);

    // Generate steps using Gemini
    const steps = await generateSteps(task, language);
    console.log(`Gemini response received, ${steps.length} steps parsed`);

    res.json({
      success: true,
      language,
      steps,
      totalSteps: steps.length
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
