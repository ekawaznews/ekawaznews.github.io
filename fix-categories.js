#!/usr/bin/env node
// ============================================================
// Ek Awaz News — ONE-TIME category cleanup for existing posts
// Run manually: node fix-categories.js
// Not part of the scheduled workflow — run it once from your
// own machine or a manual GitHub Actions dispatch, then you're done.
//
// What it does to every existing post in Firestore:
//  - Maps old/broken categories (Government, Home / General as a
//    primary economy label, etc.) to the real site categories.
//  - Adds a `categories` array to every post if missing.
//  - Makes sure "Home / General" is included in every post's
//    categories array, so all old posts show up as general news too.
// ============================================================

const FIREBASE_PROJECT_ID = 'ekawaznews-a114a';
const FIREBASE_API_KEY    = 'AIzaSyDI1IGHh7ZVDWUIV-rhMMg0m534th_bcx8';
const FIRESTORE_BASE      = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents`;
const GENERAL_CATEGORY    = 'Home / General';

// Old category value -> corrected categories array
const REMAP = {
  'Government':     ['Politics', 'National'],
  'Home / General':  ['National'],   // this used to be misused for Economy news
  'Politics':       ['Politics'],
  'Sports':         ['Sports'],
  'International':  ['International'],
  'Entertainment':  ['Entertainment'],
  'Weather':        ['Weather'],
  'National':       ['National'],
  'Editorials':     ['Editorials'],
  'Columns':        ['Columns'],
  'Bulletins':      ['Bulletins'],
};

function catKeyFor(name) {
  return (name || 'national').toLowerCase().replace(/\s*\/\s*/g, '-').replace(/\s+/g, '-');
}

function isPakistanRelated(text) {
  const t = (text || '').toLowerCase();
  const keywords = [
    'pakistan','pakistani','karachi','lahore','islamabad','rawalpindi','faisalabad',
    'multan','peshawar','quetta','punjab','sindh','balochistan','khyber pakhtunkhwa',
    'kpk','gilgit','azad kashmir','pkr','rupee','psl','pcb','shehbaz','imran khan',
    'bilawal','zardari','nawaz sharif','pmln','pti','ppp','sbp','fia','nadra','wapda',
    'ogra','pemra','pak army','isi ',
  ];
  return keywords.some(k => t.includes(k));
}

function fromFirestoreValue(v) {
  if (v == null) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return parseInt(v.integerValue, 10);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fromFirestoreValue);
  if ('mapValue' in v) {
    const out = {};
    for (const [k, val] of Object.entries(v.mapValue.fields || {})) out[k] = fromFirestoreValue(val);
    return out;
  }
  return null;
}

function toFV(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'string') return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toFV) } };
  return { stringValue: String(v) };
}

async function listAllPosts() {
  const posts = [];
  let pageToken = null;
  do {
    const url = `${FIRESTORE_BASE}/ekawaz_posts?pageSize=100&key=${FIREBASE_API_KEY}${pageToken ? `&pageToken=${pageToken}` : ''}`;
    const res = await fetch(url);
    const data = await res.json();
    for (const doc of data.documents || []) {
      const fields = {};
      for (const [k, v] of Object.entries(doc.fields || {})) fields[k] = fromFirestoreValue(v);
      posts.push({ name: doc.name, fields });
    }
    pageToken = data.nextPageToken || null;
  } while (pageToken);
  return posts;
}

async function updatePost(docName, categories, category, catKey) {
  const url = `https://firestore.googleapis.com/v1/${docName}?updateMask.fieldPaths=categories&updateMask.fieldPaths=category&updateMask.fieldPaths=cat_key&key=${FIREBASE_API_KEY}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fields: {
        categories: toFV(categories),
        category: toFV(category),
        cat_key: toFV(catKey),
      },
    }),
  });
  if (!res.ok) throw new Error(`Update failed ${res.status}: ${await res.text()}`);
}

async function main() {
  console.log('Fetching all posts from Firestore...');
  const posts = await listAllPosts();
  console.log(`Found ${posts.length} posts.\n`);

  let fixed = 0;
  for (const post of posts) {
    const oldCategory = post.fields.category || 'National';
    const hasArray = Array.isArray(post.fields.categories) && post.fields.categories.length > 0;

    const base = REMAP[oldCategory] || [oldCategory];
    let categories = [...new Set([...(hasArray ? post.fields.categories : base), GENERAL_CATEGORY])];

    // Content check: if this post ended up under National but isn't actually
    // about Pakistan (old bug — e.g. BBC Urdu world stories), move it to
    // International instead.
    const textToCheck = `${post.fields.title || ''} ${post.fields.excerpt || ''}`;
    if (categories.includes('National') && !isPakistanRelated(textToCheck)) {
      categories = categories.filter(c => c !== 'National');
      if (!categories.some(c => c !== GENERAL_CATEGORY)) categories.push('International');
      categories = [...new Set(categories)];
    }

    const primary = categories.find(c => c !== GENERAL_CATEGORY) || GENERAL_CATEGORY;
    const catKey = catKeyFor(primary);

    const needsUpdate = !hasArray
      || primary !== oldCategory
      || catKey !== post.fields.cat_key
      || categories.length !== (post.fields.categories || []).length;

    if (!needsUpdate) continue;

    try {
      await updatePost(post.name, categories, primary, catKey);
      fixed++;
      console.log(`Fixed: "${(post.fields.title || '').slice(0, 60)}" -> ${categories.join(', ')}`);
    } catch (e) {
      console.log(`FAILED: ${post.name} — ${e.message}`);
    }
  }

  console.log(`\nDone. ${fixed}/${posts.length} posts updated.`);
}

main().catch(e => { console.error('[FATAL]', e.message); process.exit(1); });
