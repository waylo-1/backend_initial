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
    autoAdvanceSeconds: opts.autoAdvanceSeconds || 0,
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
    triggers: ['photo booth', 'photobooth', 'take a photo', 'take a picture', 'take a selfie',
               'send a photo', 'send the photo', 'send a picture', 'photo to whatsapp', 'picture to whatsapp'],
    plan: {
      task: 'Take a photo in Photo Booth and send it on WhatsApp',
      app: 'Photo Booth',
      steps: [
        // --- Open Photo Booth via Spotlight ---
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
        // --- Take the photo ---
        step(4, 'click', 'Click the red camera button to take a photo.', {
          elementDescription: 'red camera shutter button at the bottom center of the Photo Booth window',
          targetType: 'icon',
          controlKind: 'button',
          screenRegion: 'statusBar',
        }),
        step(5, 'info', 'Smile! Photo Booth counts down 3, 2, 1 and snaps the photo.', {
          autoAdvanceSeconds: 4,
          elementDescription: 'Photo Booth countdown before the photo is captured',
        }),
        // --- Export the photo to the Desktop with a known name ---
        step(6, 'click', 'Right-click the photo you just took (the newest thumbnail in the bottom strip).', {
          elementDescription: 'the most recent photo thumbnail in the bottom strip of Photo Booth',
          targetType: 'icon',
        }),
        step(7, 'click', 'Click "Export…" in the menu.', {
          targetLabel: 'Export',
          elementDescription: 'Export menu item in the right-click context menu',
          controlKind: 'menuItem',
        }),
        step(8, 'type', 'Type "waylo-photo" as the file name so I can find it later on WhatsApp.', {
          key: 'waylo-photo',
          elementDescription: 'file name field in the Export save dialog',
          screenRegion: 'dialog',
        }),
        step(9, 'click', 'Click the location dropdown (it currently shows Documents).', {
          targetLabel: 'Documents',
          elementDescription: 'the "Where" location popup button in the save dialog, currently set to Documents',
          controlKind: 'button',
          anchorText: 'Where',
          screenRegion: 'dialog',
        }),
        step(10, 'click', 'Choose "Desktop" from the dropdown so the photo saves to your Desktop.', {
          targetLabel: 'Desktop',
          elementDescription: 'Desktop item in the location dropdown menu',
          controlKind: 'menuItem',
          screenRegion: 'dialog',
        }),
        step(11, 'click', 'Click the "Save" button.', {
          targetLabel: 'Save',
          elementDescription: 'Save button in the export dialog',
          controlKind: 'button',
          anchorPosition: 'right',
          screenRegion: 'dialog',
        }),
        // --- Send it on WhatsApp ---
        step(12, 'click', 'Click the WhatsApp icon in the Dock to open it.', {
          targetLabel: 'WhatsApp',
          elementDescription: 'WhatsApp app icon in the Dock',
          targetType: 'icon',
          controlKind: 'button',
        }),
        step(13, 'info', "Open any chat you want to send the photo to — I'll continue in a moment.", {
          autoAdvanceSeconds: 2,
          elementDescription: 'pick a conversation in the WhatsApp chat list',
        }),
        step(14, 'click', 'Click the "+" attach button next to the message box.', {
          elementDescription: 'the plus / attach button at the bottom-left of the message input bar',
          targetType: 'icon',
          controlKind: 'button',
          screenRegion: 'statusBar',
        }),
        step(15, 'click', 'Click "Photos & Videos".', {
          targetLabel: 'Photos & Videos',
          elementDescription: 'Photos & Videos option in the attach menu',
          controlKind: 'menuItem',
        }),
        step(16, 'click', 'Click "Desktop" in the sidebar to open your Desktop.', {
          targetLabel: 'Desktop',
          elementDescription: 'Desktop shortcut in the file picker sidebar',
          controlKind: 'row',
          screenRegion: 'sidebar',
        }),
        step(17, 'click', 'Select the photo named "waylo-photo".', {
          targetLabel: 'waylo-photo',
          elementDescription: 'the file named waylo-photo that you just saved to the Desktop',
        }),
        step(18, 'click', 'Click the "Open" button.', {
          targetLabel: 'Open',
          elementDescription: 'Open button in the file picker',
          controlKind: 'button',
          anchorPosition: 'right',
          screenRegion: 'dialog',
        }),
        step(19, 'click', 'Click the Send button to send the photo.', {
          elementDescription: 'the send button (paper plane / arrow) next to the message box',
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
