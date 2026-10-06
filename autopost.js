#!/usr/bin/env node
'use strict';
// ============================================================
// EK AWAZ NEWS — AUTO-PUBLISHER v6  (Gemini only)
//
//  * Reads Geo, Dawn, The News, Samaa, ARY, Hum, BBC, BBC Urdu, Al Jazeera,
//    Arab News and Fox News, then the AI writes a NEW article (never a copy).
//  * 1,000+ words per article (digest / bulletins 900+).
//  * Facts are checked: figures and quotes that are not in the sources are
//    removed, and text that is too close to a source is rejected.
//  * Every story goes to the right category; copyright-free Pexels photo
//    with the Ek Awaz logo.
//  * Self-healing: every planned article has a "slot". A run only fills slots
//    that are still empty today, so catch-up runs and retries never duplicate.
//
// Exit codes: 0 = everything planned is published | 3 = some slots still empty | 1 = set-up problem
// ============================================================
const fs   = require('fs');
const path = require('path');
const sharp = require('sharp');

const C  = require('./lib/common');
const AI = require('./lib/ai');
const G  = require('./lib/guard');
const S  = require('./lib/sources');
const { renderPage } = require('./lib/page-template');
const { SITE_URL, GENERAL_CATEGORY, esc, sleep } = C;

const PEXELS_API_KEY           = process.env.PEXELS_API_KEY;
const CRICAPI_KEY              = process.env.CRICAPI_KEY;                 // optional (cricapi.com free key)
const FOOTBALL_API_KEY         = process.env.FOOTBALL_API_KEY || '3';     // TheSportsDB public test key
const CLOUDINARY_CLOUD_NAME    = process.env.CLOUDINARY_CLOUD_NAME;
const CLOUDINARY_UPLOAD_PRESET = process.env.CLOUDINARY_UPLOAD_PRESET;
const LOGO_PATH  = path.join(__dirname, 'ek-awaz-logo.png');
const PAGES_DIR  = path.join(__dirname, 'news');
const IMG_DIR    = path.join(PAGES_DIR, 'img');

const MIN_WORDS        = { article: 1000, editorial: 1000, column: 1000, bulletin: 900, digest: 900 };
const MAX_SIMILARITY   = 0.12;      // max share of the article that may repeat a source word-for-word (6-word runs)
const MAX_SLOTS_PER_RUN = parseInt(process.env.MAX_SLOTS_PER_RUN || '8', 10);
const todayUTC = () => new Date().toISOString().slice(0, 10);

// ─── DAILY PLAN (18 articles/day + weekly special) ────────────
const T = (topic, extra = {}) => ({ topic, type: 'article', ...extra });
const PLAN = {
  A: [T('Politics'), T('Government'), T('Sports'), T('Weather'), 'SPECIAL'],   // the weekly special goes last so it never takes the best stories
  B: [T('International'), T('Entertainment'), T('Economy'), T('Education'), T('Sports'), T('International')],
  C: [T('Weather'), T('Social'), T('Crime'), T('Urdu'), T('Urdu'), T('Urdu'),
      { topic: 'Digest', type: 'digest', label: 'Daily News Digest', category: 'Bulletins' }],
};
const SPECIALS = {   // by weekday in Pakistan (0 = Sunday)
  0: { type: 'bulletin',  label: 'Bulletin',     category: 'Bulletins',  topics: ['Politics', 'Sports', 'International'] },
  1: { type: 'article',   label: 'Untold Story', topic: 'Social',  category: 'National' },
  2: { type: 'bulletin',  label: 'Bulletin',     category: 'Bulletins',  topics: ['Economy', 'Entertainment', 'Weather'] },
  3: { type: 'column',    label: 'Column',       topic: 'Politics', category: 'Columns' },
  4: { type: 'bulletin',  label: 'Bulletin',     category: 'Bulletins',  topics: ['Crime', 'Education', 'Social'] },
  5: { type: 'editorial', label: 'Editorial',    topic: 'Economy', category: 'Editorials' },
  6: { type: 'article',   label: 'Crime Report', topic: 'Crime',   category: 'National' },
};
const TOPIC_CATEGORY = { Politics: 'Politics', Government: 'Government', Sports: 'Sports', Entertainment: 'Entertainment', Weather: 'Weather',
  International: 'International', Economy: 'National', Education: 'National', Crime: 'National', Social: 'National', Urdu: 'National', National: 'National' };
const TOPIC_FALLBACKS = { Politics: ['Politics', 'Government'], Government: ['Government', 'Politics'], Sports: ['Sports'], Entertainment: ['Entertainment'],
  International: ['International'], Economy: ['Economy', 'National'], Education: ['Education', 'National'], Crime: ['Crime', 'National'],
  Social: ['Social', 'National'], Urdu: ['Urdu', 'National'] };
const DEFAULT_IMAGE_QUERY = { Politics: 'parliament building', Government: 'government building', Sports: 'cricket stadium', Entertainment: 'cinema film',
  Weather: 'storm clouds', International: 'world map globe', National: 'Pakistan city', Bulletins: 'newspaper', Editorials: 'newspaper desk', Columns: 'writing desk' };

