#!/usr/bin/env node
'use strict';
// ============================================================
// EK AWAZ NEWS — BACKUP OF ALL POSTS
// Saves every post from Firestore into backups/posts-YYYY-MM-DD.json.gz
// (weekly, from .github/workflows/backup-posts.yml). Keeps the newest 6 copies.
// If posts are ever lost or damaged, restore them with restore-posts.js
// ============================================================
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const C = require('./lib/common');

async function main() {
  const posts = (await C.listPosts()).filter(p => p.title);          // skip damaged docs with no title
  console.log(`Posts read: ${posts.length}`);
  if (!posts.length) { console.log('Nothing to back up.'); return; }
  const clean = posts.map(p => { const { __docId, __name, ...rest } = p; return { __docId, ...rest }; });
  const dir = path.join(__dirname, 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `posts-${new Date().toISOString().slice(0, 10)}.json.gz`);
  fs.writeFileSync(file, zlib.gzipSync(Buffer.from(JSON.stringify(clean))));
  console.log(`Saved ${path.relative(__dirname, file)} (${(fs.statSync(file).size / 1024).toFixed(0)} KB)`);
  const old = fs.readdirSync(dir).filter(n => /^posts-\d{4}-\d{2}-\d{2}\.json\.gz$/.test(n)).sort().reverse().slice(6);
  old.forEach(n => { fs.unlinkSync(path.join(dir, n)); console.log(`Removed old backup ${n}`); });
}
main().catch(e => { console.error('[FATAL]', e.message); process.exit(1); });
