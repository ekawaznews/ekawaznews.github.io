#!/usr/bin/env node
'use strict';
// ============================================================
// EK AWAZ NEWS — SITEMAP GENERATOR
// Writes sitemap.xml (everything) and news-sitemap.xml (last 2 days,
// for Google News). Uses the shared slug function, so the sitemap
// always matches the real page URLs.
// ============================================================
const fs = require('fs');
const C  = require('./lib/common');
const SITE = C.SITE_URL;
const x = s => C.esc(s);
const isoDay = d => new Date(d).toISOString().slice(0, 10);

async function main() {
  const all = await C.listPosts(['id', 'title', 'date', 'category', 'status']);
  const posts = all.filter(p => p.title && (p.status || 'published') === 'published')
    .map(p => ({ title: p.title, id: p.id || p.__docId, date: p.date || new Date().toISOString(), cat: p.category || 'National' }))
    .sort((a, b) => new Date(b.date) - new Date(a.date));
  console.log(`Published posts: ${posts.length}`);

  const recent = posts.filter(p => Date.now() - new Date(p.date).getTime() < 2 * 24 * 3600 * 1000);
  const news = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">
${recent.map(p => `  <url>
    <loc>${SITE}/news/${C.toSlug(p.title, p.id)}.html</loc>
    <news:news>
      <news:publication><news:name>${C.SITE_NAME}</news:name><news:language>en</news:language></news:publication>
      <news:publication_date>${new Date(p.date).toISOString()}</news:publication_date>
      <news:title>${x(p.title)}</news:title>
    </news:news>
  </url>`).join('\n')}
</urlset>
`;
  fs.writeFileSync('news-sitemap.xml', news, 'utf8');

  const today = isoDay(Date.now());
  const statics = [['/', 'hourly', '1.0'], ['/about.html', 'monthly', '0.6'], ['/contact.html', 'monthly', '0.6'], ['/privacy.html', 'monthly', '0.4']];
  const cats = ['politics', 'government', 'sports', 'entertainment', 'weather', 'international', 'national', 'editorials', 'columns', 'bulletins'];
  const full = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${statics.map(([u, f, p]) => `  <url><loc>${SITE}${u}</loc><lastmod>${today}</lastmod><changefreq>${f}</changefreq><priority>${p}</priority></url>`).join('\n')}
${cats.map(c => `  <url><loc>${SITE}/?cat=${c}</loc><lastmod>${today}</lastmod><changefreq>daily</changefreq><priority>0.7</priority></url>`).join('\n')}
${posts.map(p => `  <url><loc>${SITE}/news/${C.toSlug(p.title, p.id)}.html</loc><lastmod>${isoDay(p.date)}</lastmod><changefreq>weekly</changefreq><priority>0.8</priority></url>`).join('\n')}
</urlset>
`;
  fs.writeFileSync('sitemap.xml', full, 'utf8');
  console.log(`sitemap.xml: ${statics.length + cats.length + posts.length} URLs | news-sitemap.xml: ${recent.length} recent`);
}
main().catch(e => { console.error('[FATAL]', e.message); process.exit(1); });