function slotsFor(batchKey) {
  const pkWeekday = new Date(Date.now() + 5 * 3600 * 1000).getUTCDay();
  return (PLAN[batchKey] || []).map((s, i) => {
    const slot = s === 'SPECIAL' ? { ...SPECIALS[pkWeekday] } : { ...s };
    return { ...slot, batch: batchKey, slotId: `${batchKey}-${i}` };
  });
}
// Which batches should already have run today (UTC)? Used by the catch-up run.
function dueBatches() {
  const m = new Date().getUTCHours() * 60 + new Date().getUTCMinutes();
  const due = [];
  if (m >= 0 * 60 + 40)  due.push('A');
  if (m >= 6 * 60 + 45)  due.push('B');
  if (m >= 13 * 60 + 5)  due.push('C');
  return due;
}


// ============================================================
// MAIN
// ============================================================
async function main() {
  console.log('='.repeat(60));
  console.log('EK AWAZ AUTO-PUBLISHER v6 (Gemini)');
  console.log('='.repeat(60));
  console.log(`Time (UTC): ${new Date().toISOString()}   Node: ${process.version}   BATCH: ${process.env.BATCH || 'NOT SET (using A)'}`);
  AI.providerStatus().forEach(l => console.log(`AI key:   ${l}`));
  console.log(`Pexels:   ${PEXELS_API_KEY ? 'SET' : 'missing (brand image will be used)'}   Cloudinary: ${CLOUDINARY_CLOUD_NAME || 'not set (images saved in repo)'}   Logo: ${fs.existsSync(LOGO_PATH) ? 'found' : 'NOT FOUND'}`);
  console.log('='.repeat(60));

  if (!AI.hasKeys()) {
    console.error('[FATAL] GEMINI_API_KEY is not set. Add it in GitHub -> Settings -> Secrets and variables -> Actions -> New repository secret.');
    process.exit(1);
  }
  fs.mkdirSync(PAGES_DIR, { recursive: true });

  // ---- what is planned, and what is already done today ----
  const mode = (process.env.BATCH || 'A').trim();
  const batches = mode.toLowerCase() === 'catchup' ? dueBatches() : [PLAN[mode] ? mode : 'A'];
  let planned = batches.flatMap(slotsFor);
  console.log(`[STEP 1] Mode: ${mode} -> batches ${batches.join(', ') || '(none due yet)'} | planned slots: ${planned.length}`);

  let recent = [];
  try { recent = await C.queryRecentPosts(160); }
  catch (e) {
    console.error(`[FATAL] Cannot read Firestore: ${e.message}`);
    process.exit(1);
  }
  const today = todayUTC();
  const done = new Set(recent.filter(p => p.runDay === today && p.slotId).map(p => p.slotId));
  let missing = planned.filter(s => !done.has(s.slotId));
  console.log(`[STEP 1] Already published today: ${planned.length - missing.length} | still to publish: ${missing.length}`);
  if (!missing.length) { console.log('Nothing to do — all planned articles for today are already published.'); return finish([], 0); }
  const queue = missing.slice(0, MAX_SLOTS_PER_RUN);

  // ---- gather the news pool once ----
  console.log('\n[STEP 2] Reading news feeds...');
  const { pool, okFeeds, badFeeds } = await S.gatherPool();
  console.log(`  feeds OK (${okFeeds.length}): ${okFeeds.join(' | ')}`);
  if (badFeeds.length) console.log(`  feeds skipped (${badFeeds.length}): ${badFeeds.join(' | ')}`);
  console.log(`  stories in pool: ${pool.length}`);
  if (pool.length < 5) console.log('  [WARN] very few stories found — the network or the feeds may be down');

  const ctx = {
    pool, recent, today,
    usedLinks: new Set(), usedImages: new Set(),
    recentLinks: new Set(recent.map(p => p.sourceUrl).filter(Boolean)),
    recentWords: recent.map(p => S.sigWords(p.title)).filter(w => w.length),
  };

  const published = []; const failed = [];
  let aiFailStreak = 0;
  for (let i = 0; i < queue.length; i++) {
    const slot = queue[i];
    console.log(`\n${'─'.repeat(50)}\n[SLOT ${i + 1}/${queue.length}] ${slot.slotId} | ${slot.label || slot.topic} | ${slot.type}`);
    try {
      const out = await publishSlot(slot, ctx);
      if (out.post) { published.push(out.post); aiFailStreak = 0; ctx.recent.push(out.post); }
      else {
        failed.push(`${slot.slotId} (${out.why})`);
        console.log(`  [SKIP] ${out.why}`);
        if (out.aiDown) aiFailStreak++;
        if (aiFailStreak >= 2) { console.log('  [STOP] Gemini is not answering (quota used up or service down). The catch-up run will try again later.'); break; }
      }
    } catch (e) {
      failed.push(`${slot.slotId} (${e.message})`);
      console.error(`  [ERROR] ${e.message}`);
      if (/Firestore HTTP 403/.test(e.message)) { console.error('  [STOP] Firestore refuses writes. Fix the Firestore rules (Firebase Console -> Firestore -> Rules).'); break; }
    }
  }
  const left = missing.length - published.length;
  return finish(published, left, failed);
}

