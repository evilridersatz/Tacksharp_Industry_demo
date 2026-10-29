/**
 * What the website assistant may say about Tacksharp. Taken from the public website pages (/welcome, /product,
 * /solutions, /pricing, /docs, /terms, /privacy) - nothing else. Anything not here is answered with "I'll connect you
 * with the team" instead of a guess. Keep this in step with the website copy.
 */
export const KNOWLEDGE = `
COMPANY
- Tacksharp AI Private Limited, Chennai. Address: 53 B, SPE Monocity, Parivakkam, Poonamallee, Chennai 600056.
- Product: Tacksharp.ai, "AI employees" for WhatsApp, phone calls and back-office follow-ups, for businesses whose
  customers speak Tamil, English or Tanglish.

WHAT IT DOES
- WhatsApp assistant on the business's own WhatsApp Business number: answers in Tamil, English or mixed; voice notes
  are transcribed; prices, stock and slots come from the business's records, never invented.
- Voice calls through the business's own Plivo number with Sarvam voices: calls leads back, confirms visits, tells
  customers an order is ready. Respects calling hours and opt-outs.
- Back-office agents (sales, operations, marketing, finance): draft quotations, reserve stock, prepare campaigns and
  payment reminders. Anything that commits money or reaches many customers waits for a person's approval.
- A dashboard per industry; same login and data rules, different work.
- Team & access: invite people by link with admin, manager, operator or read-only roles; remove access instantly;
  roles are checked by the server on every request.
- Each organization sees only its own data.
- Customers connect their OWN WhatsApp, Plivo, Sarvam and OpenAI accounts; keys are encrypted at rest, masked on
  screen and tested before use. Usage and errors are shown per provider.
- Approvals and audit: discounts, campaigns, invoices and stock corrections go through an approval queue; sign-ins,
  changes and approvals are recorded.
- Safe by default: new organizations run in a recording-only mode until numbers, templates and test recipients are
  set up. A WhatsApp message counts as delivered only when WhatsApp confirms it.

INDUSTRIES
- Real estate: leads and enquiries (budget, location, BHK from chat), property inventory, AI follow-up messages and
  calls, site visits with reminders, pipeline analytics, campaign performance.
- Restaurants and food: WhatsApp and phone ordering with server-calculated prices, menu and stock, outlets and pickup
  times, order follow-ups and "ready" calls, revenue analytics.
- Retail and textile: catalogue answers, quotations and sales orders, WhatsApp campaigns with approval, follow-ups,
  inventory with low-stock alerts.
- Manufacturing: quality inspections, inventory and stock movements, work tasks, exceptions and corrective actions.
  A production-line overview from machine data is in development.
- Healthcare (hospitals, clinics): appointment requests and confirmations, patient enquiries (no medical advice),
  reminders, reporting, restricted reception and insurance roles.
- Hotel: reservations, rooms and guest messages.
- Vision AI / CCTV (VisionOps): camera and recorder inventory per site, connectivity from on-site agents, incidents,
  technician notifications and escalation. Object detection is shown only when a working camera or inference service
  supplies it.

PRICING
- Plans: Pilot (one team, one channel), Growth (daily use: voice calls, back-office agents, campaigns), Enterprise
  (groups and multi-site operators). Prices are quoted when the organization is activated; no list price is
  published. WhatsApp, Plivo, Sarvam and OpenAI bill the customer directly for usage; no markup.

GETTING STARTED
1. Create the organization at /signup (organization name, your name, business email, password of 12+ characters,
   industry). You become the admin; the dashboard opens at once.
2. Tacksharp reviews and activates the organization (email verification is not set up yet).
3. Connect WhatsApp in Settings > Integrations > WhatsApp; test, enable, route the number.
4. Optional: Plivo calls, Sarvam voices, OpenAI in Settings > Integrations / AI providers.
5. Invite the team in Team & access.
6. Add customers with consent and go live after testing with your own numbers.
- Demos: /demo lists the industry demo workspaces (sample data, never messages real people); opening one needs a login
  with demo access.
- Password help: /forgot-password; an admin issues a one-time reset link.

POLICIES
- Message or call only people who agreed to hear from you; opt-outs (STOP) are honoured.
- Customers own their data; Tacksharp processes it only to provide the service. Privacy policy at /privacy, terms at
  /terms.
`;

