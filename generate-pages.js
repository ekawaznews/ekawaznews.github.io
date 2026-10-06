#!/usr/bin/env node
'use strict';
// ============================================================
// EK AWAZ NEWS — PAGE GENERATOR v10
// Builds /news/<slug>.html for every published post, using the same
// template as autopost.js (lib/page-template.js).
//
// What changed from v9:
//  * No firebase-admin / service account needed (it was missing from
//    package.json, which is why the old job kept failing). Uses the same
//    public key the website uses.
//  * Pages are regenerated when the post CONTENT changes (hash), not by
//    file date (GitHub resets file dates on every checkout, so edits
//    never showed up before).
//  * Old pages made with the previous 6-digit slug become small redirect
//    pages to the new address, so no link breaks and Google sees one URL.
//  * Writes news/slug-index.json and keeps slug/pageUrl in Firestore correct.
// ============================================================
const fs     = require('fs');
const path   = require('path');
const C      = require('./lib/common');
const { renderPage, hashOf, pageHash } = require('./lib/page-template');

const NEWS_DIR = path.join(__dirname, 'news');
const FULL = String(process.env.FULL || '').toLowerCase() === '1' || String(process.env.FULL || '').toLowerCase() === 'yes';

function existingHash(file) {
  try { return pageHash(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}
const redirectStub = target => `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="robots" content="noindex,follow">
<title>Ek Awaz News</title><link rel="canonical" href="${target}"><meta http-equiv="refresh" content="0;url=${target}">
<script>location.replace(${JSON.stringify(target)})</script></head><body><a href="${target}">Continue to the article</a></body></html>
<!-- ea-redirect -->`;

async function main() {
  console.log('════════════════════════════════════════════');
  console.log('   EK AWAZ PAGE GENERATOR v10');
  console.log('════════════════════════════════════════════');
  fs.mkdirSync(NEWS_DIR, { recursive: true });

  console.log(FULL ? 'Mode: FULL (every post)' : 'Mode: RECENT (newest 150 posts; the daily FULL run covers the rest)');
  const all = FULL ? await C.listPosts() : await C.queryRecentPosts(150);
  const posts = all.filter(p => p.title && p.body && (p.status || 'published') === 'published');
  console.log(`Posts read: ${all.length}  |  publishable: ${posts.length}  |  damaged (no title/body): ${all.filter(p => !p.title || !p.body).length}`);
  if (!posts.length) { console.log('Nothing to generate.'); return; }

  const slugIndex = {};
  let created = 0, updated = 0, skipped = 0, redirects = 0, linkFixes = 0, errors = 0;

  for (const post of posts) {
    try {
      const id   = post.id || post.__docId;
      const slug = C.toSlug(post.title, id);
      const file = path.join(NEWS_DIR, `${slug}.html`);
      slugIndex[String(id)] = `/news/${slug}.html`;

      const h = hashOf({ ...post, id });
      const prev = existingHash(file);
      if (prev === h) skipped++;
      else {
        const html = renderPage({ ...post, id });
        const existed = fs.existsSync(file);
        fs.writeFileSync(file, html, 'utf8');
        existed ? updated++ : created++;
      }

      // old-style page (previous slug) -> redirect to the canonical one
      if (post.slug && post.slug !== slug) {
        const oldFile = path.join(NEWS_DIR, `${post.slug}.html`);
        const old = fs.existsSync(oldFile) ? fs.readFileSync(oldFile, 'utf8') : '';
        if (!old.includes('ea-redirect')) {
          fs.writeFileSync(oldFile, redirectStub(`${C.SITE_URL}/news/${slug}.html`), 'utf8');
          redirects++;
        }
      }
      // keep the stored link fields correct (only the two fields — never the whole post)
      const url = `${C.SITE_URL}/news/${slug}.html`;
      if ((post.slug !== slug || post.pageUrl !== url) && linkFixes < 150) {
        await C.patchFields(`ekawaz_posts/${post.__docId}`, { slug, pageUrl: url });
        linkFixes++;
      }
    } catch (e) { errors++; console.log(`  ❌ "${String(post.title).slice(0, 50)}": ${e.message}`); }
  }

  fs.writeFileSync(path.join(NEWS_DIR, 'slug-index.json'), JSON.stringify(slugIndex, null, 2), 'utf8');
  console.log('\n════════════════════════════════════════════');
  console.log(`   ✅ New pages:        ${created}`);
  console.log(`   🔄 Updated pages:    ${updated}`);
  console.log(`   ⏭️  Unchanged:        ${skipped}`);
  console.log(`   ↪️  Redirects made:   ${redirects}`);
  console.log(`   🔗 Link fields fixed: ${linkFixes}`);
  console.log(`   ❌ Errors:           ${errors}`);
  console.log('════════════════════════════════════════════');
  if (errors && errors === posts.length) process.exit(1);
}
main().catch(e => { console.error('💥 Fatal:', e.message); process.exit(1); });