async function finish(published, left, failed = []) {
  if (published.length) {
    console.log('\n[TICKER] Updating breaking news ticker...');
    await updateTicker(published.map(p => p.title));
  }
  const st = AI.getStats();
  console.log('\n' + '='.repeat(60));
  console.log(`DONE — published ${published.length} article(s) this run | still empty: ${left}`);
  console.log(`Gemini calls: ${st.calls} (ok ${st.ok}) ${Object.entries(st.byModel).map(([m, n]) => `${m}:${n}`).join(' ')}`);
  if (st.deadModels.length) console.log(`Models out of quota this run: ${st.deadModels.join(', ')}`);
  if (failed.length) console.log(`Skipped: ${failed.join(' ; ')}`);
  console.log('='.repeat(60));
  try {
    if (process.env.GITHUB_STEP_SUMMARY) {
      const lines = [`### Ek Awaz auto-publisher`, `Published **${published.length}**, still empty **${left}**.`, ''];
      published.forEach(p => lines.push(`- ✅ ${p.category}: ${p.title} (${p.wordCount} words)`));
      failed.forEach(f => lines.push(`- ⚠️ ${f}`));
      fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
    }
  } catch (_) {}
  process.exitCode = left > 0 ? 3 : 0;
}

// ============================================================
// ONE SLOT: choose story -> write -> check -> image -> save -> page
// ============================================================
async function publishSlot(slot, ctx) {
  const type = slot.type;
  const isUrdu = slot.topic === 'Urdu';
  const exclude = it => ctx.usedLinks.has(it.link) || ctx.recentLinks.has(it.link) || isAlreadyCovered(it, ctx);
  const attempts = [];       // each: { material, slotCategory, mainItem }

  if (type === 'digest')            { const m = await digestMaterial(ctx); if (m) attempts.push({ material: m, slotCategory: 'Bulletins' }); }
  else if (type === 'bulletin')     { const m = await bulletinMaterial(slot, ctx, exclude); if (m) attempts.push({ material: m, slotCategory: 'Bulletins' }); }
  else if (slot.topic === 'Weather'){ const m = await weatherSlotMaterial(ctx, exclude); if (m) attempts.push({ material: m, slotCategory: 'Weather', widget: 'weather' }); }
  else {
    // Only stories that really belong to the slot's topic are used (never a random story)
    const seen = new Set(); const cands = [];
    for (const t of TOPIC_FALLBACKS[slot.topic] || [slot.topic]) for (const it of S.pickCandidates(ctx.pool, t, exclude, true)) {
      if (seen.has(it.link)) continue; seen.add(it.link); cands.push({ it, topic: t });
      if (cands.length >= 4) break;
    }
    if (!cands.length) return { why: `no fresh story found for ${slot.topic}` };
    for (const { it, topic } of cands.slice(0, 3)) {
      console.log(`  [A] Story: "${it.title.slice(0, 80)}" (${it.src}${it.weak ? ', via Google News' : ''})`);
      ctx.usedLinks.add(it.link);
      const material = await S.buildMaterial(it, ctx.pool);
      console.log(`  [A] Material: ${material.credits.map(c => c.name).join(' + ')} | ${material.totalChars} chars (${material.groundedChars} from full article)`);
      if (material.totalChars < 700) { console.log('  [A] Not enough source material for a 1,000-word article — trying another story'); continue; }
      const slotCategory = TOPIC_CATEGORY[topic] || 'National';
      attempts.push({ material, slotCategory, mainItem: it });
      break;
    }
    if (!attempts.length) return { why: 'no story had enough source material' };
  }
  if (!attempts.length) return { why: `no source material available (${slot.topic})` };

  for (const att of attempts) {
    const { material } = att;
    console.log('  [D] Writing with Gemini...');
    const written = await writeArticle({ slot, material, isUrdu });
    if (!written) return { why: 'Gemini could not produce a valid 1,000-word article', aiDown: written === null && AI.getStats().ok === 0 };
    const { data, words, model, removed } = written;
    console.log(`  [D] Article OK: "${data.title.slice(0, 70)}" — ${words} words (${model})${removed ? `, ${removed} unsupported sentence(s) removed` : ''}`);

    // ---- category ----
    const cats = decideCategories(slot, att.slotCategory, data, material);
    console.log(`  [C] Categories: ${cats.categories.join(', ')}`);

    // ---- widgets ----
    let widgetHtml = '';
    if (cats.category === 'Weather' || att.widget === 'weather') widgetHtml = (await buildWeatherWidget()) || '';
    else if (cats.category === 'Sports') widgetHtml = (await buildSportsScoreboard()) || '';

    // ---- image ----
    const img = await pickImage(data.imageQuery, data.title, cats.category, ctx);

    // ---- post ----
    const postId = Date.now() + Math.floor(Math.random() * 500);
    const slug = C.toSlug(data.title, postId);
    const sources = material.credits.filter(c => c.name).map(c => ({ name: c.name, url: c.url || '' }));
    const post = {
      id: postId, slug, pageUrl: `${SITE_URL}/news/${slug}.html`,
      title: data.title, excerpt: data.excerpt || '',
      category: cats.category, categories: cats.categories, cat_key: cats.cat_key,
      type, author: C.AUTHOR, body: data.body, widgetHtml,
      image: img.url, imageCredit: img.credit,
      video: '', audio: '', pdf: '',
      tags: Array.isArray(data.tags) ? data.tags.slice(0, 8) : [],
      status: 'published', isHeadline: false, views: 0, likes: 0, _liked: false,
      date: new Date().toISOString(), ad_slot: '', lastEditedBy: 'Auto', lastEditedAt: new Date().toISOString(),
      scheduledAt: '', series: slot.label && slot.type !== 'article' ? slot.label : (slot.label || ''),
      seoTitle: data.seoTitle || '', seoDesc: data.seoDesc || '', revisions: [],
      lang: isUrdu ? 'ur' : 'en',
      sourceName: sources.map(s => s.name).join(', '), sourceUrl: (sources.find(s => s.url) || {}).url || '', sources,
      batch: slot.batch, slotId: slot.slotId, runDay: ctx.today, aiModel: model, wordCount: words,
    };

    console.log(`  [E] Saving to Firebase (id ${postId})...`);
    await C.savePost(post);
    console.log('  [E] Firebase OK');
    fs.writeFileSync(path.join(PAGES_DIR, `${slug}.html`), renderPage(post), 'utf8');
    console.log(`  [F] Page written: news/${slug}.html`);
    ctx.recentWords.push(S.sigWords(post.title));
    console.log(`  PUBLISHED [${cats.category}] "${post.title.slice(0, 70)}"`);
    return { post };
  }
  return { why: 'nothing published' };
}

