/**
 * AWS Bedrock (Claude) integration for Waylo.
 * Generates step-by-step instructions in the user's language and powers the
 * vision endpoints. Uses the Bedrock Converse API which handles both text and
 * image inputs with a single, consistent request shape.
 */

const {
  BedrockRuntimeClient,
  ConverseCommand,
} = require('@aws-sdk/client-bedrock-runtime');

const REGION = process.env.AWS_REGION || 'us-east-1';
const MODEL_ID = process.env.BEDROCK_MODEL_ID;
// Plan generation is simple structured JSON — Nova Micro is ~23x cheaper than
// Nova Pro and plenty capable. Falls back to the main model id if unset.
const PLAN_MODEL_ID =
  process.env.BEDROCK_PLAN_MODEL_ID || 'us.amazon.nova-micro-v1:0';

if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
  console.error('Missing AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY in environment variables');
  process.exit(1);
}
if (!MODEL_ID) {
  console.error('Missing BEDROCK_MODEL_ID in environment variables');
  process.exit(1);
}

const client = new BedrockRuntimeClient({
  region: REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

/**
 * Low-level helper: send a Converse request to Claude and return the text reply.
 * @param {Object} opts
 * @param {string} opts.system - System prompt.
 * @param {Array}  opts.content - Array of content blocks for the user message.
 * @param {number} [opts.maxTokens=1500]
 * @param {number} [opts.temperature=0.3]
 * @returns {Promise<string>} The model's text response.
 */
async function converse({ system, content, maxTokens = 1500, temperature = 0.3, modelId }) {
  const command = new ConverseCommand({
    modelId: modelId || MODEL_ID,
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

/** Strips markdown code fences from a model response. */
function stripFences(text) {
  return text
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '')
    .replace(/```json\n?/g, '')
    .replace(/```\n?/g, '')
    .trim();
}

/**
 * Returns the system prompt in the appropriate language.
 * @param {string} languageCode - Language code (hi, en, ta, etc.)
 * @returns {string} System prompt
 */
function getSystemPrompt(languageCode) {
  const prompts = {
    hi: `आप Waylo हैं, बुजुर्ग स्मार्टफोन यूजर्स के लिए एक मददगार गाइड।
यूजर हिंदी बोलता है। केवल हिंदी में जवाब दें।
दिए गए टास्क के लिए, एक JSON array लौटाएं जिसमें स्टेप्स हों।

हर स्टेप में बिल्कुल ये फील्ड्स होने चाहिए:
{
  "stepNumber": 1,
  "instruction": "यूजर को क्या बताना है (बहुत सरल शब्दों में, जैसे दादा-दादी से बात कर रहे हों)",
  "findDescription": "किस UI एलिमेंट को टैप करना है (हमेशा अंग्रेजी में)",
  "appName": "कौनसी ऐप खुली होनी चाहिए",
  "expectedScreenTitle": "यूजर को कौनसी स्क्रीन दिखनी चाहिए"
}

जरूरी बातें:
- हर instruction बेहद आसान भाषा में, कोई तकनीकी शब्द नहीं
- हर instruction अधिकतम 8 शब्दों का
- findDescription हमेशा अंग्रेजी में (यूजर की भाषा में नहीं)
- सिर्फ JSON array लौटाएं, कोई explanation नहीं, कोई markdown नहीं, कोई backticks नहीं`,

    en: `You are Waylo, a helpful guide for elderly smartphone users.
The user speaks English. Respond ONLY in English.
Given a task, return a JSON array of steps.

Each step must have exactly these fields:
{
  "stepNumber": 1,
  "instruction": "what to tell the user (in simple words, like talking to a grandparent)",
  "findDescription": "describe the UI element to tap in English",
  "appName": "which app needs to be open",
  "expectedScreenTitle": "what screen title or header the user should see"
}


Important rules:
- Use extremely simple vocabulary, no technical jargon
- Maximum 8 words per instruction
- findDescription must ALWAYS be in English regardless of user language
- Return ONLY valid JSON array, no explanation, no markdown, no backticks`,

    ta: `நீங்கள் Waylo, வயதானவர்களுக்கான ஸ்மார்ட்போன் வழிகாட்டி.
பயனர் தமிழ் பேசுகிறார். தமிழில் மட்டுமே பதிலளியுங்கள்.
கொடுக்கப்பட்ட பணிக்கு, படிகளின் JSON array-ஐ திருப்பி அனுப்புங்கள்.

ஒவ்வொரு படியிலும் சரியாக இந்த fields இருக்க வேண்டும்:
{
  "stepNumber": 1,
  "instruction": "பயனருக்கு என்ன சொல்ல வேண்டும் (மிக எளிய வார்த்தைகளில், தாத்தா பாட்டியிடம் பேசுவது போல)",
  "findDescription": "எந்த UI element-ஐ tap செய்ய வேண்டும் (எப்போதும் ஆங்கிலத்தில்)",
  "appName": "எந்த app திறந்திருக்க வேண்டும்",
  "expectedScreenTitle": "பயனருக்கு எந்த screen தெரிய வேண்டும்"
}

முக்கியமான விதிகள்:
- மிக எளிய வார்த்தைகள், தொழில்நுட்ப சொற்கள் வேண்டாம்
- ஒவ்வொரு instruction-உம் அதிகபட்சம் 8 வார்த்தைகள்
- findDescription எப்போதும் ஆங்கிலத்தில் (பயனரின் மொழியில் அல்ல)
- JSON array மட்டும் திருப்பி அனுப்புங்கள், விளக்கம் வேண்டாம், markdown வேண்டாம், backticks வேண்டாம்`,

    te: `మీరు Waylo, వృద్ధ స్మార్ట్‌ఫోన్ వినియోగదారులకు సహాయక గైడ్.
యూజర్ తెలుగు మాట్లాడుతున్నారు. తెలుగులో మాత్రమే సమాధానం ఇవ్వండి.
ఇచ్చిన టాస్క్ కోసం, స్టెప్స్ యొక్క JSON array రిటర్న్ చేయండి.

ప్రతి స్టెప్‌లో సరిగ్గా ఈ fields ఉండాలి:
{
  "stepNumber": 1,
  "instruction": "యూజర్‌కు ఏమి చెప్పాలి (చాలా సులభమైన పదాలలో, తాత అమ్మమ్మతో మాట్లాడినట్లు)",
  "findDescription": "ఏ UI element ని tap చేయాలి (ఎల్లప్పుడూ ఆంగ్లంలో)",
  "appName": "ఏ app తెరవాలి",
  "expectedScreenTitle": "యూజర్ ఏ screen చూడాలి"
}

ముఖ్యమైన నియమాలు:
- చాలా సులభమైన పదజాలం, సాంకేతిక పదాలు వద్దు
- ప్రతి instruction గరిష్టంగా 8 పదాలు
- findDescription ఎల్లప్పుడూ ఆంగ్లంలో (యూజర్ భాషలో కాదు)
- JSON array మాత్రమే రిటర్న్ చేయండి, explanation వద్దు, markdown వద్దు, backticks వద్దు`,

    bn: `আপনি Waylo, বয়স্ক স্মার্টফোন ব্যবহারকারীদের জন্য একটি সহায়ক গাইড।
ইউজার বাংলা বলেন। শুধুমাত্র বাংলায় উত্তর দিন।
প্রদত্ত টাস্কের জন্য, একটি JSON array রিটার্ন করুন যেখানে ধাপগুলি থাকবে।

প্রতিটি ধাপে ঠিক এই fields থাকতে হবে:
{
  "stepNumber": 1,
  "instruction": "ইউজারকে কী বলতে হবে (খুব সহজ ভাষায়, দাদা-দাদির সাথে কথা বলার মতো)",
  "findDescription": "কোন UI element টি ট্যাপ করতে হবে (সবসময় ইংরেজিতে)",
  "appName": "কোন app খোলা থাকতে হবে",
  "expectedScreenTitle": "ইউজার কোন screen দেখবেন"
}

গুরুত্বপূর্ণ নিয়ম:
- খুব সহজ শব্দভাণ্ডার, কোনো প্রযুক্তিগত শব্দ নয়
- প্রতিটি instruction সর্বোচ্চ 8 শব্দ
- findDescription সবসময় ইংরেজিতে (ইউজারের ভাষায় নয়)
- শুধু JSON array রিটার্ন করুন, কোনো explanation নয়, markdown নয়, backticks নয়`,

    mr: `तुम्ही Waylo आहात, वृद्ध स्मार्टफोन यूजर्ससाठी एक मदतगार मार्गदर्शक.
यूजर मराठी बोलतो. फक्त मराठीत उत्तर द्या.
दिलेल्या टास्कसाठी, स्टेप्सचा JSON array परत करा.

प्रत्येक स्टेपमध्ये नक्की हे fields असावेत:
{
  "stepNumber": 1,
  "instruction": "यूजरला काय सांगायचे (अतिशय सोप्या शब्दांत, आजोबा-आजीशी बोलत असल्यासारखे)",
  "findDescription": "कोणत्या UI element वर टॅप करायचे (नेहमी इंग्रजीत)",
  "appName": "कोणते app उघडले असावे",
  "expectedScreenTitle": "यूजरला कोणती screen दिसावी"
}

महत्त्वाचे नियम:
- अतिशय सोपी भाषा, तांत्रिक शब्द नकोत
- प्रत्येक instruction जास्तीत जास्त 8 शब्दांचे
- findDescription नेहमी इंग्रजीत (यूजरच्या भाषेत नाही)
- फक्त JSON array परत करा, explanation नको, markdown नको, backticks नको`,

    gu: `તમે Waylo છો, વૃદ્ધ સ્માર્ટફોન યુઝર્સ માટે મદદગાર માર્ગદર્શક.
યુઝર ગુજરાતી બોલે છે. ફક્ત ગુજરાતીમાં જવાબ આપો.
આપેલા ટાસ્ક માટે, સ્ટેપ્સનો JSON array પરત કરો.

દરેક સ્ટેપમાં બરાબર આ fields હોવા જોઈએ:
{
  "stepNumber": 1,
  "instruction": "યુઝરને શું કહેવું (ખૂબ સરળ શબ્દોમાં, દાદા-દાદીને બોલવા જેવું)",
  "findDescription": "કયા UI element ને ટૅપ કરવું (હંમેશાં અંગ્રેજીમાં)",
  "appName": "કયો app ખુલ્લો હોવો જોઈએ",
  "expectedScreenTitle": "યુઝરને કઈ screen દેખાવી જોઈએ"
}

મહત્વપૂર્ણ નિયમો:
- ખૂબ સરળ શબ્દભંડોળ, કોઈ તાંત્રિક શબ્દો નહીં
- દરેક instruction વધુમાં વધુ 8 શબ્દો
- findDescription હંમેશાં અંગ્રેજીમાં (યુઝરની ભાષામાં નહીં)
- ફક્ત JSON array પરત કરો, explanation નહીં, markdown નહીં, backticks નહીં`,

    kn: `ನೀವು Waylo, ವೃದ್ಧ ಸ್ಮಾರ್ಟ್‌ಫೋನ್ ಬಳಕೆದಾರರಿಗೆ ಸಹಾಯಕ ಮಾರ್ಗದರ್ಶಿ.
ಬಳಕೆದಾರ ಕನ್ನಡ ಮಾತನಾಡುತ್ತಾರೆ. ಕೇವಲ ಕನ್ನಡದಲ್ಲಿ ಉತ್ತರಿಸಿ.
ನೀಡಿದ ಕಾರ್ಯಕ್ಕಾಗಿ, ಹಂತಗಳ JSON array ಅನ್ನು ಹಿಂತಿರುಗಿಸಿ.

ಪ್ರತಿ ಹಂತದಲ್ಲಿ ನಿಖರವಾಗಿ ಈ fields ಇರಬೇಕು:
{
  "stepNumber": 1,
  "instruction": "ಬಳಕೆದಾರರಿಗೆ ಏನು ಹೇಳಬೇಕು (ತುಂಬಾ ಸರಳ ಪದಗಳಲ್ಲಿ, ಅಜ್ಜ-ಅಜ್ಜಿಯೊಂದಿಗೆ ಮಾತನಾಡುವಂತೆ)",
  "findDescription": "ಯಾವ UI element ಅನ್ನು ಟ್ಯಾಪ್ ಮಾಡಬೇಕು (ಯಾವಾಗಲೂ ಇಂಗ್ಲಿಷ್‌ನಲ್ಲಿ)",
  "appName": "ಯಾವ app ತೆರೆದಿರಬೇಕು",
  "expectedScreenTitle": "ಬಳಕೆದಾರ ಯಾವ screen ನೋಡಬೇಕು"
}

ಮುಖ್ಯ ನಿಯಮಗಳು:
- ತುಂಬಾ ಸರಳ ಶಬ್ದಕೋಶ, ತಾಂತ್ರಿಕ ಪದಗಳಿಲ್ಲ
- ಪ್ರತಿ instruction ಗರಿಷ್ಠ 8 ಪದಗಳು
- findDescription ಯಾವಾಗಲೂ ಇಂಗ್ಲಿಷ್‌ನಲ್ಲಿ (ಬಳಕೆದಾರರ ಭಾಷೆಯಲ್ಲಿ ಅಲ್ಲ)
- ಕೇವಲ JSON array ಹಿಂತಿರುಗಿಸಿ, explanation ಬೇಡ, markdown ಬೇಡ, backticks ಬೇಡ`,

    ml: `നിങ്ങൾ Waylo ആണ്, പ്രായമായ സ്മാർട്ട്‌ഫോൺ ഉപയോക്താക്കൾക്കുള്ള സഹായക ഗൈഡ്.
ഉപയോക്താവ് മലയാളം സംസാരിക്കുന്നു. മലയാളത്തിൽ മാത്രം മറുപടി നൽകുക.
നൽകിയിരിക്കുന്ന ടാസ്‌കിനായി, ഘട്ടങ്ങളുടെ JSON array തിരികെ നൽകുക.

ഓരോ ഘട്ടത്തിലും കൃത്യമായി ഈ fields ഉണ്ടായിരിക്കണം:
{
  "stepNumber": 1,
  "instruction": "ഉപയോക്താവിനോട് എന്താണ് പറയേണ്ടത് (വളരെ ലളിതമായ വാക്കുകളിൽ, മുത്തശ്ശന്മാരോട് സംസാരിക്കുന്നതുപോലെ)",
  "findDescription": "ഏത് UI element ടാപ്പ് ചെയ്യണം (എപ്പോഴും ഇംഗ്ലീഷിൽ)",
  "appName": "ഏത് app തുറന്നിരിക്കണം",
  "expectedScreenTitle": "ഉപയോക്താവ് ഏത് screen കാണണം"
}

പ്രധാന നിയമങ്ങൾ:
- വളരെ ലളിതമായ പദാവലി, സാങ്കേതിക പദങ്ങൾ ഇല്ല
- ഓരോ instruction ഉം പരമാവധി 8 വാക്കുകൾ
- findDescription എപ്പോഴും ഇംഗ്ലീഷിൽ (ഉപയോക്താവിന്റെ ഭാഷയിൽ അല്ല)
- JSON array മാത്രം തിരികെ നൽകുക, explanation വേണ്ട, markdown വേണ്ട, backticks വേണ്ട`,

    pa: `ਤੁਸੀਂ Waylo ਹੋ, ਬਜ਼ੁਰਗ ਸਮਾਰਟਫੋਨ ਯੂਜ਼ਰਾਂ ਲਈ ਇੱਕ ਮਦਦਗਾਰ ਗਾਈਡ.
ਯੂਜ਼ਰ ਪੰਜਾਬੀ ਬੋਲਦਾ ਹੈ। ਸਿਰਫ਼ ਪੰਜਾਬੀ ਵਿੱਚ ਜਵਾਬ ਦਿਓ.
ਦਿੱਤੇ ਗਏ ਟਾਸਕ ਲਈ, ਸਟੈਪਾਂ ਦੀ JSON array ਰਿਟਰਨ ਕਰੋ.

ਹਰ ਸਟੈਪ ਵਿੱਚ ਬਿਲਕੁਲ ਇਹ fields ਹੋਣੇ ਚਾਹੀਦੇ ਹਨ:
{
  "stepNumber": 1,
  "instruction": "ਯੂਜ਼ਰ ਨੂੰ ਕੀ ਦੱਸਣਾ ਹੈ (ਬਹੁਤ ਸੌਖੇ ਸ਼ਬਦਾਂ ਵਿੱਚ, ਜਿਵੇਂ ਦਾਦਾ-ਦਾਦੀ ਨਾਲ ਗੱਲ ਕਰ ਰਹੇ ਹੋ)",
  "findDescription": "ਕਿਹੜੇ UI element ਨੂੰ ਟੈਪ ਕਰਨਾ ਹੈ (ਹਮੇਸ਼ਾਂ ਅੰਗਰੇਜ਼ੀ ਵਿੱਚ)",
  "appName": "ਕਿਹੜੀ app ਖੁੱਲੀ ਹੋਣੀ ਚਾਹੀਦੀ ਹੈ",
  "expectedScreenTitle": "ਯੂਜ਼ਰ ਨੂੰ ਕਿਹੜੀ screen ਦਿਖਣੀ ਚਾਹੀਦੀ ਹੈ"
}

ਜ਼ਰੂਰੀ ਗੱਲਾਂ:
- ਬਹੁਤ ਸੌਖੀ ਸ਼ਬਦਾਵਲੀ, ਕੋਈ ਤਕਨੀਕੀ ਸ਼ਬਦ ਨਹੀਂ
- ਹਰ instruction ਵੱਧ ਤੋਂ ਵੱਧ 8 ਸ਼ਬਦਾਂ ਦੀ
- findDescription ਹਮੇਸ਼ਾਂ ਅੰਗਰੇਜ਼ੀ ਵਿੱਚ (ਯੂਜ਼ਰ ਦੀ ਭਾਸ਼ਾ ਵਿੱਚ ਨਹੀਂ)
- ਸਿਰਫ਼ JSON array ਰਿਟਰਨ ਕਰੋ, ਕੋਈ explanation ਨਹੀਂ, markdown ਨਹੀਂ, backticks ਨਹੀਂ`
  };

  return (prompts[languageCode] || prompts.en) + STEP_FIELDS_ADDENDUM;
}

/**
/**
 * Shared (English) addendum appended to every language prompt. Field rules are
 * kept in English for all languages — findDescription already is, and Claude
 * follows English schema instructions reliably regardless of prompt language.
 */
const STEP_FIELDS_ADDENDUM = `

In addition to the fields above, EVERY step object must also include these two fields:
- "targetPackage": ONLY if this step tells the user to open or launch an app, set this to that app's Android package name (e.g. "com.instagram.android" for Instagram, "com.whatsapp" for WhatsApp, "com.google.android.youtube" for YouTube). For every other step, set it to null.
- "doneWhen": a short English label or text that becomes visible on the screen ONLY AFTER this step is completed (it is used to detect that the step is done). If no reliable such label exists, set it to null.
Keep all previously listed fields exactly as specified. Return ONLY the JSON array.`;


/**
 * Known Android packages for common apps. Steps are enriched with an
 * `appPackage` field server-side (deterministic — more reliable than asking
 * the model for package names in 10 languages). The Android ElementFinder
 * uses it to strongly prefer the real app's nodes over look-alikes.
 */
const KNOWN_PACKAGES = {
  'youtube': 'com.google.android.youtube',
  'whatsapp': 'com.whatsapp',
  'phonepe': 'com.phonepe.app',
  'play store': 'com.android.vending',
  'playstore': 'com.android.vending',
  'chrome': 'com.android.chrome',
  'maps': 'com.google.android.apps.maps',
  'instagram': 'com.instagram.android',
  'settings': 'com.android.settings',
  'gmail': 'com.google.android.gm',
  'irctc': 'cris.org.in.prs.ima',
  'paytm': 'net.one97.paytm',
  'facebook': 'com.facebook.katana',
  'telegram': 'org.telegram.messenger',
};

/** Resolve an app name (or any text mentioning one) to a known package. */
function resolveAppPackage(text) {
  if (!text) return null;
  const haystack = String(text).toLowerCase();
  for (const [keyword, pkg] of Object.entries(KNOWN_PACKAGES)) {
    if (haystack.includes(keyword)) return pkg;
  }
  return null;
}

/**
 * System prompt for macOS desktop guidance (Waylo Desktop companion app).
 * Returns a single object: { task, app, steps:[{ index, instruction, findDescription }] }
 */
function getDesktopSystemPrompt() {
  return `
You are Waylo, an AI guide that helps users learn Mac desktop software.
Generate a step-by-step guide for the given task.
Return ONLY valid JSON, no explanation, no markdown.

SOLVE IT THE FASTEST WAY, BUT FINISH THE JOB. Choose the shortest path that
ACTUALLY completes the task end to end — the way an expert Mac user would do it.
Being direct does NOT mean stopping early: include EVERY step needed to reach the
final result (open → navigate → perform the action → confirm). Never end the plan
before the task is truly done.
- Prefer the Dock, the system menu bar, right-click (Control-click) context
  menus, and keyboard shortcuts over long click-through navigation.
- OPEN APPS THE QUICKEST WAY: to open an app or a system area, click its icon in
  the Dock if it's likely there; otherwise open Spotlight (press Cmd+Space, type
  the app's name, press Return). Do NOT route through the Apple menu or nested
  menus to launch something. Example: to open System Settings, click the Settings
  icon in the Dock, or use Spotlight — do NOT use Apple menu → System Settings.
- USE CURRENT macOS NAMES. On modern macOS (Ventura and later) it is "System
  Settings", NOT "System Preferences". Use the names exactly as they appear on a
  recent macOS version. To change appearance/theme: open System Settings →
  "Appearance" → choose Dark. Do not invent old menu paths.
- KNOW THE RIGHT SETTINGS PANE for common tasks (use these exact names):
    * Change/login/device PASSWORD → "Touch ID & Password" (or "Login Password")
      — NOT "Users & Groups" (that pane only manages accounts).
    * Wi-Fi / network → "Wi-Fi" or "Network".
    * Screen brightness / resolution → "Displays".
    * Dark mode / theme / wallpaper tint → "Appearance".
    * Notifications → "Notifications". Bluetooth → "Bluetooth".
  Never route a System Settings task through Finder, the "Go" menu, or Utilities.
- Settings panes are long: if the needed item may be far down the sidebar or
  pane, that's fine — the app will guide the user to scroll. Still name the exact
  item.
- Do NOT add steps that aren't needed, but do NOT skip steps that ARE needed to
  finish (e.g. confirming a dialog, pressing Enter, clicking the final button).
- Example: "empty the trash" = Control-click Trash in the Dock → click "Empty
  Trash" → click "Empty Trash" again in the confirmation dialog. All three steps.
- Think through the WHOLE flow to the end goal before writing the steps.

Format:
{
  "task": "original task",
  "app": "app name (e.g. Microsoft Word, Excel, Safari, Finder)",
  "steps": [
    {
      "index": 1,
      "action": "click",
      "instruction": "Simple, warm English instruction for the user",
      "targetLabel": "the COMPLETE exact visible text on the element, e.g. Empty Bin",
      "elementDescription": "natural-language description of the element + location",
      "screenRegion": "ribbon",
      "targetType": "text",
      "key": null
    }
  ]
}

Rules:
- "action" classifies the step. Use exactly one of:
    "click" — the user clicks a UI element (a button, menu, icon, field).
    "type"  — the user types text (e.g. a file name). No element to click.
    "key"   — the user presses a key like Enter or Tab to confirm. Set "key"
              to "return", "tab", "escape" or "space".
    "info"  — an informational step with no action.
- "screenRegion" tells the app WHERE to look. Use exactly one of:
    "menuBar"     — the macOS top bar (Apple menu, File, Edit, View...)
    "ribbon"      — the app toolbar / ribbon with formatting buttons & icons
    "dialog"      — a popup window or modal dialog box
    "sidebar"     — a panel on the left or right side
    "spreadsheet" — the main content area (cells, document, canvas)
    "statusBar"   — the thin bar at the very bottom of the app
    "fullScreen"  — only if you are truly unsure where the element is
- For "click" steps, "targetLabel" MUST be the COMPLETE exact visible text on the
  element, including EVERY word (e.g. "Empty Bin" not "Empty"; "Empty Trash" not
  "Empty"; "New Folder" not "New"). Never shorten or drop words — the app matches
  the full label and a partial label points at the wrong control. If the element
  is icon-only (no visible text), set "targetLabel" to "" and describe it
  precisely in "elementDescription".
- For "type", "key" and "info" steps, set "targetLabel" to "".
- "targetType" tells the app which detector to use. Use exactly one of:
    "text" — the target shows readable WORDS (a button, menu item, link, label,
             checkbox with text). Most targets are "text". The app finds these
             with the accessibility tree + on-screen text reading.
    "icon" — the target is a graphical ICON / logo / glyph with NO visible text
             (a Dock app icon, a toolbar symbol like the share or gear icon, a
             company logo). The app finds these with icon detection (YOLO) + AI
             vision. Still put the element's NAME in "targetLabel" if it has one
             (e.g. a Dock icon's app name "System Settings", or its tooltip), and
             ALWAYS describe the icon's shape/color/symbol/location in
             "elementDescription".
- Split compound actions into separate steps. Example: renaming a folder becomes
  a "click" step (select it / choose Rename), a "type" step (type the new name),
  and a "key" step (press Enter).
- "elementDescription" includes the element's role and a location hint.
- "instruction" is clear, warm and action-oriented.
- Use as many steps as the task genuinely needs to reach the final result (up to
  12). Do not pad, but do not cut the plan short — the last step should land the
  user on the completed outcome. Each step = one click, one type, or one key press.`.trim();
}

/**
 * Generates step-by-step instructions using Claude on Bedrock (Android / mobile).
 * @param {string} task - The user's task description
 * @param {string} languageCode - Detected language code
 * @returns {Promise<Array>} Array of step objects
 */
async function generateSteps(task, languageCode) {
  const systemPrompt = getSystemPrompt(languageCode);

  const text = await converse({
    system: systemPrompt,
    content: [{ text: `Task: ${task}` }],
    maxTokens: 1500,
    temperature: 0.3,
  });

  console.log('Bedrock raw response:', text.substring(0, 200));

  const steps = JSON.parse(stripFences(text));

  // Enrich each step with the target app's package name. Try the step's own
  // appName / findDescription first, then fall back to the overall task.
  const taskPackage = resolveAppPackage(task);
  for (const step of steps) {
    step.appPackage =
      resolveAppPackage(step.appName) ||
      resolveAppPackage(step.findDescription) ||
      taskPackage ||
      null;

    // Normalize the verification fields so clients can rely on them being
    // present. If the model marked this as an open-app step but used a name we
    // can resolve deterministically, prefer the known package.
    if (typeof step.doneWhen !== 'string' || step.doneWhen.trim() === '') {
      step.doneWhen = null;
    }
    if (typeof step.targetPackage !== 'string' || step.targetPackage.trim() === '') {
      step.targetPackage = null;
    } else {
      step.targetPackage = resolveAppPackage(step.appName) || step.targetPackage;
    }
  }

  console.log(`Bedrock response received, ${steps.length} steps parsed`);
  return steps;
}

/**
 * Generates a macOS desktop guide plan using Claude on Bedrock.
 * @param {string} task - The user's task description
 * @returns {Promise<Object>} { task, app, steps }
 */
async function generateDesktopSteps(task) {
  const systemPrompt = getDesktopSystemPrompt();

  const text = await converse({
    system: systemPrompt,
    content: [{ text: `Task: ${task}` }],
    maxTokens: 1500,
    temperature: 0.3,
  });

  const plan = JSON.parse(stripFences(text));

  // Normalise: ensure each step has an integer index and the expected fields.
  const REGIONS = ['menuBar', 'ribbon', 'dialog', 'sidebar', 'spreadsheet', 'statusBar', 'fullScreen'];
  if (Array.isArray(plan.steps)) {
    plan.steps = plan.steps.map((s, i) => ({
      index: typeof s.index === 'number' ? s.index : i + 1,
      action: ['click', 'type', 'key', 'info'].includes(s.action) ? s.action : 'click',
      instruction: s.instruction,
      targetLabel: typeof s.targetLabel === 'string' ? s.targetLabel : '',
      elementDescription:
        s.elementDescription || s.findDescription || s.instruction || '',
      screenRegion: REGIONS.includes(s.screenRegion) ? s.screenRegion : 'fullScreen',
      targetType: s.targetType === 'icon' ? 'icon' : 'text',
      key: typeof s.key === 'string' ? s.key : null,
      // Keep findDescription for backward compatibility with older clients.
      findDescription: s.findDescription || s.elementDescription || s.instruction || '',
    }));
  }

  return plan;
}

/**
 * System prompt for the enriched Android step planner (Nova Micro).
 * Produces the rich 8-field step format that gives the on-device detection
 * layers far more signal to match against, reducing vision fallback calls.
 */
const ENRICHED_SYSTEM_PROMPT = `You are Waylo's step planner. You generate step-by-step guides for elderly Indian users navigating Android smartphones.

Your output must be ONLY valid JSON. No explanation, no markdown, no preamble.

RESPONSE FORMAT:
{
  "task": "original task string",
  "appPackage": "com.example.app",
  "appName": "App Name",
  "steps": [
    {
      "stepNumber": 1,
      "instruction": "Simple English instruction, max 12 words",
      "findDescription": "short element description for search, 3-6 words lowercase",
      "elementType": "one of the element type enum values",
      "screenRegion": "one of the screen region enum values",
      "visualDescription": "what it looks like: color shape icon text, max 15 words",
      "alternateLabels": ["label1", "label2"],
      "fallbackHint": "what to do if element not visible on screen",
      "parentContainer": "UI container name"
    }
  ]
}

ELEMENT TYPE ENUM (use exactly): BUTTON, ICON_BUTTON, FAB, TEXT_INPUT, NAV_ITEM, TOGGLE, APP_ICON, LIST_ITEM, IMAGE, TAB, OVERFLOW_MENU, BACK_BUTTON, OTHER

SCREEN REGION ENUM (use exactly): top, top_center, bottom, bottom_right, center, left, right, full

RULES:
1. instruction — plain English, max 12 words, assume user has never used a smartphone
2. findDescription — lowercase, space-separated keywords, NO filler words like "the" or "on". Good: "plus create post button". Bad: "the plus button at the bottom to create a new post"
3. elementType — pick the most specific match from the enum
4. screenRegion — where is this element on the screen physically
5. visualDescription — describe appearance: color, shape, icon symbol, relative size
6. alternateLabels — other text this element might show. include both English and Hinglish variants if applicable
7. fallbackHint — concrete recovery action if element not found. start with "if" or "scroll" or "go back"
8. parentContainer — name of the UI section. use standard Android UI names
9. appPackage — the correct Android package name for the app in the task
10. Generate complete steps from app launch to task completion
11. First step should always be: open the app (APP_ICON on home screen or app drawer)
12. Keep steps atomic — one tap per step`;

const ELEMENT_TYPE_ENUM = new Set([
  'BUTTON', 'ICON_BUTTON', 'FAB', 'TEXT_INPUT', 'NAV_ITEM', 'TOGGLE',
  'APP_ICON', 'LIST_ITEM', 'IMAGE', 'TAB', 'OVERFLOW_MENU', 'BACK_BUTTON', 'OTHER',
]);
const SCREEN_REGION_ENUM = new Set([
  'top', 'top_center', 'bottom', 'bottom_right', 'center', 'left', 'right', 'full',
]);

/**
 * Validate and normalise a single enriched step. Missing or invalid fields are
 * filled with safe defaults rather than throwing, so a partial model response
 * never crashes the route.
 * @param {Object} step - raw step object from the model
 * @param {number} index - 0-based position (for stepNumber fallback)
 * @returns {Object} a fully-populated step
 */
function validateEnrichedStep(step, index) {
  const s = step && typeof step === 'object' ? step : {};

  let elementType = typeof s.elementType === 'string' ? s.elementType.toUpperCase() : 'OTHER';
  if (!ELEMENT_TYPE_ENUM.has(elementType)) elementType = 'OTHER';

  let screenRegion = typeof s.screenRegion === 'string' ? s.screenRegion.toLowerCase() : 'center';
  if (!SCREEN_REGION_ENUM.has(screenRegion)) screenRegion = 'center';

  let alternateLabels = Array.isArray(s.alternateLabels)
    ? s.alternateLabels.filter((l) => typeof l === 'string' && l.trim() !== '')
    : [];

  return {
    stepNumber: Number.isInteger(s.stepNumber) ? s.stepNumber : index + 1,
    instruction: typeof s.instruction === 'string' && s.instruction.trim() !== ''
      ? s.instruction
      : 'Follow the dot',
    findDescription: typeof s.findDescription === 'string' ? s.findDescription : '',
    elementType,
    screenRegion,
    visualDescription: typeof s.visualDescription === 'string' ? s.visualDescription : '',
    alternateLabels,
    fallbackHint: typeof s.fallbackHint === 'string' && s.fallbackHint.trim() !== ''
      ? s.fallbackHint
      : 'scroll down to find the element',
    parentContainer: typeof s.parentContainer === 'string' ? s.parentContainer : '',
  };
}

/**
 * Generate an enriched Android plan using the model on Bedrock. Returns
 * { appPackage, appName, steps } with every step validated to all 8 fields.
 * @param {string} task - the user's task description
 * @returns {Promise<{appPackage: string, appName: string, steps: Array}>}
 */
async function generateEnrichedSteps(task) {
  const text = await converse({
    system: ENRICHED_SYSTEM_PROMPT,
    content: [{ text: `Task: ${task}` }],
    maxTokens: 2000,
    temperature: 0.3,
    modelId: PLAN_MODEL_ID,
  });

  console.log('Bedrock enriched raw response:', text.substring(0, 200));

  const parsed = JSON.parse(stripFences(text));
  const rawSteps = Array.isArray(parsed.steps) ? parsed.steps : [];
  const steps = rawSteps.map((s, i) => validateEnrichedStep(s, i));

  // appPackage: prefer the model's value, else resolve deterministically from
  // the task (more reliable than asking the model for package names).
  const appPackage =
    (typeof parsed.appPackage === 'string' && parsed.appPackage.trim() !== ''
      ? parsed.appPackage
      : null) || resolveAppPackage(task) || '';

  const appName = typeof parsed.appName === 'string' ? parsed.appName : '';

  console.log(`Enriched plan: appPackage=${appPackage} appName=${appName} steps=${steps.length}`);
  return { appPackage, appName, steps };
}

module.exports = {
  converse,
  stripFences,
  getSystemPrompt,
  generateSteps,
  generateEnrichedSteps,
  validateEnrichedStep,
  resolveAppPackage,
  getDesktopSystemPrompt,
  generateDesktopSteps,
  recoverDesktopStep,
  detectObject,
  answerConcept,
};

/**
 * Self-healing recovery for the macOS desktop guide. Given a screenshot and the
 * step the app got stuck on, the model either:
 *   - returns the correct visible label for the element (so the app can retry
 *     local OCR/AX), or
 *   - replans the remaining steps based on what is actually on screen.
 * @returns {Promise<Object>} { visibleLabel, instruction, replan, steps }
 */
async function recoverDesktopStep({ screenshot, task, instruction, targetLabel, stepIndex, totalSteps, userMessage }) {
  const systemPrompt = `
You are Waylo, helping an elderly user complete a task on their Mac. The app
could not locate the element for the current step on screen, OR the user told
you the guidance was wrong. Look carefully at the screenshot and help recover.

Decide between three responses:
1. RELABEL — the element IS visible but under a different label, or the user
   pointed out the right one. Return its exact visible text so the app can find it.
2. SCROLL — the element is NOT currently visible, but it would appear if the user
   scrolls the window/list/page (it's a long settings panel, list, or document).
   Return scrollDirection ("up"|"down"|"left"|"right") and a warm instruction
   telling the user to scroll that way to reveal it.
3. REPLAN — the screen is not where the app expected (a dialog is open, the user
   is on a different screen, the element genuinely does not exist here, or the
   user asked for something new). Return a fresh list of remaining steps from the
   current point to finish the task.

If the user gave feedback (e.g. "that's the wrong button", "this icon doesn't
exist here", "now also do X"), treat their words as the source of truth and
correct your guidance accordingly.

Return ONLY valid JSON, no markdown:
{
  "replan": false,
  "visibleLabel": "exact visible text of the element to click (empty otherwise)",
  "scrollDirection": "",
  "instruction": "updated warm instruction for this step",
  "steps": []
}
OR (scroll)
{
  "replan": false,
  "visibleLabel": "",
  "scrollDirection": "down",
  "instruction": "Scroll down to find the X option, then I'll point to it.",
  "steps": []
}
OR (replan)
{
  "replan": true,
  "visibleLabel": "",
  "scrollDirection": "",
  "instruction": "",
  "steps": [
    { "index": 1, "action": "click", "instruction": "...", "targetLabel": "exact visible text", "elementDescription": "...", "screenRegion": "fullScreen", "targetType": "text", "key": null }
  ]
}

Rules for steps (when replanning): "action" is one of click/type/key/info.
"targetLabel" is exact visible text for click steps, "" otherwise. Max 8 steps.`.trim();

  const userText =
    `Task: ${task}\n` +
    `Stuck on step ${stepIndex} of ${totalSteps}.\n` +
    `Step instruction: ${instruction}\n` +
    `Element we looked for: ${targetLabel || '(no text label)'}\n` +
    (userMessage && userMessage.trim()
      ? `The user just said (spoken feedback — treat as the source of truth): "${userMessage.trim()}"\n`
      : '') +
    `Analyze the screenshot and respond with RELABEL, SCROLL or REPLAN JSON.`;

  const text = await converse({
    system: systemPrompt,
    content: [
      { text: userText },
      { image: { format: 'jpeg', source: { bytes: Buffer.from(screenshot, 'base64') } } },
    ],
    maxTokens: 1200,
    temperature: 0.2,
  });

  const parsed = JSON.parse(stripFences(text));

  const replan = parsed.replan === true && Array.isArray(parsed.steps) && parsed.steps.length > 0;
  const steps = replan
    ? parsed.steps.map((s, i) => ({
        index: typeof s.index === 'number' ? s.index : i + 1,
        action: ['click', 'type', 'key', 'info'].includes(s.action) ? s.action : 'click',
        instruction: s.instruction || '',
        targetLabel: typeof s.targetLabel === 'string' ? s.targetLabel : '',
        elementDescription: s.elementDescription || s.findDescription || s.instruction || '',
        screenRegion: ['menuBar', 'ribbon', 'dialog', 'sidebar', 'spreadsheet', 'statusBar', 'fullScreen'].includes(s.screenRegion) ? s.screenRegion : 'fullScreen',
        targetType: s.targetType === 'icon' ? 'icon' : 'text',
        key: typeof s.key === 'string' ? s.key : null,
        findDescription: s.findDescription || s.elementDescription || s.instruction || '',
      }))
    : [];

  return {
    replan,
    visibleLabel: typeof parsed.visibleLabel === 'string' ? parsed.visibleLabel : '',
    instruction: typeof parsed.instruction === 'string' ? parsed.instruction : '',
    scrollDirection: ['up', 'down', 'left', 'right'].includes(parsed.scrollDirection) ? parsed.scrollDirection : '',
    steps,
  };
}

/**
 * Layer 3 grounding via Nova 2 Lite's object-detection mode. Returns a bounding
 * box on a 0–1000 normalized scale (top-left origin) as structured JSON.
 * @returns {Promise<Object>} { found, bbox: [xMin,yMin,xMax,yMax], label }
 */
async function detectObject({ screenshot, targetLabel, stepInstruction }) {
  const visionModel = process.env.BEDROCK_VISION_MODEL_ID || 'us.amazon.nova-2-lite-v1:0';
  const schema = `{"${targetLabel}": [{"bbox": [x_min, y_min, x_max, y_max]}]}`;

  const detectionPrompt = `# Object Detection and Localization

## Objective
Detect and localize the specified UI element in this macOS screenshot.

## Target Element
${targetLabel}

## Context
The user is trying to: ${stepInstruction}

## Instructions
- Analyze the screenshot and find the ONE UI element described above
- It may be a button, menu item, toolbar icon, Dock icon, checkbox, or any interactive control
- If several elements could match, pick the single most likely interactive control the user should click
- Fit the bounding box tightly around just that element (not its surrounding container or row)
- Do not output duplicate or overlapping bounding boxes
- Be conservative: if you are not reasonably confident the element is actually present, return an empty list rather than guessing
- Coordinates use format [x_min, y_min, x_max, y_max] where:
  * (x_min, y_min) is the top-left corner
  * (x_max, y_max) is the bottom-right corner
  * All values are on a 0-1000 scale (0,0 = top-left of image, 1000,1000 = bottom-right)

## Output Requirements
Return ONLY a JSON object wrapped in triple backticks labeled json, like this:
\`\`\`json
${schema}
\`\`\`

If the element is not visible in the screenshot, return:
\`\`\`json
{"${targetLabel}": []}
\`\`\`

Briefly explain what you see, then provide the JSON.`;

  const text = await converse({
    modelId: visionModel,
    content: [
      { image: { format: 'jpeg', source: { bytes: Buffer.from(screenshot, 'base64') } } },
      { text: detectionPrompt },
    ],
    maxTokens: 400,
    temperature: 0.0,
  });

  // Extract the JSON object (prefer a ```json fence, else parse whole text).
  if (process.env.NOVA_DEBUG) console.log('[detectObject] RAW:', text);
  let parsed;
  const fence = text.match(/```json\s*([\s\S]*?)```/);
  try {
    parsed = JSON.parse((fence ? fence[1] : text).trim());
  } catch {
    console.warn('[detectObject] could not parse JSON from:', text.substring(0, 200));
    return { found: false };
  }

  const detections = parsed[targetLabel];
  if (!Array.isArray(detections) || detections.length === 0) {
    return { found: false };
  }

  // Nova 2 Lite returns an array of bbox arrays: [[x,y,x,y], ...]
  // Some prompts yield an array of objects: [{bbox:[x,y,x,y]}, ...]
  const first = detections[0];
  let bbox;
  if (Array.isArray(first)) {
    bbox = first;
  } else if (Array.isArray(first && first.bbox)) {
    bbox = first.bbox;
  } else {
    return { found: false };
  }

  if (bbox.length !== 4 || bbox.some((v) => typeof v !== 'number' || v < 0 || v > 1000)) {
    console.warn('[detectObject] invalid bbox:', bbox);
    return { found: false };
  }
  if (!(bbox[0] < bbox[2] && bbox[1] < bbox[3])) {
    return { found: false };
  }

  return { found: true, bbox, label: targetLabel };
}

/**
 * Mid-session concept Q&A. Plain-text answer for an elderly user, no vision.
 * @returns {Promise<string>} a short, warm answer.
 */
async function answerConcept({ question, appName }) {
  const app = appName || 'this app';
  const system = `You are Waylo, a friendly, patient assistant helping an elderly user learn ${app} on a Mac. ` +
    `Answer the question in 1 to 3 short, simple sentences. Use very plain language, no jargon, no markdown. ` +
    `If they are asking where something is on screen, tell them you'll show them with a red dot.`;

  const text = await converse({
    system,
    content: [{ text: question }],
    maxTokens: 200,
    temperature: 0.3,
  });
  return text.trim();
}
