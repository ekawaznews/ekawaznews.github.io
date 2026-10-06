#!/usr/bin/env node
'use strict';
// ============================================================
// EK AWAZ NEWS — CATEGORY CLEANUP (the ONLY script that changes categories)
// Safe to run any time (it only changes posts that are wrong):
//  * every post gets a `categories` array that includes "Home / General"
//  * old/invalid names (Crime, Economy, Education...) -> real site categories
//  * "National" is kept only for Pakistan stories; world news -> International
// Options (environment): DRY_RUN=yes  -> only show what would change
// ============================================================
const C = require('./lib/common');
const DRY = String(process.env.DRY_RUN || '').toLowerCase() === 'yes';
const same = (a, b) => Array.isArray(a) && a.length === b.length && a.every((x, i) => x === b[i]);

async function main() {
  console.log(`Ek Awaz category cleanup${DRY ? ' (DRY RUN — nothing will be written)' : ''}`);
  const posts = await C.listPosts();
  console.log(`Posts read: ${posts.length}`);

  let fixed = 0, ok = 0, broken = 0, failed = 0;
  for (const post of posts) {
    if (!post.title) { broken++; continue; }                 // damaged doc (no title) — handled by fix-existing-posts
    const want = C.classifyPost(post);
    const isOk = same(post.categories, want.categories) && post.category === want.category && post.cat_key === want.cat_key;
    if (isOk) { ok++; continue; }

    console.log(`${DRY ? 'WOULD FIX' : 'Fix'}: "${post.title.slice(0, 55)}"  ${post.category || '-'} -> ${want.categories.join(', ')}`);
    if (DRY) { fixed++; continue; }
    try {
      await C.patchFields(`ekawaz_posts/${post.__docId}`, { categories: want.categories, category: want.category, cat_key: want.cat_key });
      fixed++;
    } catch (e) { failed++; console.log(`  FAILED: ${e.message}`); }
    await C.sleep(150);
  }
  console.log(`\nDone. ${fixed} ${DRY ? 'would be ' : ''}fixed, ${ok} already correct, ${broken} damaged (no title), ${failed} failed.`);
  if (failed) process.exit(1);
}
main().catch(e => { console.error('[FATAL]', e.message); process.exit(1); });
