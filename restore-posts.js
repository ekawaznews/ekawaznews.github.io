#!/usr/bin/env node
'use strict';
// ============================================================
// EK AWAZ NEWS — RESTORE POSTS FROM A BACKUP
// Usage:  node restore-posts.js backups/posts-2026-10-04.json.gz
// Only RE-CREATES posts that are missing (or damaged) in Firestore.
// It never overwrites a healthy post. Add DRY_RUN=yes to preview.
// ============================================================
const fs = require('fs');
const zlib = require('zlib');
const C = require('./lib/common');
const DRY = String(process.env.DRY_RUN || '').toLowerCase() === 'yes';

async function main() {
  const file = process.argv[2];
  if (!file || !fs.existsSync(file)) { console.error('Usage: node restore-posts.js backups/posts-YYYY-MM-DD.json.gz'); process.exit(1); }
  const raw = fs.readFileSync(file);
  const backup = JSON.parse((file.endsWith('.gz') ? zlib.gunzipSync(raw) : raw).toString('utf8'));
  console.log(`Backup holds ${backup.length} posts`);
  const live = new Map((await C.listPosts()).map(p => [p.__docId, p]));
  let restored = 0, healthy = 0;
  for (const b of backup) {
    const { __docId, ...post } = b;
    const now = live.get(__docId);
    if (now && now.title && now.body) { healthy++; continue; }
    console.log(`${DRY ? 'WOULD RESTORE' : 'Restoring'}: ${String(post.title).slice(0, 70)}`);
    if (!DRY) { await C.savePost({ ...post, id: post.id || Number(__docId) }); await C.sleep(150); }
    restored++;
  }
  console.log(`\nDone. ${restored} ${DRY ? 'would be ' : ''}restored, ${healthy} already healthy.`);
}
main().catch(e => { console.error('[FATAL]', e.message); process.exit(1); });