function isAlreadyCovered(it, ctx) {
  const w = it.words || [];
  if (w.length < 3) return false;
  return ctx.recentWords.some(rw => { const shared = w.filter(x => rw.includes(x)).length; return shared >= 4 && shared / Math.min(w.length, rw.length) >= 0.6; });
}

// ─── material builders for special slots ──────────────────────
async function digestMaterial(ctx) {
  const todays = ctx.recent.filter(p => p.runDay === ctx.today && p.type !== 'digest' && p.body)
    .sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 8);
  const parts = todays.map((p, i) => `REPORT ${i + 1} (Ek Awaz News, ${p.category})\nHEADLINE: ${p.title}\nSUMMARY: ${p.excerpt || ''}\nDETAILS: ${G.plain(p.body).slice(0, 750)}`);
  const credits = [{ name: 'Ek Awaz News reports', url: '' }];
  if (todays.length < 5) {
    const extra = S.pickCandidates(ctx.pool, 'National', it => ctx.usedLinks.has(it.link), false).filter(it => !it.weak).slice(0, 6 - todays.length);
    for (const it of extra) { parts.push(`OTHER HEADLINE (${it.src})\nHEADLINE: ${it.title}\nSUMMARY: ${it.summary || '(none)'}`); credits.push({ name: it.src, url: it.link }); ctx.usedLinks.add(it.link); }
  }
  if (parts.length < 3) return null;
  const text = parts.join('\n\n---\n\n');
  console.log(`  [A] Digest material: ${todays.length} of today's reports + ${parts.length - todays.length} extra headline(s)`);
  return { text, credits, groundedChars: text.length, totalChars: text.length };
}
async function bulletinMaterial(slot, ctx, exclude) {
  const items = [];
  for (const topic of slot.topics || []) {
    for (const it of S.pickCandidates(ctx.pool, topic, it => exclude(it) || items.includes(it), true).slice(0, 2)) items.push(it);
  }
  if (items.length < 3) for (const it of S.pickCandidates(ctx.pool, 'Any', it => exclude(it) || items.includes(it), false).slice(0, 6 - items.length)) items.push(it);
  if (items.length < 3) return null;
  const parts = []; const credits = [];
  for (let i = 0; i < Math.min(items.length, 6); i++) {
    const it = items[i]; ctx.usedLinks.add(it.link);
    const full = it.weak ? { text: '' } : await S.fetchArticleText(it.link);
    parts.push(`STORY ${i + 1} — ${it.src}\nHEADLINE: ${it.title}\nSUMMARY: ${it.summary || '(none)'}${full.text ? `\nARTICLE TEXT:\n${full.text.slice(0, 1800)}` : ''}`);
    credits.push({ name: it.src, url: it.weak ? '' : it.link });
  }
  const text = parts.join('\n\n---\n\n');
  console.log(`  [A] Bulletin material: ${parts.length} stories (${items.map(i => i.src).slice(0, 6).join(', ')})`);
  return { text, credits, groundedChars: text.length, totalChars: text.length };
}
async function weatherSlotMaterial(ctx, exclude) {
  const forecast = await S.weatherMaterial();
  const news = S.pickCandidates(ctx.pool, 'Weather', exclude, true).filter(it => !it.weak).slice(0, 2);
  if (!forecast && !news.length) return null;
  const parts = []; const credits = [{ name: 'Open-Meteo weather data', url: 'https://open-meteo.com' }];
  if (forecast) parts.push(forecast);
  news.forEach((it, i) => { parts.push(`WEATHER NEWS ${i + 1} — ${it.src}\nHEADLINE: ${it.title}\nSUMMARY: ${it.summary || '(none)'}`); credits.push({ name: it.src, url: it.link }); ctx.usedLinks.add(it.link); });
  const text = parts.join('\n\n---\n\n');
  console.log(`  [A] Weather material: forecast ${forecast ? 'OK' : 'missing'} + ${news.length} news item(s)`);
  if (text.length < 500) return null;
  return { text, credits, groundedChars: text.length, totalChars: text.length };
}

