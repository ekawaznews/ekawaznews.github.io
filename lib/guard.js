'use strict';
// ============================================================
// EK AWAZ NEWS — QUALITY GUARDS
//  * wordCount            : real word count of an HTML body
//  * similarity           : how much of the article is copied from the sources
//  * stripUnsupportedFacts: removes sentences that contain numbers or quotes
//                           that do NOT appear in the source material
// ============================================================
const plain = html => String(html || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;|&amp;|&quot;|&#39;/g, ' ').replace(/\s+/g, ' ').trim();
const wordCount = html => { const t = plain(html); return t ? t.split(' ').length : 0; };
const norm = s => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();

// Share of the article's 6-word sequences that also occur in the source text (0..1)
function similarity(articleHtml, sourceText, n = 6) {
  const a = norm(plain(articleHtml)).split(' ').filter(Boolean);
  const s = norm(sourceText).split(' ').filter(Boolean);
  if (a.length < n || s.length < n) return 0;
  const grams = new Set();
  for (let i = 0; i <= s.length - n; i++) grams.add(s.slice(i, i + n).join(' '));
  let hit = 0, total = 0;
  for (let i = 0; i <= a.length - n; i++) { total++; if (grams.has(a.slice(i, i + n).join(' '))) hit++; }
  return total ? hit / total : 0;
}

const SENT_SPLIT = /(?<=[.!?۔؟])\s+/;
const numTokens = s => (String(s).match(/\d[\d,]*(?:\.\d+)?/g) || []).map(x => x.replace(/,/g, ''));

// Removes every sentence containing a figure or a quotation that is not found in the source material.
function stripUnsupportedFacts(bodyHtml, sourceText) {
  const ctx = String(sourceText || '');
  const ctxNums = new Set(numTokens(ctx));
  const ctxNorm = norm(ctx);
  const thisYear = new Date().getUTCFullYear();
  let removed = 0;
  const unsupported = sentence => {
    for (const n of numTokens(sentence)) {
      const v = parseFloat(n);
      if (!isFinite(v) || (n.indexOf('.') === -1 && v < 10)) continue;           // tiny whole numbers are fine ("3 days")
      if (v >= thisYear - 1 && v <= thisYear + 1 && n.indexOf('.') === -1) continue; // current/adjacent year
      if (!ctxNums.has(n)) return true;
    }
    const quotes = sentence.match(/[“"«]([^”"»]{25,})[”"»]/g) || [];
    for (const q of quotes) {
      const inner = norm(q.slice(1, -1));
      if (inner.split(' ').length >= 5 && !ctxNorm.includes(inner)) return true;
    }
    return false;
  };
  const out = String(bodyHtml || '').replace(/<p>([\s\S]*?)<\/p>/gi, (m, inner) => {
    const kept = inner.split(SENT_SPLIT).filter(s => { const bad = unsupported(s); if (bad) removed++; return !bad; });
    return kept.length ? `<p>${kept.join(' ')}</p>` : '';
  });
  return { body: out, removed };
}

module.exports = { plain, wordCount, similarity, stripUnsupportedFacts };
