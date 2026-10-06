'use strict';
// ============================================================
// EK AWAZ NEWS — SHARED HELPERS (used by every script)
// One place for: Firestore access, categories, slugs, ticker.
// Keeps all scripts consistent so they can never disagree again.
// ============================================================

const SITE_URL            = 'https://ekawaznews.github.io';
const SITE_NAME           = 'Ek Awaz News';
const AUTHOR              = 'Umer Javed';
const FIREBASE_PROJECT_ID = 'ekawaznews-a114a';
const FIREBASE_API_KEY    = 'AIzaSyDI1IGHh7ZVDWUIV-rhMMg0m534th_bcx8'; // public web key (same one index.html uses)
const FIRESTORE_BASE      = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents`;
const GENERAL_CATEGORY    = 'Home / General';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const esc   = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ─── SLUG — the ONE true slug (page generator, sitemap, autopost, site JS all use this) ──
function toSlug(title, id) {
  return (title || '').toLowerCase()
    .replace(/[^\w\s-]/g, '').replace(/\s+/g, '-')
    .replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 70) + '-' + id;
}

// ─── FIRESTORE VALUE CONVERSION ───────────────────────────────
function toFV(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number')  return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'string')  return { stringValue: v };
  if (Array.isArray(v))       return { arrayValue: { values: v.map(toFV) } };
  if (typeof v === 'object')  return { mapValue: { fields: toFF(v) } };
  return { stringValue: String(v) };
}
function toFF(obj) { const f = {}; for (const [k, v] of Object.entries(obj)) f[k] = toFV(v); return f; }
function fromFV(v) {
  if (v == null) return null;
  if ('stringValue'  in v) return v.stringValue;
  if ('integerValue' in v) return parseInt(v.integerValue, 10);
  if ('doubleValue'  in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue'    in v) return null;
  if ('timestampValue' in v) return v.timestampValue;
  if ('arrayValue'   in v) return (v.arrayValue.values || []).map(fromFV);
  if ('mapValue'     in v) { const o = {}; for (const [k, x] of Object.entries(v.mapValue.fields || {})) o[k] = fromFV(x); return o; }
  return null;
}
function docToObject(doc) {
  const o = {};
  for (const [k, v] of Object.entries(doc.fields || {})) o[k] = fromFV(v);
  o.__docId = doc.name.split('/').pop();
  o.__name  = doc.name;
  return o;
}

// ─── FIRESTORE REQUESTS (retry on 429/5xx, clear error messages) ──────────
async function fsFetch(url, opts = {}, tries = 3) {
  let last;
  for (let i = 1; i <= tries; i++) {
    try {
      const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(30000) });
      if (r.ok) return r;
      const body = await r.text();
      last = new Error(`Firestore HTTP ${r.status}: ${body.slice(0, 200)}${
        r.status === 403 ? '  → Firestore rules are blocking this request (test-mode rules expire after 30 days). Fix in Firebase Console → Firestore → Rules.' : ''}`);
      last.status = r.status;
      if (![429, 500, 502, 503, 504].includes(r.status)) throw last;
    } catch (e) {
      last = e;
      if (e.status && ![429, 500, 502, 503, 504].includes(e.status)) throw e;
    }
    if (i < tries) await sleep(1500 * i);
  }
  throw last;
}
const withKey = u => `${u}${u.includes('?') ? '&' : '?'}key=${FIREBASE_API_KEY}`;

async function listCollection(name, maskFields) {
  const out = [];
  let token = null;
  do {
    const mask = (maskFields || []).map(f => `&mask.fieldPaths=${encodeURIComponent(f)}`).join('');
    const url = withKey(`${FIRESTORE_BASE}/${name}?pageSize=300${mask}${token ? `&pageToken=${encodeURIComponent(token)}` : ''}`);
    const d = await (await fsFetch(url)).json();
    for (const doc of d.documents || []) out.push(docToObject(doc));
    token = d.nextPageToken || null;
  } while (token);
  return out;
}
const listPosts = fields => listCollection('ekawaz_posts', fields);


// Newest N posts only (cheap: Firestore bills one read per document returned)
async function queryRecentPosts(limit = 100, maskFields) {
  const body = { structuredQuery: {
    from: [{ collectionId: 'ekawaz_posts' }],
    orderBy: [{ field: { fieldPath: 'date' }, direction: 'DESCENDING' }],
    limit,
  } };
  if (maskFields && maskFields.length) body.structuredQuery.select = { fields: maskFields.map(f => ({ fieldPath: f })) };
  const r = await fsFetch(withKey(`${FIRESTORE_BASE}:runQuery`), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const rows = await r.json();
  return (Array.isArray(rows) ? rows : []).filter(x => x.document).map(x => docToObject(x.document));
}

async function getDocument(path) {
  try { return docToObject(await (await fsFetch(withKey(`${FIRESTORE_BASE}/${path}`))).json()); }
  catch (e) { if (e.status === 404) return null; throw e; }
}

// Create or fully replace one post (used only for NEW posts)
async function savePost(post) {
  await fsFetch(withKey(`${FIRESTORE_BASE}/ekawaz_posts/${String(post.id)}`), {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: toFF(post) }),
  });
}
// Update ONLY the listed fields of an existing document (never wipes the rest)
async function patchFields(path, obj) {
  const keys = Object.keys(obj);
  if (!keys.length) return;
  const mask = keys.map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&');
  await fsFetch(withKey(`${FIRESTORE_BASE}/${path}?${mask}`), {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: toFF(obj) }),
  });
}
async function deleteDocument(path) {
  await fsFetch(withKey(`${FIRESTORE_BASE}/${path}`), { method: 'DELETE' });
}

// ─── CATEGORIES — exactly the ones on the real site nav ───────
const NAV_CATEGORIES = ['Politics','Government','Sports','Entertainment','Weather','International','National','Editorials','Columns','Bulletins','Videos'];
const VALID_CATEGORIES = [GENERAL_CATEGORY, ...NAV_CATEGORIES];

const CATEGORY_MAP = {            // RSS feed key -> site categories
  politics:      ['Politics'],
  government:    ['Government', 'Politics'],
  sports:        ['Sports'],
  international: ['International'],
  entertainment: ['فلم','ڈراما','ڈرامہ','اداکار','اداکارہ','گلوکار','شوبز','گانا','کنسرٹ','لالی ووڈ','بالی ووڈ', 'Entertainment'],
  economy:       ['National'],
  weather:       ['Weather'],
  education:     ['National'],
  crime:         ['National'],
  social:        ['National'],
  urdu:          ['National'],
};
// Old / invalid category names found in existing posts -> real categories
const REMAP = {
  Crime: ['National'], Economy: ['National'], Education: ['National'], Social: ['National'],
  Urdu: ['National'], Business: ['National'], Health: ['National'], Technology: ['National'],
  Opinion: ['Columns'], Editorial: ['Editorials'], Column: ['Columns'], Bulletin: ['Bulletins'],
  Video: ['Videos'], Lifestyle: ['Entertainment'], Showbiz: ['Entertainment'], World: ['International'],
  Home: [GENERAL_CATEGORY], General: [GENERAL_CATEGORY], Uncategorized: [],
};

function catKeyFor(name) {
  return (name || 'national').toLowerCase().replace(/\s*\/\s*/g, '-').replace(/\s+/g, '-');
}
function buildCategories(feedKey, overrideCats) {
  const base = overrideCats || CATEGORY_MAP[feedKey] || ['National'];
  return [...new Set([...base, GENERAL_CATEGORY])];
}

// Whole-word match: "fir" must NOT match "first", "un" must NOT match "under".
function hasWord(txt, w) {
  if (/[^\x00-\x7F]/.test(w)) return String(txt).includes(w);       // Urdu etc: plain match
  const esc2 = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('\\b' + esc2 + '(?:s|es)?\\b', 'i').test(txt);
}
const anyWord = (txt, list) => list.some(w => hasWord(txt, w));

const PAKISTAN_KEYWORDS = [
  'pakistan','pakistani','karachi','lahore','islamabad','rawalpindi','faisalabad','multan','peshawar','quetta',
  'punjab','sindh','balochistan','khyber pakhtunkhwa','kpk','gilgit','azad kashmir','pkr','psl','pcb',
  'shehbaz','imran khan','bilawal','zardari','nawaz sharif','pmln','pti','ppp','sbp','fia','nadra','wapda',
  'ogra','pemra','pak army','isi','ispr','ecp','gwadar','hyderabad sindh','sialkot','bahawalpur',
  // Urdu
  'پاکستان','کراچی','لاہور','اسلام آباد','راولپنڈی','فیصل آباد','ملتان','پشاور','کوئٹہ','پنجاب','سندھ','بلوچستان',
  'خیبر','پختونخوا','گلگت','کشمیر','وزیراعظم','وزیر اعظم','قومی اسمبلی','سینیٹ','عمران خان','شہباز','نواز شریف',
  'زرداری','بلاول','تحریک انصاف','مسلم لیگ','پیپلز پارٹی','پاک فوج','آئی ایس پی آر','سپریم کورٹ','گوادر',
];
const isPakistanRelated = text => anyWord(String(text || '').toLowerCase(), PAKISTAN_KEYWORDS) || anyWord(String(text || ''), PAKISTAN_KEYWORDS.filter(k => /[^\x00-\x7F]/.test(k)));

const KW = {
  sports: ['کرکٹ','میچ','ٹیم','کھلاڑی','کھلاڑیوں','ورلڈ کپ','پی ایس ایل','ہاکی','فٹبال','اولمپک','بلے باز','ٹی ٹوئنٹی','ایشیا کپ','کوچ','اسٹیڈیم', 'cricket','psl','match','wicket','wickets','innings','tournament','olympic','olympics','football','fifa','hockey','squash','tennis','batsman','bowler','t20','odi','test series','asia cup','world cup','medal','athlete','stadium','coach','league','goal','semi-final','final'],
  entertainment: ['film','movie','drama','actor','actress','singer','celebrity','showbiz','lollywood','bollywood','hollywood','concert','album','music','netflix','box office','trailer','director','award show','fashion'],
  weather: ['بارش','بارشیں','موسم','سیلاب','طوفان','گرمی','سردی','برفباری','محکمہ موسمیات','دھند','آندھی', 'weather','rain','rains','rainfall','monsoon','flood','floods','heatwave','heat wave','temperature','forecast','storm','cyclone','snowfall','fog','pmd','met office','drought','cold wave','thunderstorm','hailstorm'],
  politics: ['اسمبلی','سینیٹ','وزیراعظم','وزیر اعظم','انتخابات','اپوزیشن','پارلیمنٹ','سیاسی','تحریک انصاف','مسلم لیگ','پیپلز پارٹی','وزیر اعلیٰ','سیاست', 'election','parliament','senate','national assembly','assembly','minister','pti','pmln','ppp','coalition','prime minister','opposition','cabinet','politician','political','party','vote','ballot','lawmaker','mna','mpa','amendment','chief minister'],
  economy: ['معیشت','روپیہ','ڈالر','بجٹ','مہنگائی','اسٹیٹ بینک','آئی ایم ایف','سٹاک ایکسچینج','تجارت','برآمدات','پیٹرول', 'economy','economic','inflation','imf','sbp','state bank','rupee','stock exchange','psx','kse','budget','tax','fbr','exports','imports','trade','gdp','petrol price','electricity tariff','investment','industry','remittances','business'],
  education: ['یونیورسٹی','طلبہ','طلبا','امتحان','تعلیم','سکول','اسکول','کالج','اساتذہ','داخلے', 'university','universities','hec','school','schools','students','student','exam','exams','board','matric','intermediate','curriculum','admission','admissions','scholarship','teachers','teacher','college','education'],
  crime: ['پولیس','گرفتار','عدالت','قتل','ڈکیتی','اغوا','ملزم','ملزمان','مقدمہ','دہشت گرد','حملہ', 'police','arrest','arrested','court','murder','robbery','fia','kidnap','kidnapped','accused','sentenced','bail','suspect','suspects','terror','terrorist','terrorists','militants','attack','killed','custody','fir','verdict','trial'],
  social: ['صحت','ہسپتال','غربت','خواتین','بچے','بچوں','ڈینگی','پولیو','ویکسین','ماحولیات', 'health','hospital','hospitals','poverty','women','children','charity','disease','dengue','polio','vaccine','vaccination','donation','welfare','environment','climate','pollution','water','electricity','load shedding','ngo','rights'],
  government: ['حکومت','وفاقی','صوبائی','وزارت','کابینہ','وزیر', 'government','federal','provincial','ministry','budget','governor','policy','secretariat','bureaucrat','imf','tax','fbr','finance ministry','circular','notification','secretary','cabinet division'],
};
function detectCategory(title, text = '') {
  const t = `${title || ''} ${text || ''}`.toLowerCase();
  if (anyWord(t, KW.sports))        return 'Sports';
  if (anyWord(t, KW.entertainment)) return 'Entertainment';
  if (anyWord(t, KW.weather))       return 'Weather';
  if (anyWord(t, KW.politics))      return 'Politics';
  if (anyWord(t, KW.government))    return 'Government';
  return isPakistanRelated(t) ? 'National' : 'International';
}

// Works out the correct categories for an existing post. Pure function.
function classifyPost(post, opts = {}) {
  const existing = (Array.isArray(post.categories) && post.categories.length ? post.categories : [post.category]).filter(Boolean);
  let core = [];
  for (const c of existing) {
    if (c === GENERAL_CATEGORY) continue;
    if (NAV_CATEGORIES.includes(c)) core.push(c);
    else if (REMAP[c]) core.push(...REMAP[c].filter(x => x !== GENERAL_CATEGORY));
    else core.push(detectCategory(post.title, post.excerpt));
  }
  core = [...new Set(core)];
  if (!core.length) core = [detectCategory(post.title, post.excerpt)];

  // National must be about Pakistan; otherwise it is International
  const pkStory = opts.pakistan !== undefined ? opts.pakistan : isPakistanRelated(`${post.title || ''} ${post.excerpt || ''} ${String(post.body || '').slice(0, 600)}`);
  if (core.includes('National') && !pkStory) {
    core = core.filter(c => c !== 'National');
    if (!core.length) core = ['International'];
  }
  const categories = [...core, GENERAL_CATEGORY];
  return { categories, category: core[0], cat_key: catKeyFor(core[0]) };
}

// ─── TICKER — the site stores it as an ARRAY of strings in ekawaz/main ───────
function tickerFromPosts(posts, max = 15) {
  const seen = new Set(); const out = [];
  const sorted = posts.filter(p => p.status === 'published' && p.title).sort((a, b) => new Date(b.date) - new Date(a.date));
  for (const p of sorted) {
    const t = String(p.title).replace(/\s+/g, ' ').trim().slice(0, 110);
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k); out.push(t);
    if (out.length >= max) break;
  }
  return out;
}
async function readTicker() {
  const main = await getDocument('ekawaz/main');
  const t = main && main.ticker;
  if (Array.isArray(t)) return t.map(String).filter(Boolean);
  if (typeof t === 'string') return t.split('\n').map(s => s.replace(/^•\s*/, '').trim()).filter(Boolean);
  return [];
}
async function writeTicker(items) {
  await patchFields('ekawaz/main', { ticker: items });      // updateMask: touches ONLY ticker
}

module.exports = {
  SITE_URL, SITE_NAME, AUTHOR, FIREBASE_PROJECT_ID, FIREBASE_API_KEY, FIRESTORE_BASE, GENERAL_CATEGORY,
  NAV_CATEGORIES, VALID_CATEGORIES, CATEGORY_MAP, REMAP,
  sleep, esc, toSlug, toFV, toFF, fromFV, docToObject,
  listCollection, listPosts, queryRecentPosts, getDocument, savePost, patchFields, deleteDocument,
  catKeyFor, buildCategories, hasWord, anyWord, isPakistanRelated, detectCategory, classifyPost,
  KW, tickerFromPosts, readTicker, writeTicker,
};