// ============================================================
// WRITE THE ARTICLE (prompt -> Gemini -> checks -> optional expansion)
// ============================================================
function buildPrompt({ slot, material, isUrdu, minWords, mode = 'write', draft = '' }) {
  const today = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Karachi' });
  const lang = isUrdu ? 'Write the ENTIRE article (title, excerpt, body, seoTitle, seoDesc, tags) in clear, modern Urdu as used by BBC Urdu and Geo News. Only the imageQuery stays in English.'
                      : 'Write in clear, professional English in the tone of a Pakistani newsroom.';
  let typeNote = 'NEWS ARTICLE: report the facts clearly and objectively.';
  if (slot.type === 'editorial') typeNote = 'EDITORIAL: the reasoned viewpoint of Ek Awaz News on this issue, grounded only in the facts in the material. Make the argument clear and balanced, and acknowledge other views. Do not present opinion as fact.';
  else if (slot.type === 'column') typeNote = 'OPINION COLUMN: a thoughtful analysis piece in a measured voice. Analysis and interpretation only; no new facts beyond the material.';
  else if (slot.type === 'bulletin') typeNote = 'NEWS BULLETIN ROUNDUP: cover EACH story in the material as its own <h2> section of about 130 to 170 words, in order of importance, with a short opening paragraph and a closing "What to watch next" section.';
  else if (slot.type === 'digest') typeNote = `DAILY NEWS DIGEST for ${today}: summarise the day's most important reports as separate <h2> sections (one per report, most important first, about 120 to 170 words each), with a short opening paragraph and a closing "What to watch tomorrow" section. The title must start with "Daily News Digest:" followed by the date and a short hook.`;
  else if (slot.label === 'Untold Story') typeNote = 'UNTOLD STORY: an under-reported human-interest angle, told as a clear narrative using only the facts in the material.';
  else if (slot.label === 'Crime Report') typeNote = 'CRIME REPORT: factual and calm. Describe police and legal steps. Treat all accusations as allegations. No graphic detail.';
  else if (slot.topic === 'Weather') typeNote = 'WEATHER OUTLOOK: use ONLY the forecast figures given. Go city by city, then explain in general terms what the conditions mean for travel, farming, health and daily life. Attribute any warnings to the outlet that reported them. Do not invent warnings.';

  const rules = `1. LENGTH: the body must be between ${minWords + 150} and ${minWords + 450} words. Never fewer than ${minWords}.
2. ORIGINALITY: this is a NEW article. Do not copy sentences or distinctive phrases from the material. Use your own words and your own structure. Never repeat more than 5 words in a row from any source (names, titles and quoted statements excepted).
3. ACCURACY: use only facts that are stated in the SOURCE MATERIAL. Do NOT add any statistic, figure, date, name, place or quotation that is not in the material. If a detail is missing, leave it out. Never guess.
4. ATTRIBUTION: attribute claims to the outlet that reported them ("according to Dawn", "Geo News reported"). If outlets differ, say so.
5. QUOTES: use a direct quotation only if it appears word for word in the material; otherwise use indirect speech.
6. REACHING THE LENGTH WITHOUT INVENTING: explain the situation step by step, who is involved and why it matters to people in Pakistan, give plain widely-known background WITHOUT numbers, set out the different positions, describe possible consequences clearly labelled as possibilities ("this could", "analysts may"), and finish with what to watch next.
7. STRUCTURE: 5 to 7 sections, each starting with an <h2> subheading, with 2 to 4 <p> paragraphs under each. Vary paragraph lengths.
8. HTML: only <h2> and <p> tags. No lists, no bold, no links, no images.
9. STYLE: neutral, factual, calm. No sensational wording. Never use: delve, crucial, pivotal, furthermore, moreover, additionally, in conclusion, navigating, underscore, robust, leverage, multifaceted, groundbreaking, tapestry, landscape, testament, "it is worth noting". No em dashes.
10. No adult content, no hate, no incitement. Report allegations as allegations.
11. FIELDS: "title" = a new headline of your own, under 90 characters. "excerpt" = 2 sentences under 200 characters. "seoTitle" = 50 to 60 characters. "seoDesc" = 135 to 155 characters. "tags" = 4 to 6 short tags. "imageQuery" = 2 to 4 ENGLISH words describing a generic stock photo for this story (no person names, no brand names), e.g. "parliament building". "category" = exactly one of: Politics, Government, Sports, Entertainment, Weather, International, National.`;

  if (mode === 'expand') {
    return `You are a senior editor at Ek Awaz News. The draft article below is too short. Rewrite it into a longer, complete article of at least ${minWords + 200} words.

Add depth ONLY by explaining, connecting and contextualising what is already in the draft and the SOURCE MATERIAL. Do not add new figures, names, dates or quotes. Keep the same JSON fields.
${lang}

RULES:
${rules}

DRAFT (JSON body):
${draft}

SOURCE MATERIAL:
${material.text}

Output ONLY valid JSON, no markdown, no backticks:
{"title":"...","excerpt":"...","body":"<h2>...</h2><p>...</p>","seoTitle":"...","seoDesc":"...","tags":["..."],"imageQuery":"...","category":"..."}`;
  }
  return `You are a senior editor at Ek Awaz News, a trusted Pakistani news publication. Using the SOURCE MATERIAL below as research only, write a completely original article.

TODAY: ${today}
ARTICLE TYPE: ${typeNote}
LANGUAGE: ${lang}

SOURCE MATERIAL:
${material.text}

STRICT RULES:
${rules}

Output ONLY valid JSON, no markdown, no backticks:
{"title":"...","excerpt":"...","body":"<h2>...</h2><p>...</p>","seoTitle":"...","seoDesc":"...","tags":["..."],"imageQuery":"...","category":"..."}`;
}

