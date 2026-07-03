/**
 * AWS Bedrock raw model access (Amazon Nova via the Converse API).
 *
 * Model roles:
 *   text   — Nova Micro: plan generation, concept Q&A (no image input)
 *   vision — Nova Lite: locate/troubleshoot/recover/ask-screen (image input)
 *   object detection (nova-vision bbox) keeps its own model id — Nova 2 Lite is
 *   specifically tuned for grounding/bbox output and predates the general
 *   "vision" role above.
 *
 * Only loaded when AI_PROVIDER=bedrock (see services/llm.js), so Gemini-only
 * deployments never need AWS credentials.
 */

const {
  BedrockRuntimeClient,
  ConverseCommand,
} = require('@aws-sdk/client-bedrock-runtime');

const REGION = process.env.AWS_REGION || 'us-east-1';
const TEXT_MODEL_ID = process.env.BEDROCK_TEXT_MODEL_ID || 'us.amazon.nova-micro-v1:0';
const VISION_MODEL_ID = process.env.BEDROCK_VISION_MODEL_ID || 'us.amazon.nova-lite-v1:0';
const OBJECT_DETECT_MODEL_ID = process.env.BEDROCK_OBJECT_DETECT_MODEL_ID || 'us.amazon.nova-2-lite-v1:0';

if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
  throw new Error('AI_PROVIDER=bedrock requires AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY in the environment');
}

const client = new BedrockRuntimeClient({
  region: REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

async function converse({ modelId, system, content, maxTokens = 1500, temperature = 0.3 }) {
  const command = new ConverseCommand({
    modelId,
    system: system ? [{ text: system }] : undefined,
    messages: [{ role: 'user', content }],
    inferenceConfig: { maxTokens, temperature },
  });

  const response = await client.send(command);
  const text = response?.output?.message?.content
    ?.map((block) => block.text || '')
    .join('')
    .trim();

  if (!text) {
    throw new Error('Bedrock returned an empty response');
  }
  return text;
}

/** Text-only call (no image). Uses Nova Micro. */
async function askText({ system, prompt, maxTokens = 1500, temperature = 0.3 }) {
  return converse({
    modelId: TEXT_MODEL_ID,
    system,
    content: [{ text: prompt }],
    maxTokens,
    temperature,
  });
}

/** Single-image call. Uses Nova Lite. */
async function askVision({ system, prompt, imageBase64, maxTokens = 1500, temperature = 0.3 }) {
  return converse({
    modelId: VISION_MODEL_ID,
    system,
    content: [
      { text: prompt },
      { image: { format: 'jpeg', source: { bytes: Buffer.from(imageBase64, 'base64') } } },
    ],
    maxTokens,
    temperature,
  });
}

/** Object-detection call (bbox grounding). Uses Nova 2 Lite. */
async function askObjectDetection({ prompt, imageBase64, maxTokens = 400, temperature = 0.0 }) {
  return converse({
    modelId: OBJECT_DETECT_MODEL_ID,
    content: [
      { image: { format: 'jpeg', source: { bytes: Buffer.from(imageBase64, 'base64') } } },
      { text: prompt },
    ],
    maxTokens,
    temperature,
  });
}

module.exports = { askText, askVision, askObjectDetection };
