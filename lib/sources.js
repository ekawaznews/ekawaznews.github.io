'use strict';
// ============================================================
// EK AWAZ NEWS — NEWS SOURCES (inspiration only, never copied)
// Geo News, Dawn, The News, Samaa, ARY News, Hum News, Fox News,
// Al Jazeera, BBC, BBC Urdu, Arab News (+ Google News as a backup finder).
//
// What happens here:
//   1. Every feed is fetched ONCE per run (a dead feed is just skipped).
//   2. Stories are grouped, so a story reported by several outlets gets
//      more weight and the AI receives all of their versions to cross-check.
//   3. The full article text is read when the site allows it, so the AI
//      has real facts to work from (not just a headline).
// The AI then writes a NEW article; guards (lib/guard.js) check it.
// ============================================================
const Parser = require('rss-parser');
const C = require('./common');
const { sleep } = C;

const UA = 'Mozilla/5.0 (compatible; EkAwazNewsBot/1.0; +https://ekawaznews.github.io)';
const BBC = 'https://feeds.bbci.co.uk';
const FOX = 'https://moxie.foxnews.com/google-publisher';

// section: general | politics | sports | entertainment | business | world | urdu
const FEEDS = [
  { src: 'Dawn',       host: 'dawn.com',        pk: true,  url: 'https://www.dawn.com/feeds/home',          section: 'general' },
  { src: 'Dawn',       host: 'dawn.com',        pk: true,  url: 'https://www.dawn.com/feeds/sport',         section: 'sports' },
  { src: 'Dawn',       host: 'dawn.com',        pk: true,  url: 'https://www.dawn.com/feeds/business',      section: 'business' },
  { src: 'Dawn',       host: 'dawn.com',        pk: true,  url: 'https://www.dawn.com/feeds/entertainment', section: 'entertainment' },
  { src: 'Dawn',       host: 'dawn.com',        pk: true,  url: 'https://www.dawn.com/feeds/world',         section: 'world' },
  { src: 'The News',   host: 'thenews.com.pk',  pk: true,  url: 'https://www.thenews.com.pk/rss/1/1',       section: 'general' },
  { src: 'Geo News',   host: 'geo.tv',          pk: true,  url: 'https://www.geo.tv/rss/1',                 section: 'general' },
  { src: 'ARY News',   host: 'arynews.tv',      pk: true,  url: 'https://arynews.tv/feed/',                 section: 'general' },
  { src: 'Samaa',      host: 'samaa.tv',        pk: true,  url: 'https://www.samaa.tv/feed',                section: 'general' },
  { src: 'Hum News',   host: 'humnews.pk',      pk: true,  url: 'https://humnews.pk/feed/',                 section: 'general' },
  { src: 'BBC News',   host: 'bbc.co.uk',       pk: false, url: `${BBC}/news/world/rss.xml`,                section: 'world' },
  { src: 'BBC News',   host: 'bbc.co.uk',       pk: false, url: `${BBC}/news/world/asia/rss.xml`,           section: 'world' },
  { src: 'BBC News',   host: 'bbc.co.uk',       pk: false, url: `${BBC}/news/politics/rss.xml`,             section: 'politics' },
  { src: 'BBC Sport',  host: 'bbc.co.uk',       pk: false, url: `${BBC}/sport/rss.xml`,                     section: 'sports' },
  { src: 'BBC News',   host: 'bbc.co.uk',       pk: false, url: `${BBC}/news/entertainment_and_arts/rss.xml`, section: 'entertainment' },
  { src: 'BBC Urdu',   host: 'bbc.co.uk',       pk: true,  url: `${BBC}/urdu/rss.xml`,                      section: 'urdu', lang: 'ur' },
  { src: 'Al Jazeera', host: 'aljazeera.com',   pk: false, url: 'https://www.aljazeera.com/xml/rss/all.xml', section: 'world' },
  { src: 'Arab News',  host: 'arabnews.com',    pk: false, url: 'https://www.arabnews.com/rss.xml',         section: 'world' },
  { src: 'Fox News',   host: 'foxnews.com',     pk: false, url: `${FOX}/world.xml`,                         section: 'world' },
  { src: 'Fox News',   host: 'foxnews.com',     pk: false, url: `${FOX}/politics.xml`,                      section: 'politics' },
  { src: 'Fox News',   host: 'foxnews.com',     pk: false, url: `${FOX}/sports.xml`,                        section: 'sports' },
];

