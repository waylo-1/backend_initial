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
    aliases: ['docs', 'google doc'],
    description: 'Write, format and share documents.',
    lessons: [
      { title: 'Start a document', task: 'open a new Google Docs document in Chrome' },
      { title: 'Add a heading', task: 'type a title and make it a Heading 1 style in Google Docs' },
      { title: 'Make text bold', task: 'select some text and make it bold in Google Docs' },
      { title: 'Insert a chart', task: 'insert a bar chart into the document in Google Docs' },
      { title: 'Share the document', task: 'share the Google Docs document with someone by email' },
    ],
  },
  {
    id: 'ai-studio',
    displayName: 'Google AI Studio',
    aliases: ['aistudio', 'gemini api', 'api key', 'google ai studio'],
    description: 'Get your own free Gemini API key.',
    lessons: [
      { title: 'Open AI Studio', task: 'go to aistudio.google.com in Chrome' },
      { title: 'Find the API keys page', task: 'open the Get API key page in Google AI Studio' },
      { title: 'Create your key', task: 'create a new API key in Google AI Studio' },
      { title: 'Copy it somewhere safe', task: 'copy the API key and paste it into a new note in the Notes app' },
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