async function writeArticle({ slot, material, isUrdu }) {
  const minWords = MIN_WORDS[slot.type] || 1000;
  let best = null;
  const check = d => {
    if (!d || typeof d.title !== 'string' || d.title.trim().length < 8) return { ok: false, why: 'no usable title' };
    if (typeof d.body !== 'string' || d.body.length < 400) return { ok: false, why: 'no usable body' };
    const cleaned = cleanAIText(d.body);
    const { body, removed } = G.stripUnsupportedFacts(cleaned, material.text);
    const words = G.wordCount(body);
    const sim = slot.type === 'digest' ? 0 : G.similarity(body, material.text);
    if (sim > MAX_SIMILARITY) return { ok: false, why: `too close to the source wording (${Math.round(sim * 100)}% repeated)` };
    if (!best || words > best.words) best = { data: { ...d, body }, words, removed };
    if (words < minWords) return { ok: false, stop: words >= Math.round(minWords * 0.65), why: `only ${words} words (need ${minWords})${removed ? `, ${removed} unsupported sentence(s) removed` : ''}` };
    d.body = body; d.__words = words; d.__removed = removed;
    return { ok: true };
  };
  const maxTokens = isUrdu ? 14000 : 9000;
  let res = await AI.generateJSON(buildPrompt({ slot, material, isUrdu, minWords }), { maxTokens, validate: check });
  if (res) return { data: res.data, words: res.data.__words, model: res.model, removed: res.data.__removed || 0 };

  // Near miss? ask once for an expanded version of the best draft
  if (best && best.words >= Math.round(minWords * 0.65)) {
    console.log(`  [D] Best draft has ${best.words} words — asking Gemini to expand it...`);
    const draft = JSON.stringify({ title: best.data.title, body: best.data.body });
    res = await AI.generateJSON(buildPrompt({ slot, material, isUrdu, minWords, mode: 'expand', draft }), { maxTokens, validate: check });
    if (res) return { data: res.data, words: res.data.__words, model: res.model, removed: res.data.__removed || 0 };
    if (best.words >= Math.round(minWords * 0.9)) {
      console.log(`  [D] Accepting the best draft (${best.words} words, just under ${minWords}).`);
      return { data: best.data, words: best.words, model: 'best-draft', removed: best.removed };
    }
  }
  return best ? false : null;
}

// ─── CATEGORY DECISION ────────────────────────────────────────
function decideCategories(slot, slotCategory, data, material) {
  if (slot.category) {                                   // Bulletins / Columns / Editorials / special National
    const base = [slot.category];
    return { categories: [...new Set([...base, GENERAL_CATEGORY])], category: slot.category, cat_key: C.catKeyFor(slot.category) };
  }
  let cat = slotCategory;
  const detected = C.detectCategory(data.title, `${data.excerpt || ''} ${G.plain(data.body).slice(0, 700)}`);
  if (['Politics', 'Government', 'International', 'National'].includes(cat) && ['Sports', 'Entertainment', 'Weather'].includes(detected)) cat = detected;
  // "National" means Pakistan: judge that from the SOURCE stories as well as the new text
  const pkStory = C.isPakistanRelated(`${data.title} ${data.excerpt || ''} ${G.plain(data.body).slice(0, 600)}`) || C.isPakistanRelated(String(material.text || '').slice(0, 2500));
  const cls = C.classifyPost({ title: data.title, excerpt: data.excerpt, body: data.body, category: cat, categories: [cat] }, { pakistan: pkStory });
  return cls;
}

// ─── CLEAN AI TEXT ────────────────────────────────────────────
const AI_BANNED = [
  'delve','delves','delving','crucial','pivotal','paramount','imperative',
  'furthermore','moreover','additionally','subsequently',
  'it is worth noting','it is important to note','it is worth mentioning',
  'in conclusion','to conclude','to summarize','in summary',
  'navigating','underscore','underscores','underscored',
  'multifaceted','robust','streamline','leverage','leveraging',
  'in the realm of','landscape','ecosystem','synergy',
  'shed light','sheds light','a testament to',
  'on the other hand','on one hand','at the end of the day',
  'moving forward','game-changer','groundbreaking',
  'in today\'s world','in this day and age','needless to say',
];

const AI_REPLACEMENTS = {
  'furthermore':'also','moreover':'also','additionally':'also',
  'crucial':'important','pivotal':'key','paramount':'vital',
  'robust':'strong','leverage':'use','leveraging':'using',
  'streamline':'simplify','navigating':'dealing with',
  'underscore':'highlight','underscores':'highlights','underscored':'highlighted',
  'multifaceted':'complex','subsequently':'later','groundbreaking':'significant',
};