// Backup finder: Google News searches restricted to each outlet (used for headlines / cross-checking,
// and as the base story only when no direct feed gave anything)
const GN = q => `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-PK&gl=PK&ceid=PK:en`;
const GN_FEEDS = [
  { src: 'Google News (Pakistan outlets)', host: 'news.google.com', pk: true,  weak: true, section: 'general', url: GN('Pakistan when:1d (site:geo.tv OR site:dawn.com OR site:samaa.tv OR site:arynews.tv OR site:humnews.pk OR site:thenews.com.pk)') },
  { src: 'Google News (Pakistan sports)',  host: 'news.google.com', pk: true,  weak: true, section: 'sports',  url: GN('Pakistan cricket OR PSL OR hockey when:1d (site:geo.tv OR site:dawn.com OR site:samaa.tv OR site:arynews.tv OR site:humnews.pk)') },
  { src: 'Google News (Pakistan weather)', host: 'news.google.com', pk: true,  weak: true, section: 'general', url: GN('Pakistan weather OR rain OR flood OR heatwave PMD when:2d (site:geo.tv OR site:dawn.com OR site:samaa.tv OR site:arynews.tv)') },
  { src: 'Google News (world outlets)',    host: 'news.google.com', pk: false, weak: true, section: 'world',   url: GN('world when:1d (site:bbc.com OR site:aljazeera.com OR site:arabnews.com OR site:foxnews.com)') },
  { src: 'Google News (Urdu)',             host: 'news.google.com', pk: true,  weak: true, section: 'urdu', lang: 'ur', url: 'https://news.google.com/rss/search?q=' + encodeURIComponent('پاکستان when:1d') + '&hl=ur&gl=PK&ceid=PK:ur' },
];