export type Style = 'ta' | 'en' | 'tanglish';

/** Offline answers when the language model is unavailable: keyword match, one answer per style. */
export const FAQ: Array<{ keys: RegExp; answer: Record<Style, string> }> = [
  {
    keys: /price|pricing|cost|plan|vilai|evlo|எவ்வளவு|விலை|கட்டணம்/i,
    answer: {
      en: 'We have three plans: Pilot, Growth and Enterprise. Prices are quoted when we activate your organization, and WhatsApp, Plivo, Sarvam and OpenAI bill you directly for usage, with no markup. 💡',
      ta: 'Pilot, Growth, Enterprise என்று மூன்று plans இருக்கு. உங்க organization activate ஆகும்போது விலை சொல்லுவோம். WhatsApp, Plivo, Sarvam, OpenAI usage-க்கு அவங்களே நேரடியா bill பண்ணுவாங்க. 💡',
      tanglish: 'Pilot, Growth, Enterprise nu moonu plans irukku. Unga organization activate aagumbodhu price solluvom. WhatsApp, Plivo, Sarvam, OpenAI usage-ku avangale directa bill pannuvanga. 💡',
    },
  },
  {
    keys: /sign ?up|register|start|account|join|begin|ஆரம்பி|தொடங்க|பதிவு/i,
    answer: {
      en: 'Getting started takes a few minutes 🙂 Go to Create an account, enter your organization, your name, business email, a 12+ character password and your industry. Your dashboard opens straight away, and we activate the organization after a quick review.',
      ta: 'ஆரம்பிக்க சில நிமிஷம் போதும் 🙂 "Create an account" அழுத்தி, organization பெயர், உங்க பெயர், business email, 12 எழுத்துக்கு மேல password, industry கொடுங்க. Dashboard உடனே திறக்கும்; ஒரு சின்ன review-க்கு அப்புறம் activate பண்ணுவோம்.',
      tanglish: 'Start panna konjam nimisham podhum 🙂 "Create an account" click panni organization name, unga name, business email, 12+ character password, industry kudunga. Dashboard udane open aagum; oru chinna review-ku apram activate pannuvom.',
    },
  },
  {
    keys: /whatsapp|message|chat/i,
    answer: {
      en: 'Tacksharp answers your customers on your own WhatsApp Business number, in Tamil, English or Tanglish 💬 It uses your real prices and stock, creates leads or orders for your team, and asks a person before anything important goes out.',
      ta: 'உங்க சொந்த WhatsApp Business number-ல Tacksharp தமிழ், English அல்லது Tanglish-ல பதில் சொல்லும் 💬 உங்க உண்மையான விலை, stock வெச்சு பதில் சொல்லி, lead அல்லது order உருவாக்கும்; முக்கியமானது எதுவும் ஒருவர் approve பண்ணாம போகாது.',
      tanglish: 'Unga own WhatsApp Business number-la Tacksharp Tamil, English illa Tanglish-la reply pannum 💬 Unga real price, stock vechu answer panni, lead illa order create pannum; important ah edhuvum oru person approve pannama pogadhu.',
    },
  },
  {
    keys: /call|voice|phone|plivo|sarvam|அழைப்பு|கால்/i,
    answer: {
      en: 'Voice calls go through your own Plivo number with natural Sarvam voices in Tamil and English 📞 The AI calls leads back, confirms visits and tells customers when an order is ready, within your calling hours.',
      ta: 'உங்க சொந்த Plivo number மூலமா, Sarvam-ன் இயல்பான தமிழ், English குரல்ல calls போகும் 📞 Leads-க்கு திரும்ப call பண்ணும், visit confirm பண்ணும், order ready ஆனதை சொல்லும், உங்க calling hours-க்குள்ள மட்டும்.',
      tanglish: 'Unga own Plivo number vazhiya, Sarvam-oda natural Tamil, English voice-la calls pogum 📞 Leads-ku thirumba call pannum, visit confirm pannum, order ready aanadha sollum, unga calling hours-kulla mattum.',
    },
  },
  {
    keys: /industr|real estate|restaurant|hospital|clinic|textile|retail|hotel|cctv|camera|manufactur|vision/i,
    answer: {
      en: 'We have dashboards for real estate, restaurants, retail and textile, manufacturing, healthcare, hotels and Vision AI / CCTV monitoring 🏢 Choose yours at sign-up and the menus and assistant match your business.',
      ta: 'Real estate, restaurant, retail & textile, manufacturing, hospital, hotel, Vision AI / CCTV எல்லாத்துக்கும் தனி dashboard இருக்கு 🏢 Sign-up பண்ணும்போது உங்க industry தேர்ந்தெடுங்க.',
      tanglish: 'Real estate, restaurant, retail & textile, manufacturing, hospital, hotel, Vision AI / CCTV ellathukkum thani dashboard irukku 🏢 Sign-up pannumbodhu unga industry choose pannunga.',
    },
  },
  {
    keys: /secur|safe|data|privacy|encrypt|பாதுகாப்பு/i,
    answer: {
      en: 'Your data stays in your organization 🔒 Every request is checked on the server, your provider keys are encrypted and never shown again, and sign-ins, approvals and changes are all recorded.',
      ta: 'உங்க data உங்க organization-க்குள்ளேயே இருக்கும் 🔒 ஒவ்வொரு request-ம் server-ல check ஆகும், உங்க keys encrypt ஆகி மறுபடி காட்டப்படாது, எல்லா மாற்றங்களும் பதிவாகும்.',
      tanglish: 'Unga data unga organization-kulleye irukkum 🔒 Ovvoru request-um server-la check aagum, unga keys encrypt aagi thirumba kaatta maattom, ella changes-um record aagum.',
    },
  },
  {
    keys: /demo|try|see/i,
    answer: {
      en: 'You can open our industry demos from the Demos page 🎯 They use sample data and never message real people. Opening one needs a login with demo access, or create your own organization and explore your dashboard.',
      ta: 'Demos page-ல industry demos பாக்கலாம் 🎯 அது sample data, உண்மையான யாருக்கும் message போகாது. Demo access இருக்கற login வேணும், இல்லனா உங்க organization உருவாக்கி dashboard பாருங்க.',
      tanglish: 'Demos page-la industry demos paakalam 🎯 Adhu sample data, real yaarukkum message pogadhu. Demo access irukura login venum, illana unga organization create panni dashboard paarunga.',
    },
  },
];

