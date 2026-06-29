/**
 * Hardcoded demo plans for the macOS app.
 *
 * These bypass the Nova planner AND the semantic cache entirely so a demo/video
 * is 100% deterministic — no hallucinated buttons, no cold-start latency. If the
 * spoken/typed task fuzzy-matches one of the demos below, that exact plan is
 * returned immediately.
 *
 * To add/edit a demo: add an entry to DEMOS with `triggers` (substrings to match
 * in the normalized task) and a `plan` ({ task, app, steps:[...] }). Steps use the
 * same shape as the live macOS planner. Order matters only if triggers overlap
 * (first match wins) — keep triggers specific.
 */

/** Lowercases, strips punctuation, collapses whitespace. */
function normalize(task) {
  return String(task || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Builds a fully-formed macOS step with sensible defaults. */
function step(i, action, instruction, opts = {}) {
  return {
    index: i,
    action,                          // click | type | key | info
    instruction,
    findDescription: opts.findDescription || instruction,
    targetLabel: opts.targetLabel || '',
    elementDescription: opts.elementDescription || instruction,
    screenRegion: opts.screenRegion || 'fullScreen',
    targetType: opts.targetType || 'text',   // text | icon
    controlKind: opts.controlKind || '',
    anchorText: opts.anchorText || '',
    anchorPosition: opts.anchorPosition || '',
    key: opts.key || null,
  };
}

// Reused first step: open System Settings from the Dock.
const openSystemSettings = () =>
  step(1, 'click', 'Click the System Settings icon in the Dock to open it.', {
    targetLabel: 'System Settings',
    elementDescription: 'System Settings app icon (gear) in the Dock',
    targetType: 'icon',
    controlKind: 'button',
  });

const DEMOS = [
  {
    triggers: ['dark mode', 'darkmode', 'dark theme', 'dark appearance', 'switch to dark', 'turn on dark'],
    plan: {
      task: 'Turn on Dark Mode',
      app: 'System Settings',
      steps: [
        openSystemSettings(),
        step(2, 'click', 'Click "Appearance" in the sidebar.', {
          targetLabel: 'Appearance',
          elementDescription: 'Appearance row in the System Settings sidebar',
          screenRegion: 'sidebar',
          controlKind: 'row',
        }),
        step(3, 'click', 'Click the "Dark" option to switch your Mac to dark mode.', {
          targetLabel: 'Dark',
          elementDescription: 'Dark appearance thumbnail option',
          controlKind: 'button',
          anchorText: 'Appearance',
          anchorPosition: 'below',
        }),
      ],
    },
  },
  {
    triggers: ['change password', 'change my password', 'change the password', 'reset password',
               'device password', 'laptop password', 'login password', 'mac password'],
    plan: {
      task: 'Change my Mac password',
      app: 'System Settings',
      steps: [
        openSystemSettings(),
        step(2, 'click', 'Click "Touch ID & Password" in the sidebar.', {
          targetLabel: 'Touch ID & Password',
          elementDescription: 'Touch ID & Password row in the System Settings sidebar',
          screenRegion: 'sidebar',
          controlKind: 'row',
        }),
        step(3, 'click', 'Click the "Change Password…" button.', {
          targetLabel: 'Change Password',
          elementDescription: 'Change Password button next to your login password',
          controlKind: 'button',
          anchorText: 'Password',
          anchorPosition: 'near',
        }),
      ],
    },
  },
  {
    triggers: ['photo booth', 'photobooth', 'take a photo', 'take a picture', 'take a selfie'],
    plan: {
      task: 'Open Photo Booth and take a photo',
      app: 'Photo Booth',
      steps: [
        step(1, 'key', 'Press Command and Space to open Spotlight search.', {
          key: 'space',
          elementDescription: 'Spotlight search opened with Command + Space',
        }),
        step(2, 'type', 'Type "Photo Booth" to search for the app.', {
          key: 'Photo Booth',
          elementDescription: 'Spotlight search field',
        }),
        step(3, 'key', 'Press Return to open Photo Booth.', {
          key: 'return',
          elementDescription: 'Open the top Spotlight result',
        }),
        step(4, 'click', 'Click the red camera button to take a photo.', {
          elementDescription: 'red camera shutter button at the bottom center of the Photo Booth window',
          targetType: 'icon',
          controlKind: 'button',
          screenRegion: 'statusBar',
        }),
      ],
    },
  },
];

/**
 * Returns a deep-cloned hardcoded plan if the task matches a demo, else null.
 */
function getDemoPlan(task) {
  const n = normalize(task);
  if (!n) return null;
  for (const demo of DEMOS) {
    if (demo.triggers.some((t) => n.includes(t))) {
      return JSON.parse(JSON.stringify(demo.plan));
    }
  }
  return null;
}

module.exports = { getDemoPlan };
