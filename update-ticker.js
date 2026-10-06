#!/usr/bin/env node
'use strict';
// ============================================================
// EK AWAZ NEWS — TICKER UPDATER
// Builds the breaking-news ticker from the newest published posts
// and stores it in Firestore (ekawaz/main -> ticker, as a list).
// Runs every 30 minutes from .github/workflows/ticker-update.yml
// Uses only the public web key — no service account, no extra packages.
// ============================================================
const C = require('./lib/common');

async function main() {
  console.log('Ek Awaz ticker updater —', new Date().toISOString());
  const posts = await C.queryRecentPosts(25, ['title', 'status', 'date']);   // 25 reads, not the whole collection
  console.log(`Posts read: ${posts.length}`);

  const items = C.tickerFromPosts(posts, 15);
  if (!items.length) { console.log('No published posts found — ticker left unchanged.'); return; }

  const current = await C.readTicker();
  if (JSON.stringify(current) === JSON.stringify(items)) { console.log('Ticker already up to date — nothing to write.'); return; }

  await C.writeTicker(items);
  console.log(`Ticker updated with ${items.length} headlines:`);
  items.forEach((t, i) => console.log(`  ${i + 1}. ${t}`));
}

main().catch(e => { console.error('[FATAL]', e.message); process.exit(1); });