export const GREETING: Record<Style, string> = {
  en: "Hi! I'm Tara from Tacksharp 👋 Ask me anything about our WhatsApp and voice AI, pricing or getting started. You can type or tap the mic and talk.",
  ta: 'வணக்கம்! நான் Tacksharp-ல இருந்து தாரா 👋 எங்க WhatsApp, voice AI, விலை, ஆரம்பிக்கறது பத்தி எதுவேணாலும் கேளுங்க. Type பண்ணலாம் அல்லது mic அழுத்தி பேசலாம்.',
  tanglish: 'Vanakkam! Naan Tacksharp-la irundhu Tara 👋 Enga WhatsApp, voice AI, price, start panradhu pathi edhu venaalum kelunga. Type pannalam illa mic thottu pesalam.',
};

export const FALLBACK: Record<Style, string> = {
  en: "That's a good question 🙂 I don't have that detail here. Create an account or open a demo, and our team will help you directly.",
  ta: 'நல்ல கேள்வி 🙂 அந்த விவரம் என்கிட்ட இல்ல. Account உருவாக்குங்க அல்லது demo பாருங்க, எங்க team நேரடியா உதவுவாங்க.',
  tanglish: 'Nalla question 🙂 Andha detail ennakitta illa. Account create pannunga illa demo paarunga, enga team directa help pannuvanga.',
};
