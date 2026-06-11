/**
 * Gemini API integration for Waylo
 * Generates step-by-step instructions in user's language
 */

const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

if (!process.env.GEMINI_API_KEY) {
  console.error('Missing GEMINI_API_KEY in environment variables');
  process.exit(1);
}

/**
 * Returns system prompt in the appropriate language
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
 * Shared (English) addendum appended to every language prompt. Field rules are
 * kept in English for all languages — findDescription already is, and Gemini
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
 * Generates step-by-step instructions using Gemini AI
 * @param {string} task - The user's task description
 * @param {string} languageCode - Detected language code
 * @returns {Promise<Array>} Array of step objects
 */
async function generateSteps(task, languageCode) {
  const systemPrompt = getSystemPrompt(languageCode);

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`;

  const body = {
    contents: [
      {
        parts: [{ text: systemPrompt + "\n\nTask: " + task }]
      }
    ],
    generationConfig: {
      temperature: 0.3,
      maxOutputTokens: 1500
    }
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error?.message || 'Gemini API failed');
  }

  const text = data.candidates[0].content.parts[0].text;
  console.log("Gemini raw response:", text.substring(0, 200));

  const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  const steps = JSON.parse(cleaned);

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
    // present. If Gemini marked this as an open-app step but used a name we
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

  console.log(`Gemini response received, ${steps.length} steps parsed`);

  return steps;
}

module.exports = { getSystemPrompt, generateSteps, resolveAppPackage };
