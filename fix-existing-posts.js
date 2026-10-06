#!/usr/bin/env node
'use strict';
// ============================================================
// EK AWAZ NEWS — FIX EXISTING POSTS (v3)
// Safe by default: it only fixes the author name, the page link fields
// and reports problems. Risky actions are OFF unless you switch them on.
//
// Options (environment, set from the GitHub "Run workflow" form):
//   DRY_RUN=yes            show what would change, write nothing
//   DELETE_DUPLICATES=yes  delete posts that repeat the same story (keeps the oldest)
//   DELETE_BROKEN=yes      delete damaged docs that have no title/body
//   REWRITE_SHORT=yes      rewrite very short articles with the AI (uses tokens)
//   MAX_REWRITES=20        cap on rewrites per run (protects your token budget)
// Categories are NOT touched here — use fix-categories.js for that.
// ============================================================
const C  = require('./lib/common');
const AI = require('./lib/ai');
const yes = n => String(process.env[n] || '').toLowerCase() === 'yes';
const DRY = yes('DRY_RUN'), DEL_DUPES = yes('DELETE_DUPLICATES'), DEL_BROKEN = yes('DELETE_BROKEN'), REWRITE = yes('REWRITE_SHORT');
const MAX_REWRITES = parseInt(process.env.MAX_REWRITES || '20', 10);

const words = t => (t || '').toLowerCase().replace(/[^a-z0-9\u0600-\u06ff\s]/g, ' ').split(/\s+/).filter(w => w.length > 4);
const plain = h => String(h || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

async function rewriteBody(post) {
  const prompt = `You are a senior journalist at Ek Awaz News, a Pakistani news publication.
Expand this short news item into a full article of 700 to 900 words.

HEADLINE: ${post.title}
SUMMARY: ${post.excerpt || plain(post.body).slice(0, 500)}

RULES:
1. Use only facts that are in the headline and summary. Do NOT invent statistics, quotes, names or dates.
2. Where facts are thin, add neutral background and context instead of inventing details.
3. HTML body using ONLY <p> and <h2> tags. No lists. No em dashes.
4. First sentence states the core news fact. Professional, factual Pakistani newsroom tone.
5. ${post.lang === 'ur' ? 'Write the entire article in Urdu.' : 'Write in English.'}

Output ONLY valid JSON: {"title":"${String(post.title).replace(/"/g, '\\"')}","body":"<p>...</p>"}`;
  const r = await AI.generateJSON(prompt, {
    maxTokens: post.lang === 'ur' ? 6000 : 3500,
    validate: d => typeof d.body === 'string' && plain(d.body).length >= 1800,
  });
  return r ? r.data.body : null;
}

async function main() {
  console.log(`Ek Awaz — fix existing posts${DRY ? ' (DRY RUN)' : ''}`);
  console.log(`Options: deleteDuplicates=${DEL_DUPES} deleteBroken=${DEL_BROKEN} rewriteShort=${REWRITE}`);
  const all = await C.listPosts();
  console.log(`Posts read: ${all.length}\n`);

  // 1) damaged docs (no title) — caused by the old view-counter bug that overwrote whole posts
  const broken = all.filter(p => !p.title || !p.body);
  const good   = all.filter(p => p.title && p.body);
  if (broken.length) {
    console.log(`⚠ ${broken.length} damaged post document(s) with no title/body. Ids: ${broken.slice(0, 20).map(p => p.__docId).join(', ')}${broken.length > 20 ? ' ...' : ''}`);
    if (DEL_BROKEN && !DRY) { for (const b of broken) { await C.deleteDocument(`ekawaz_posts/${b.__docId}`); await C.sleep(150); } console.log(`  deleted ${broken.length} damaged docs`); }
    else console.log('  (not deleted — run again with DELETE_BROKEN=yes to remove them)');
  }

  // 2) duplicates (same story published twice) — keep the OLDEST
  const sorted = [...good].sort((a, b) => new Date(a.date) - new Date(b.date));
  const kept = [], dupes = [];
  for (const p of sorted) {
    const w = words(p.title);
    const dup = kept.find(k => { const kw = words(k.title); const m = w.filter(x => kw.includes(x)).length; return w.length >= 4 && m >= Math.max(5, Math.ceil(w.length * 0.7)); });
    if (dup) dupes.push({ p, of: dup }); else kept.push(p);
  }
  if (dupes.length) {
    console.log(`\n${dupes.length} likely duplicate(s):`);
    dupes.slice(0, 30).forEach(d => console.log(`  "${d.p.title.slice(0, 60)}"  ≈  "${d.of.title.slice(0, 60)}"`));
    if (DEL_DUPES && !DRY) { for (const d of dupes) { await C.deleteDocument(`ekawaz_posts/${d.p.__docId}`); await C.sleep(150); } console.log(`  deleted ${dupes.length} duplicates`); }
    else console.log('  (not deleted — run again with DELETE_DUPLICATES=yes to remove them)');
  }
  const dupeIds = new Set(DEL_DUPES && !DRY ? dupes.map(d => d.p.__docId) : []);

  // 3) per-post fixes: author, slug/pageUrl, default counters, optional rewrite
  let authorFixed = 0, linkFixed = 0, rewritten = 0, failed = 0;
  for (const p of good) {
    if (dupeIds.has(p.__docId)) continue;
    const fix = {};
    if (p.author !== C.AUTHOR) fix.author = C.AUTHOR;
    const slug = C.toSlug(p.title, p.id || p.__docId);
    const pageUrl = `${C.SITE_URL}/news/${slug}.html`;
    if (p.slug !== slug)       fix.slug = slug;
    if (p.pageUrl !== pageUrl) fix.pageUrl = pageUrl;
    if (p.status === undefined || p.status === null || p.status === '') fix.status = 'published';
    if (typeof p.views !== 'number') fix.views = 0;
    if (typeof p.likes !== 'number') fix.likes = 0;

    if (REWRITE && !AI.hasKeys()) { console.log('REWRITE_SHORT needs GEMINI_API_KEY — skipping rewrites'); }
    if (REWRITE && AI.hasKeys() && rewritten < MAX_REWRITES && plain(p.body).length < 1200) {
      console.log(`Rewriting short article (${plain(p.body).length} chars): "${p.title.slice(0, 55)}"`);
      const nb = DRY ? null : await rewriteBody(p);
      if (nb) { fix.body = nb; fix.updatedAt = new Date().toISOString(); rewritten++; }
    }
    if (!Object.keys(fix).length) continue;
    if (fix.author) authorFixed++;
    if (fix.slug || fix.pageUrl) linkFixed++;
    if (DRY) continue;
    try { await C.patchFields(`ekawaz_posts/${p.__docId}`, fix); } catch (e) { failed++; console.log(`  FAILED ${p.__docId}: ${e.message}`); }
    await C.sleep(150);
  }

  console.log('\n════════ SUMMARY ════════');
  console.log(`Damaged docs found:   ${broken.length}`);
  console.log(`Duplicates found:     ${dupes.length}`);
  console.log(`Author names fixed:   ${authorFixed}`);
  console.log(`Page links fixed:     ${linkFixed}`);
  console.log(`Articles rewritten:   ${rewritten}`);
  console.log(`Failed updates:       ${failed}`);
  if (failed) process.exit(1);
}
main().catch(e => { console.error('[FATAL]', e.message); process.exit(1); });