const STOP = new Set('about after again also amid among been being between could during from have into more most over said says that their them then there these they this those under were what when where which while will with would your pakistan pakistani news report reports'.split(' '));
const sigWords = t => [...new Set(String(t || '').toLowerCase().replace(/ - [^-]{2,30}$/, '').replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(w => w.length >= 4 && !STOP.has(w)))];
const stripHtml = h => String(h || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ').trim();

// ─── FETCH ALL FEEDS ONCE ─────────────────────────────────────
async function gatherPool({ maxAgeHours = 40 } = {}) {
  const parser = new Parser({ timeout: 15000, headers: { 'User-Agent': UA, Accept: 'application/rss+xml, application/xml, text/xml, */*' },
    customFields: { item: [['media:content', 'media'], ['content:encoded', 'contentEncoded']] } });
  const all = [...FEEDS, ...GN_FEEDS];
  const items = []; const okFeeds = []; const badFeeds = [];
  let idx = 0;
  const worker = async () => {
    while (idx < all.length) {
      const f = all[idx++];
      try {
        const feed = await parser.parseURL(f.url);
        let n = 0;
        for (const it of feed.items || []) {
          const title = stripHtml(it.title || '').replace(/ - [^-]{2,40}$/, '').trim();
          if (!title || !it.link) continue;
          const t = it.isoDate || it.pubDate; const ts = t ? new Date(t).getTime() : Date.now();
          if (isFinite(ts) && Date.now() - ts > maxAgeHours * 3600 * 1000) continue;
          let src = f.src;
          if (f.weak) { const m = String(it.title || '').match(/ - ([^-]{2,40})$/); if (m) src = m[1].trim(); }
          const summary = stripHtml(it.contentSnippet || it.summary || it.contentEncoded || it.content || '').slice(0, 900);
          items.push({ title, summary: summary === title ? '' : summary, link: it.link, src, host: f.host, pk: f.pk, weak: !!f.weak, section: f.section, lang: f.lang || 'en', ts: isFinite(ts) ? ts : Date.now() });
          n++;
        }
        okFeeds.push(`${f.src} (${f.section}): ${n}`);
      } catch (e) { badFeeds.push(`${f.src} (${f.section}): ${String(e.message).slice(0, 60)}`); }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  // de-duplicate identical links
  const seen = new Set(); const pool = [];
  for (const it of items) { const k = it.link.split('?')[0]; if (seen.has(k)) continue; seen.add(k); it.words = sigWords(it.title); pool.push(it); }
  return { pool, okFeeds, badFeeds };
}

// ─── CATEGORY LOGIC FOR A STORY ───────────────────────────────
function itemCategory(it) {
  const txt = `${it.title} ${it.summary}`;
  if (it.section === 'sports') return 'Sports';
  if (it.section === 'entertainment') return 'Entertainment';
  return C.detectCategory(it.title, it.summary);
}
const textOf = it => `${it.title} ${it.summary}`.toLowerCase();
const TOPIC_TEST = {
  Politics:      it => itemCategory(it) === 'Politics' && C.isPakistanRelated(textOf(it)),
  Government:    it => ['Government', 'Politics'].includes(itemCategory(it)) && C.isPakistanRelated(textOf(it)),
  Sports:        it => itemCategory(it) === 'Sports',
  International: it => ['International', 'Politics', 'Government'].includes(itemCategory(it)) && !C.isPakistanRelated(`${it.title} ${it.summary}`),
  Entertainment: it => itemCategory(it) === 'Entertainment',
  Economy:       it => C.anyWord(textOf(it), C.KW.economy) && C.isPakistanRelated(textOf(it)),
  Education:     it => C.anyWord(textOf(it), C.KW.education) && C.isPakistanRelated(textOf(it)),
  Crime:         it => C.anyWord(textOf(it), C.KW.crime) && C.isPakistanRelated(textOf(it)),
  Social:        it => C.anyWord(textOf(it), C.KW.social) && C.isPakistanRelated(textOf(it)),
  Weather:       it => C.anyWord(textOf(it), C.KW.weather) && C.isPakistanRelated(textOf(it)),
  Urdu:          it => it.lang === 'ur' && C.isPakistanRelated(`${it.title} ${it.summary}`),
  National:      it => C.isPakistanRelated(`${it.title} ${it.summary}`),
  Any:           () => true,
};

// ─── GROUPING (same story from several outlets) ───────────────
function related(it, pool, max = 3) {
  const out = [];
  for (const o of pool) {
    if (o === it || o.src === it.src) continue;
    const shared = it.words.filter(w => o.words.includes(w)).length;
    if (shared >= 3 && shared / Math.min(it.words.length, o.words.length) >= 0.4) out.push(o);
  }
  const seen = new Set();
  return out.filter(o => !seen.has(o.src) && seen.add(o.src)).slice(0, max);
}
function scoreItem(it, pool) {
  const rel = related(it, pool, 6).length;
  const ageH = (Date.now() - it.ts) / 3600000;
  return rel * 3 + Math.max(0, 6 - ageH / 4) + (it.summary.length > 160 ? 1.5 : 0) + (it.weak ? -4 : 0) + (C.isPakistanRelated(textOf(it)) ? 1 : 0);
}

// candidates for a slot, best first. `exclude(it)` removes used / already-published stories.
function pickCandidates(pool, topic, exclude = () => false, strict = true) {
  const test = TOPIC_TEST[topic] || TOPIC_TEST.Any;
  let list = pool.filter(it => !exclude(it) && test(it));
  if (!list.length && !strict) list = pool.filter(it => !exclude(it));
  return list.map(it => ({ it, s: scoreItem(it, pool) })).sort((a, b) => b.s - a.s).map(x => x.it);
}

// ─── READ THE FULL ARTICLE (when the site allows it) ──────────
function extractText(html) {
  let h = String(html || '').replace(/<(script|style|noscript|svg|nav|header|footer|aside|form|figure|iframe)[\s\S]*?<\/\1>/gi, ' ');
  const art = h.match(/<article[\s\S]*?<\/article>/i);
  if (art && art[0].length > 800) h = art[0];
  const paras = [];
  for (const m of h.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)) {
    const t = stripHtml(m[1]);
    if (t.length < 55) continue;
    if (/cookie|subscribe|newsletter|sign up|all rights reserved|follow us|advertis|click here|read more:|also read/i.test(t)) continue;
    paras.push(t);
  }
  return paras.join('\n').slice(0, 7000);
}
async function fetchArticleText(link) {
  try {
    const r = await fetch(link, { redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36', 'Accept-Language': 'en,ur;q=0.8' }, signal: AbortSignal.timeout(14000) });
    if (!r.ok) return { text: '', finalUrl: r.url };
    if (/news\.google\.com/.test(new URL(r.url).hostname)) return { text: '', finalUrl: r.url };   // unresolved Google redirect
    const html = await r.text();
    return { text: extractText(html), finalUrl: r.url };
  } catch (_) { return { text: '', finalUrl: link }; }
}

// Builds everything the AI may use for one story: main item + other outlets' versions + (if possible) full text.
async function buildMaterial(it, pool) {
  const rel = related(it, pool, 3);
  const main = await fetchArticleText(it.link);
  const parts = []; const credits = [];
  const add = (item, text, idx) => {
    parts.push(`SOURCE ${idx} — ${item.src}\nHEADLINE: ${item.title}\nSUMMARY: ${item.summary || '(none)'}${text ? `\nARTICLE TEXT:\n${text}` : ''}`);
  };
  add(it, main.text, 1); credits.push({ name: it.src, url: main.finalUrl && !/news\.google\.com/.test(main.finalUrl) ? main.finalUrl : (it.weak ? '' : it.link) });
  let n = 2;
  for (const r of rel) { add(r, '', n++); credits.push({ name: r.src, url: r.weak ? '' : r.link }); }
  const text = parts.join('\n\n---\n\n');
  const facts = (main.text.length) + parts.join('').length;
  return { text, credits, groundedChars: main.text.length, totalChars: facts, mainUrl: credits[0].url };
}

// ─── REAL WEATHER DATA (Open-Meteo, free, no key) ─────────────
const WX_CITIES = [
  ['Karachi', 24.8607, 67.0011], ['Lahore', 31.5497, 74.3436], ['Islamabad', 33.6844, 73.0479],
  ['Peshawar', 34.0151, 71.5249], ['Quetta', 30.1798, 66.9750], ['Multan', 30.1575, 71.5249], ['Gilgit', 35.9208, 74.3080],
];
const wxLabel = c => c === 0 ? 'clear' : [1, 2, 3].includes(c) ? 'partly cloudy' : [45, 48].includes(c) ? 'fog' : [51, 53, 55, 56, 57].includes(c) ? 'drizzle'
  : [61, 63, 65, 66, 67, 80, 81, 82].includes(c) ? 'rain' : [71, 73, 75, 77, 85, 86].includes(c) ? 'snow' : [95, 96, 99].includes(c) ? 'thunderstorm' : 'variable';
async function weatherMaterial() {
  const lines = [];
  for (const [name, lat, lon] of WX_CITIES) {
    try {
      const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weathercode&timezone=Asia%2FKarachi&forecast_days=4`, { signal: AbortSignal.timeout(9000) });
      if (!r.ok) continue;
      const d = (await r.json()).daily; if (!d || !d.time) continue;
      lines.push(`${name}:\n` + d.time.map((day, i) => `  ${day}: high ${Math.round(d.temperature_2m_max[i])}°C, low ${Math.round(d.temperature_2m_min[i])}°C, ${wxLabel(d.weathercode[i])}, chance of rain ${d.precipitation_probability_max?.[i] ?? 0}%`).join('\n'));
    } catch (_) {}
  }
  return lines.length >= 3 ? `OFFICIAL-STYLE FORECAST DATA (Open-Meteo, next 4 days, Pakistan Standard Time):\n${lines.join('\n')}` : '';
}

module.exports = { FEEDS, GN_FEEDS, gatherPool, pickCandidates, related, buildMaterial, itemCategory, weatherMaterial, fetchArticleText, TOPIC_TEST, sigWords };
