/**
 * Hardcoded demo plans for the macOS app.
 *
 * These bypass the Nova planner AND the semantic cache entirely so a demo/video
 * is 100% deterministic — no hallucinated buttons, no cold-start latency. If the
 * spoken/typed task matches a demo, that exact plan is returned immediately.
 *
 * Matching: a demo matches if EITHER any `triggers` substring is present, OR
 * every group in `all` has at least one matching keyword (AND-of-ORs). Keep
 * triggers specific; first match in DEMOS wins.
 *
 * To edit a demo: change its steps below. Steps use the same shape as the live
 * macOS planner. The user refines anything else live with Ctrl+Opt+Cmd+V.
 */

const FILE_LABEL = 'photo'; // name the exported photo gets; reused on WhatsApp.

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
    silent: opts.silent || false,
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
  // -------------------------------------------------------------------------
  // DEMO: Dark Mode
  // -------------------------------------------------------------------------
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

  // -------------------------------------------------------------------------
  // DEMO: Change password
  // -------------------------------------------------------------------------
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

  // -------------------------------------------------------------------------
  // DEMO (Task 1): Take a photo in Photo Booth and save it to the Desktop
  // -------------------------------------------------------------------------
  {
    triggers: ['photo booth', 'photobooth', 'take a photo', 'take a picture', 'take a selfie',
               'save photo', 'save the photo', 'save to desktop', 'photo to desktop'],
    // Natural phrasing: (a photo word) AND (a save/desktop word).
    all: [
      ['photo', 'picture', 'pic', 'selfie', 'image', 'snap', 'camera'],
      ['save', 'desktop', 'export'],
    ],
    plan: {
      task: 'Take a photo and save it to the Desktop',
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
        step(4, 'click', 'Click the "Take Photo" button (the round camera shutter button) to take a photo.', {
          targetLabel: 'Take Photo',
          elementDescription: 'the Take Photo button — the round red/silver camera shutter button at the center-bottom of the Photo Booth window',
          controlKind: 'button',
        }),
        step(5, 'info', 'Hold still — Photo Booth is taking the photo…', {
          autoAdvanceSeconds: 4,
          silent: true,
          elementDescription: 'Photo Booth countdown before the photo is captured',
        }),
        step(6, 'click', 'Right-click the photo you just took (the newest, rightmost thumbnail in the bottom strip).', {
          targetLabel: 'newest photo',
          elementDescription: 'the most recent photo — the rightmost thumbnail in the row of captured photos at the bottom of the Photo Booth window',
        }),
        step(7, 'click', 'Click "Export…" in the menu.', {
          targetLabel: 'Export',
          elementDescription: 'Export menu item in the right-click context menu',
          controlKind: 'menuItem',
        }),
        step(8, 'type', 'Type "photo" as the file name.', {
          key: FILE_LABEL,
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
      ],
    },
  },

  // -------------------------------------------------------------------------
  // DEMO (Task 2): Send the saved photo on WhatsApp
  // -------------------------------------------------------------------------
  {
    triggers: ['send to whatsapp', 'send it to whatsapp', 'send the photo to whatsapp',
               'send photo to whatsapp', 'photo to whatsapp', 'picture to whatsapp',
               'share on whatsapp', 'whatsapp it'],
    // Natural phrasing: (a whatsapp word) AND (a send/share/photo word).
    all: [
      ['whatsapp', 'whats app', 'whatsap'],
      ['send', 'share', 'photo', 'picture', 'pic', 'upload', 'attach'],
    ],
    plan: {
      task: 'Send the photo on WhatsApp',
      app: 'WhatsApp',
      steps: [
        step(1, 'click', 'Click the WhatsApp icon in the Dock to open it.', {
          targetLabel: 'WhatsApp',
          elementDescription: 'WhatsApp app icon in the Dock',
          targetType: 'icon',
          controlKind: 'button',
        }),
        step(2, 'info', "Open any chat you want to send the photo to — I'll continue in a moment.", {
          autoAdvanceSeconds: 3,
          elementDescription: 'pick a conversation in the WhatsApp chat list',
        }),
        step(3, 'click', 'Click the "+" attach button (Add Media) next to the message box.', {
          targetLabel: 'Add Media',
          elementDescription: 'the Add Media button — the + / attach icon at the left end of the message compose bar near the bottom of the chat, just left of the text input field (NOT at the far-left edge of the screen)',
          controlKind: 'button',
          anchorText: 'Type a message',
          anchorPosition: 'left',
        }),
        step(4, 'click', 'Click "Photos & Videos".', {
          targetLabel: 'Photos & Videos',
          elementDescription: 'Photos & Videos option in the attach menu',
          controlKind: 'menuItem',
        }),
        step(5, 'click', 'Click "Desktop" in the sidebar to open your Desktop.', {
          targetLabel: 'Desktop',
          elementDescription: 'Desktop shortcut in the file picker sidebar',
          controlKind: 'row',
          screenRegion: 'sidebar',
        }),
        step(6, 'click', 'Select the photo named "photo" inside the file picker.', {
          targetLabel: FILE_LABEL,
          elementDescription: 'the file named photo shown inside the WhatsApp file picker window (not the Desktop behind it)',
          screenRegion: 'dialog',
        }),
        step(7, 'click', 'Click the "Open" button.', {
          targetLabel: 'Open',
          elementDescription: 'Open button in the file picker',
          controlKind: 'button',
          anchorPosition: 'right',
          screenRegion: 'dialog',
        }),
        step(8, 'click', 'Click the send button (the green arrow at the right of the message box) to send the photo.', {
          targetLabel: 'Send',
          elementDescription: 'the Send button — an arrow inside a green circle at the right end of the message compose bar (about three-quarters of the way down the window), to the right of the text input',
          controlKind: 'button',
          anchorText: 'Add a caption',
          anchorPosition: 'right',
        }),
      ],
    },
  },

  // -------------------------------------------------------------------------
  // DEMO: Deploy a Next.js frontend on Vercel
  // -------------------------------------------------------------------------
  {
    triggers: ['vercel', 'deploy on vercel', 'deploy to vercel'],
    // Natural phrasing: (a deploy word) AND (a frontend/next word).
    all: [
      ['deploy', 'publish', 'host', 'launch'],
      ['vercel', 'next.js', 'nextjs', 'next js', 'frontend', 'website', 'site'],
    ],
    plan: {
      task: 'Deploying Next.js frontend on Vercel',
      app: 'Google Chrome',
      steps: [
        step(1, 'click', 'Open Google Chrome from the Dock.', {
          targetLabel: 'Google Chrome',
          elementDescription: 'Google Chrome app icon in the Dock',
          targetType: 'icon',
          controlKind: 'button',
        }),
        step(2, 'click', 'Click the search bar.', {
          targetLabel: 'Ask Google',
          elementDescription: "the Google search bar in the center of the page, where the placeholder text 'Ask Google' is shown",
          controlKind: 'field',
        }),
        step(3, 'type', "Type 'vercel'.", {
          key: 'vercel',
          elementDescription: 'the focused Google search bar',
        }),
        step(4, 'key', 'Press Return.', {
          key: 'return',
          elementDescription: 'submit the Google search',
        }),
        step(5, 'click', 'Click the Vercel link.', {
          targetLabel: 'Vercel',
          elementDescription: "the large PURPLE 'Vercel' result-title link — the clickable heading BELOW the white triangle logo and the https://vercel.com URL. NOT the small grey 'Vercel' site name next to the logo, and NOT the word in the search box.",
          controlKind: 'link',
          anchorText: 'vercel.com',
          anchorPosition: 'below',
        }),
        step(6, 'click', "Click 'Add New'.", {
          targetLabel: 'Add New',
          elementDescription: 'the white "Add New…" button on the Vercel dashboard (top-right area)',
          controlKind: 'button',
        }),
        step(7, 'click', "Click 'Project'.", {
          targetLabel: 'Project',
          elementDescription: 'the Project item in the Add New dropdown menu',
          controlKind: 'menuItem',
        }),
        step(8, 'click', 'Click the Git repository field.', {
          targetLabel: 'Enter a Git repository',
          elementDescription: "the text input field with the placeholder 'Enter a Git repository' (for importing a repo by URL)",
          controlKind: 'field',
        }),
        step(9, 'key', 'Paste the URL — press Command and V.', {
          key: 'v',
          elementDescription: 'paste the copied Git repository URL into the field',
        }),
        step(10, 'key', 'Press Return.', {
          key: 'return',
          elementDescription: 'confirm the pasted repository URL',
        }),
        step(11, 'info', 'One moment…', {
          autoAdvanceSeconds: 4,
          silent: true,
          elementDescription: 'Vercel is fetching the repository and preparing the configure screen',
        }),
        step(12, 'click', "Click 'Deploy'.", {
          targetLabel: 'Deploy',
          elementDescription: 'the large white Deploy button on the Vercel configure-project screen',
          controlKind: 'button',
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
    const hitTrigger = (demo.triggers || []).some((t) => n.includes(t));
    const hitAll = Array.isArray(demo.all)
      && demo.all.length > 0
      && demo.all.every((group) => group.some((k) => n.includes(k)));
    if (hitTrigger || hitAll) {
      return JSON.parse(JSON.stringify(demo.plan));
    }
  }
  return null;
}

module.exports = { getDemoPlan };