function cleanAIText(html) {
  let out = String(html || '');
  for (const word of AI_BANNED) {
    const rep = AI_REPLACEMENTS[word.toLowerCase()];
    if (!rep) continue;                                  // never delete a word: that leaves a broken sentence
    out = out.replace(new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'), rep);
  }
  return out.replace(/\s*—\s*/g, ', ').replace(/  +/g, ' ').replace(/ ,/g, ',').replace(/ \./g, '.');
}

// ─── WEATHER WIDGET — Open-Meteo, free, no API key required ──────
const WEATHER_CITIES = [
  { name: 'Karachi',    lat: 24.8607, lon: 67.0011 },
  { name: 'Lahore',     lat: 31.5497, lon: 74.3436 },
  { name: 'Islamabad',  lat: 33.6844, lon: 73.0479 },
  { name: 'Peshawar',   lat: 34.0151, lon: 71.5249 },
  { name: 'Quetta',     lat: 30.1798, lon: 66.9750 },
];

function weatherCodeToLabel(code) {
  if (code === 0) return 'Clear';
  if ([1,2,3].includes(code)) return 'Partly Cloudy';
  if ([45,48].includes(code)) return 'Fog';
  if ([51,53,55,56,57].includes(code)) return 'Drizzle';
  if ([61,63,65,66,67,80,81,82].includes(code)) return 'Rain';
  if ([71,73,75,77,85,86].includes(code)) return 'Snow';
  if ([95,96,99].includes(code)) return 'Thunderstorm';
  return 'Variable';
}

async function buildWeatherWidget() {
  try {
    const rows = [];
    for (const city of WEATHER_CITIES) {
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${city.lat}&longitude=${city.lon}&current_weather=true`;
      const r = await fetch(url, { signal: AbortSignal.timeout(6000) });
      if (!r.ok) continue;
      const d = await r.json();
      const cw = d.current_weather;
      if (!cw) continue;
      rows.push({ name: city.name, temp: Math.round(cw.temperature), label: weatherCodeToLabel(cw.weathercode) });
    }
    if (!rows.length) return null;
    const cellsHtml = rows.map(c => `
      <div class="wx-cell">
        <div class="wx-city">${esc(c.name)}</div>
        <div class="wx-temp">${c.temp}&deg;C</div>
        <div class="wx-cond">${esc(c.label)}</div>
      </div>`).join('');
    return `<div class="widget-box wx-widget">
      <h3 class="widget-title">Pakistan Weather Now</h3>
      <div class="wx-grid">${cellsHtml}</div>
      <p class="widget-note">Live data via Open-Meteo. Updated at publish time.</p>
    </div>`;
  } catch (e) {
    console.log(`  [WIDGET] Weather widget failed: ${e.message}`);
    return null;
  }
}

// ─── FOOTBALL SCOREBOARD — TheSportsDB, free (public test key works) ──
async function buildFootballScoreboard() {
  try {
    const url = `https://www.thesportsdb.com/api/v1/json/${FOOTBALL_API_KEY}/livescore.php?s=Soccer`;
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const d = await r.json();
    const events = d.events || d.livescore || [];
    if (!events.length) return null;
    const rows = events.slice(0, 5).map(e => `
      <div class="sb-row">
        <span>${esc(e.strHomeTeam || e.strHome || '')} ${esc(e.intHomeScore ?? e.strHomeScore ?? '-')}</span>
        <span>vs</span>
        <span>${esc(e.intAwayScore ?? e.strAwayScore ?? '-')} ${esc(e.strAwayTeam || e.strAway || '')}</span>
      </div>`).join('');
    return `<div class="widget-box sb-widget">
      <h3 class="widget-title">Live Football Scores</h3>
      ${rows}
      <p class="widget-note">Live score via TheSportsDB.</p>
    </div>`;
  } catch (e) {
    console.log(`  [WIDGET] Football scoreboard failed: ${e.message}`);
    return null;
  }
}

// Picks whichever live scoreboard is available — cricket first (Pakistan's
// most followed sport), football second, nothing if neither has live data.
async function buildSportsScoreboard() {
  const cricket = await buildCricketScoreboard();
  if (cricket) return cricket;
  console.log('  [WIDGET] No live cricket data — trying football...');
  const football = await buildFootballScoreboard();
  if (football) return football;
  console.log('  [WIDGET] No live cricket or football data — publishing without a scoreboard');
  return null;
}

// ─── CRICKET SCOREBOARD — optional, needs a free key from cricapi.com ──
async function buildCricketScoreboard() {
  if (!CRICAPI_KEY) {
    console.log('  [WIDGET] CRICAPI_KEY not set — skipping live scoreboard');
    return null;
  }
  try {
    const url = `https://api.cricapi.com/v1/currentMatches?apikey=${CRICAPI_KEY}&offset=0`;
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const d = await r.json();
    const matches = (d.data || []).filter(m => /pakistan/i.test(JSON.stringify(m.teams || [])));
    const match = matches[0] || (d.data || [])[0];
    if (!match) return null;
    const teams = (match.teams || []).join(' vs ');
    const scoreRows = (match.score || []).map(s => `<div class="sb-row"><span>${esc(s.inning || '')}</span><span>${esc(String(s.r ?? ''))}/${esc(String(s.w ?? ''))} (${esc(String(s.o ?? ''))} ov)</span></div>`).join('');
    return `<div class="widget-box sb-widget">
      <h3 class="widget-title">Live Scoreboard</h3>
      <div class="sb-teams">${esc(teams)}</div>
      ${scoreRows}
      <div class="sb-status">${esc(match.status || '')}</div>
      <p class="widget-note">Live score via CricAPI.</p>
    </div>`;
  } catch (e) {
    console.log(`  [WIDGET] Cricket scoreboard failed: ${e.message}`);
    return null;
  }
}

// ============================================================
// IMAGES — Pexels (free licence) + Ek Awaz logo
// Order of preference: AI suggested query -> headline words -> category default -> "Pakistan" -> brand image
// ============================================================
function extractKeywords(title) {
  const stop = new Set(['the', 'and', 'for', 'with', 'after', 'over', 'amid', 'says', 'said', 'will', 'has', 'have', 'from', 'into', 'pakistan', 'news']);
  return (title || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 3 && !stop.has(w)).slice(0, 3).join(' ');
}
async function pexels(query, ctx) {
  if (!PEXELS_API_KEY || !query) return null;
  try {
    const r = await fetch(`https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=15&orientation=landscape`, { headers: { Authorization: PEXELS_API_KEY }, signal: AbortSignal.timeout(10000) });
    if (!r.ok) return null;
    const photos = ((await r.json()).photos || []).filter(p => !ctx.usedImages.has(p.id));
    const p = photos[Math.floor(Math.random() * Math.min(photos.length, 6))];
    if (!p) return null;
    ctx.usedImages.add(p.id);
    return { url: p.src.large2x || p.src.large, photographer: p.photographer || 'Pexels' };
  } catch (_) { return null; }
}
async function pickImage(aiQuery, title, category, ctx) {
  const queries = [aiQuery, extractKeywords(title), DEFAULT_IMAGE_QUERY[category], 'Pakistan'].filter(q => q && /^[\x20-\x7E]+$/.test(q));
  for (const q of queries) {
    const photo = await pexels(q, ctx);
    if (!photo) continue;
    console.log(`  [B] Image (Pexels "${q}") by ${photo.photographer}`);
    try { return { url: await processAndUploadImage(photo.url), credit: `Photo: ${photo.photographer} / Pexels` }; }
    catch (e) { console.log(`  [C] Image processing failed: ${e.message}`); return { url: photo.url, credit: `Photo: ${photo.photographer} / Pexels` }; }
  }
  console.log('  [B] No stock photo available — using the Ek Awaz News brand image');
  return { url: `${SITE_URL}/og-image.jpg`, credit: 'Image: Ek Awaz News' };
}
async function processAndUploadImage(imageUrl) {
  const r = await fetch(imageUrl, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`download failed (${r.status})`);
  const buf = Buffer.from(await r.arrayBuffer());
  let img = sharp(buf).resize(1200, 630, { fit: 'cover', position: 'centre' });
  if (fs.existsSync(LOGO_PATH)) {
    const logo = await sharp(LOGO_PATH).resize(104, 104).toBuffer();
    img = img.composite([{ input: logo, left: 18, top: 630 - 104 - 18 }]);
  }
  const out = await img.jpeg({ quality: 80 }).toBuffer();
  if (CLOUDINARY_CLOUD_NAME && CLOUDINARY_UPLOAD_PRESET) {
    try { return await uploadToCloudinary(out); } catch (e) { console.log(`  [C] Cloudinary failed (${e.message}) — saving image in the repo instead`); }
  }
  fs.mkdirSync(IMG_DIR, { recursive: true });
  const name = `${Date.now()}-${Math.floor(Math.random() * 1e4)}.jpg`;
  fs.writeFileSync(path.join(IMG_DIR, name), await sharp(out).resize(1000, 525).jpeg({ quality: 70 }).toBuffer());
  return `${SITE_URL}/news/img/${name}`;
}
async function uploadToCloudinary(buf) {
  const r = await fetch(`https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/upload`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(30000),
    body: JSON.stringify({ file: `data:image/jpeg;base64,${buf.toString('base64')}`, upload_preset: CLOUDINARY_UPLOAD_PRESET, folder: 'ek-awaz-auto' }),
  });
  const d = await r.json();
  if (d.secure_url) return d.secure_url;
  throw new Error('Cloudinary: ' + JSON.stringify(d.error || d).slice(0, 120));
}

// ─── TICKER (the website expects a LIST of strings in ekawaz/main.ticker) ──
async function updateTicker(titles) {
  try {
    const existing = await C.readTicker();
    const merged = [...new Set([...titles.map(t => String(t).slice(0, 110)), ...existing])].slice(0, 20);
    await C.writeTicker(merged);
    console.log(`[TICKER] Updated (${merged.length} items)`);
  } catch (e) { console.log('[TICKER] Skipped:', e.message); }
}

main().catch(e => { console.error('[FATAL]', e.message); console.error(e.stack); process.exit(1); });
