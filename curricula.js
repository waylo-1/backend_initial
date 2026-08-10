/**
 * Hand-authored learning curricula for the apps people most want to learn.
 *
 * A curriculum is an ordered list of LESSONS; each lesson is a task phrased
 * exactly how the planner likes it. The lesson lists are authored here (no
 * model call to create them); each lesson's step-by-step plan still goes
 * through /plan — which the semantic cache then shares fleet-wide, so a
 * lesson is planned once ever and free for every later learner. Authoring
 * full step JSON here instead was rejected on purpose: hardcoded steps rot
 * whenever an app updates its UI; lesson INTENTS don't.
 *
 * Served by GET /curriculum and /curriculum/:id. Stored as code (reviewed,
 * versioned); trivial to move into the guides table later if needed.
 */

const CURRICULA = [
  {
    id: 'google-sheets',
    displayName: 'Google Sheets',
    aliases: ['sheets', 'google sheet', 'spreadsheet'],
    description: 'From a blank sheet to charts and sharing.',
    lessons: [
      { title: 'Open a new spreadsheet', task: 'open a new Google Sheets spreadsheet in Chrome' },
      { title: 'Type in data', task: 'type a small table of data with a header row in Google Sheets' },
      { title: 'Add up a column', task: 'use the SUM formula to total a column in Google Sheets' },
      { title: 'Make a chart', task: 'select the data and insert a chart in Google Sheets' },
      { title: 'Freeze the header', task: 'freeze the top row in Google Sheets' },
      { title: 'Share your sheet', task: 'share the Google Sheets spreadsheet with someone by email' },
    ],
  },
  {
    id: 'gmail',
    displayName: 'Gmail',
    aliases: ['mail', 'email', 'google mail'],
    description: 'Send, attach, reply and stay organised.',
    lessons: [
      { title: 'Send an email', task: 'compose and send a new email in Gmail in Chrome' },
      { title: 'Attach a file', task: 'compose an email in Gmail and attach a file to it' },
      { title: 'Reply to an email', task: 'open the latest email in Gmail and reply to it' },
      { title: 'Star an important email', task: 'star an email in Gmail so it is easy to find later' },
      { title: 'Make a label', task: 'create a new label in Gmail and apply it to an email' },
    ],
  },
  {
    id: 'google-docs',
    displayName: 'Google Docs',
    aliases: ['docs', 'google doc', 'resume', 'write a resume', 'cv'],
    description: 'Write your first resume — and learn Docs by asking as you go.',
    lessons: [
      // Flagship: build a resume, learning each skill in context. Ask follow-ups
      // ("now make my name bigger", "add a bullet") — the session remembers.
      { title: 'Start your resume', task: 'open a new Google Docs document in Chrome for a resume' },
      { title: 'Add your name as a title', task: 'type your name at the top and make it a Title style in Google Docs' },
      { title: 'Add a section heading', task: 'type a section heading like Experience and make it Heading 1 in Google Docs' },
      { title: 'Make text bold', task: 'select some text and make it bold in Google Docs' },
      { title: 'Add a bulleted list', task: 'make a bulleted list in Google Docs' },
      { title: 'Change the font size', task: 'change the font size of the selected text in Google Docs' },
      { title: 'Insert a link', task: 'insert a link into the Google Docs document' },
      { title: 'Download as PDF', task: 'download the Google Docs document as a PDF' },
      { title: 'Share the document', task: 'share the Google Docs document with someone by email' },
    ],
  },
  {
    id: 'ai-studio',
    displayName: 'Google AI Studio',
    aliases: ['aistudio', 'gemini api', 'api key', 'google ai studio'],
    description: 'Get your own free Gemini API key — your first step as an AI builder.',
    lessons: [
      // Flagship end-to-end lesson (the demo flow) — one intent, whole journey.
      { title: 'Get your first Gemini API key', task: 'get a Gemini API key in Google AI Studio' },
      { title: 'Open AI Studio', task: 'go to aistudio.google.com in Chrome' },
      { title: 'Find the API keys page', task: 'open the Get API key page in Google AI Studio' },
      { title: 'Create your key', task: 'create a new API key in Google AI Studio' },
      { title: 'Save it safely', task: 'copy the API key and paste it into a new note in the Notes app' },
      { title: 'Try your first prompt', task: 'open a new prompt in Google AI Studio and run it' },
    ],
  },
  {
    id: 'mac-settings',
    displayName: 'Mac System Settings',
    aliases: ['settings', 'system settings', 'mac settings', 'system preferences', 'set up my mac'],
    description: 'Personalise your Mac so it works the way you need — bigger text, Wi-Fi, dark mode.',
    lessons: [
      { title: 'Make the text bigger', task: 'make the text on my Mac bigger in System Settings' },
      { title: 'Connect to Wi-Fi', task: 'connect to a Wi-Fi network in System Settings' },
      { title: 'Turn on Dark Mode', task: 'turn on Dark Mode in System Settings' },
      { title: 'Turn on Bluetooth', task: 'turn on Bluetooth in System Settings' },
      { title: 'Change your wallpaper', task: 'change the desktop wallpaper in System Settings' },
    ],
  },
  {
    id: 'pages',
    displayName: 'Pages',
    aliases: ['apple pages'],
    description: "Apple's writing app, from blank page to PDF.",
    lessons: [
      { title: 'Start a document', task: 'open a new document in Pages' },
      { title: 'Make a heading', task: 'type a title and make it bigger and bold in Pages' },
      { title: 'Change text colour', task: 'change the selected text colour in Pages using the Format panel' },
      { title: 'Insert a chart', task: 'insert a 2D bar chart in Pages' },
      { title: 'Save as PDF', task: 'export the Pages document as a PDF to the Desktop' },
    ],
  },
  {
    id: 'excel',
    displayName: 'Microsoft Excel',
    aliases: ['microsoft excel', 'ms excel'],
    description: 'The essentials: formulas, charts, formatting.',
    lessons: [
      { title: 'Enter data', task: 'type a small table of data with a header row in Excel' },
      { title: 'Add up a column', task: 'use the SUM formula to total a column in Excel' },
      { title: 'Make a chart', task: 'select the data and insert a chart in Excel' },
      { title: 'Freeze the header', task: 'freeze the top row in Excel' },
    ],
  },
  {
    id: 'whatsapp',
    displayName: 'WhatsApp',
    aliases: ['whats app'],
    description: 'Messages, photos and groups.',
    lessons: [
      { title: 'Send a message', task: 'send a message to a contact on WhatsApp' },
      { title: 'Send a photo', task: 'send a photo to a contact on WhatsApp' },
      { title: 'Search your chats', task: 'search for a chat by name in WhatsApp' },
    ],
  },
  {
    id: 'mac-basics',
    displayName: 'Mac Basics',
    aliases: ['mac', 'macos', 'finder', 'basics'],
    description: 'Folders, screenshots, the Bin — daily essentials.',
    lessons: [
      { title: 'Make a folder', task: 'create a new folder on the Desktop and name it' },
      { title: 'Move a file', task: 'move a file from the Desktop into the new folder' },
      { title: 'Take a screenshot', task: 'take a screenshot of part of the screen' },
      { title: 'Delete and empty', task: 'move a file to the Bin and then empty the Bin' },
      { title: 'Switch dark mode', task: 'turn on dark mode in System Settings' },
    ],
  },
];

/** Case-insensitive lookup by id, display name, or alias substring. */
function findCurriculum(query) {
  const q = String(query || '').toLowerCase().trim();
  if (!q) return null;
  return CURRICULA.find((c) =>
    c.id === q
    || c.displayName.toLowerCase() === q
    || c.aliases.some((a) => a === q)
    || c.displayName.toLowerCase().includes(q)
    || c.aliases.some((a) => q.includes(a) || a.includes(q))
  ) || null;
}

module.exports = { CURRICULA, findCurriculum };
