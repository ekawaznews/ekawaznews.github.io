'use strict';
// ============================================================
// EK AWAZ NEWS — AI LAYER (Gemini only)
//
// Backups built in, so one failure does not stop publishing:
//  1. Several API keys: GEMINI_API_KEY, GEMINI_API_KEY_2, GEMINI_API_KEY_3 ...
//     (keys from DIFFERENT Google projects each have their own quota;
//      extra keys in the SAME project share one quota).
//  2. Several models per key. The model list is read from Google at run
//     time, so renamed/retired models do not break the script. Each model
//     has its own daily quota, so when one is used up the next one takes over.
//  3. Smart error handling: daily quota used up -> skip that model for the
//     rest of the run; per-minute limit -> wait the time Google asks for and
//     retry; overloaded (503) -> retry; blocked/empty/garbage -> next model.
//  4. An answer only counts when it parses AND passes the caller's checks
//     (length, valid JSON...).
// ============================================================
const { sleep } = require('./common');

const KEYS = ['GEMINI_API_KEY', 'GEMINI_API_KEY_2', 'GEMINI_API_KEY_3', 'GEMINI_API_KEY_4']
  .map((n, i) => ({ name: n, key: (process.env[n] || '').trim(), idx: i + 1 }))
  .filter(k => k.key);
const API = 'https://generativelanguage.googleapis.com/v1beta';
const FALLBACK_MODELS = ['gemini-3.5-flash-lite', 'gemini-3.5-flash', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'];
const MIN_GAP_MS = parseInt(process.env.GEMINI_MIN_GAP_MS || '7000', 10);   // keeps us under the free per-minute limit

const deadKey   = new Map();    // key name -> reason (bad key / no access)
const deadModel = new Set();    // "keyName|model" used up or not available this run
const modelList = new Map();    // key name -> [models]
let lastCall = 0;
const stats = { calls: 0, ok: 0, byModel: {} };

async function http(url, opts = {}, timeoutMs = 120000) {
  const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(timeoutMs) });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch (_) {}
  return { ok: r.ok, status: r.status, json, text };
}

const verNum = n => parseFloat((String(n).match(/gemini-(\d+(?:\.\d+)?)/) || [0, 0])[1]);
async function listModels(k) {
  if (modelList.has(k.name)) return modelList.get(k.name);
  let names = [];
  try {
    const r = await http(`${API}/models?pageSize=200`, { headers: { 'x-goog-api-key': k.key } }, 20000);
    if (r.status === 400 || r.status === 401 || r.status === 403) {
      deadKey.set(k.name, `HTTP ${r.status}: ${(r.json?.error?.message || r.text).slice(0, 120)}`);
      console.log(`  [AI] ${k.name} rejected by Google (${deadKey.get(k.name)})`);
      modelList.set(k.name, []); return [];
    }
    names = (r.json?.models || [])
      .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map(m => m.name.replace(/^models\//, ''))
      .filter(n => /^gemini-\d+(\.\d+)?-flash(-lite)?(-\d+)?$/i.test(n) && !/image|tts|live|audio|embed|robotics|computer|thinking|exp/i.test(n));
  } catch (e) { console.log(`  [AI] could not list models for ${k.name}: ${e.message}`); }
  const flash = names.filter(n => !/lite/i.test(n)).sort((a, b) => verNum(b) - verNum(a)).slice(0, 3);
  const lite  = names.filter(n =>  /lite/i.test(n)).sort((a, b) => verNum(b) - verNum(a)).slice(0, 2);
  // Quality Flash models first (small daily quota each), Flash-Lite after (large daily quota)
  let list = [...flash, ...lite];
  if (!list.length) list = FALLBACK_MODELS;
  modelList.set(k.name, list);
  console.log(`  [AI] ${k.name} models: ${list.join(', ')}`);
  return list;
}

function retryAfterMs(r) {
  const m = (r.text || '').match(/retry(?:Delay)?"?[^0-9]{0,12}(\d+(?:\.\d+)?)\s*s/i);
  return m ? Math.min(90000, Math.ceil(parseFloat(m[1]) * 1000) + 1500) : 30000;
}
const isDaily = r => /perday|per day|daily|RequestsPerDay/i.test(r.text || '');

async function callOnce(k, model, prompt, maxTokens, temperature) {
  const gap = Date.now() - lastCall; if (gap < MIN_GAP_MS) await sleep(MIN_GAP_MS - gap);
  lastCall = Date.now(); stats.calls++;
  const genCfg = { temperature, maxOutputTokens: maxTokens, responseMimeType: 'application/json' };
  if (/gemini-2\.5-flash/.test(model)) genCfg.thinkingConfig = { thinkingBudget: 0 };   // no hidden "thinking" tokens on 2.5
  const safety = ['HARASSMENT', 'HATE_SPEECH', 'SEXUALLY_EXPLICIT', 'DANGEROUS_CONTENT'].map(c => ({ category: `HARM_CATEGORY_${c}`, threshold: 'BLOCK_ONLY_HIGH' }));
  return http(`${API}/models/${model}:generateContent`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': k.key },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: genCfg, safetySettings: safety }),
  });
}

// ─── JSON EXTRACTION (tolerant) ───────────────────────────────
function repairTruncatedJSON(text) {
  try {
    const result = {};
    for (const field of ['title', 'excerpt', 'body', 'seoTitle', 'seoDesc', 'imageQuery', 'category']) {
      const m = text.match(new RegExp(`"${field}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`, 's'));
      if (m) result[field] = m[1].replace(/\\"/g, '"').replace(/\\n/g, ' ');
    }
    const tm = text.match(/"tags"\s*:\s*\[([^\]]*)\]/s);
    result.tags = tm ? (tm[1].match(/"([^"]+)"/g) || []).map(s => s.replace(/"/g, '')) : [];
    return result.title && result.body && result.body.length > 400 ? result : null;
  } catch (_) { return null; }
}
function parseArticleJSON(raw) {
  if (!raw) return null;
  let t = String(raw).replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/```json|```/gi, '').trim();
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a === -1) return null;
  t = b > a ? t.slice(a, b + 1) : t.slice(a);
  const flat = t.replace(/[\r\n\t]+/g, ' ');
  try { return JSON.parse(flat); } catch (_) {}
  return repairTruncatedJSON(flat);
}

// ─── MAIN ENTRY ───────────────────────────────────────────────
// Walks every key and every model until one gives an answer that passes `validate`.
// Returns { data, model, keyName } or null.   `onReject(data, why)` lets the caller keep the best near-miss.
async function generateJSON(prompt, { maxTokens = 9000, temperature = 0.6, validate = () => true } = {}) {
  if (!KEYS.length) return null;
  for (const k of KEYS) {
    if (deadKey.has(k.name)) continue;
    const models = await listModels(k);
    for (const model of models) {
      const mk = `${k.name}|${model}`;
      if (deadModel.has(mk)) continue;
      for (let attempt = 1; attempt <= 3; attempt++) {
        let r;
        try { r = await callOnce(k, model, prompt, maxTokens, temperature); }
        catch (e) { console.log(`    ${model}: network error ${e.message}`); await sleep(4000 * attempt); continue; }

        if (r.ok) {
          const cand = r.json?.candidates?.[0];
          const text = (cand?.content?.parts || []).map(x => x.text || '').join('');
          const finish = cand?.finishReason || r.json?.promptFeedback?.blockReason || '?';
          const data = parseArticleJSON(text);
          if (data) {
            const v = validate(data);
            if (v === true || (v && v.ok)) {
              stats.ok++; stats.byModel[model] = (stats.byModel[model] || 0) + 1;
              console.log(`  [AI] ${model} (${k.name}) produced a valid article`);
              return { data, model, keyName: k.name };
            }
            console.log(`    ${model}: rejected — ${(v && v.why) || 'did not pass checks'}`);
            if (v && v.stop) return null;                       // near miss: caller will expand the draft instead of asking every model again
          } else {
            console.log(`    ${model}: unusable output (finish=${finish}, ${text.length} chars)`);
          }
          break;                                                   // bad answer -> try next model
        }
        const msg = (r.json?.error?.message || r.text || '').replace(/\s+/g, ' ').slice(0, 130);
        console.log(`    ${model}: HTTP ${r.status} ${msg}`);
        if (r.status === 429) {
          if (isDaily(r)) { deadModel.add(mk); console.log(`    ${model}: daily quota used up — skipping it for this run`); break; }
          const wait = retryAfterMs(r);
          if (attempt < 3) { console.log(`    waiting ${Math.round(wait / 1000)}s (per-minute limit)...`); await sleep(wait); continue; }
          break;
        }
        if (r.status === 503 || r.status === 500 || r.status === 504) { await sleep(6000 * attempt); continue; }   // overloaded: retry
        if (r.status === 404) { deadModel.add(mk); break; }                                                      // model gone
        if (r.status === 400 && /API key|API_KEY_INVALID/i.test(r.text)) { deadKey.set(k.name, 'invalid key'); break; }
        if (r.status === 401 || r.status === 403) { deadKey.set(k.name, `HTTP ${r.status}`); console.log(`  [AI] ${k.name} disabled for this run (HTTP ${r.status})`); break; }
        break;                                                     // other 4xx: next model
      }
      if (deadKey.has(k.name)) break;
    }
  }
  return null;
}

const hasKeys = () => KEYS.length > 0;
const providerStatus = () => KEYS.length ? KEYS.map(k => `${k.name.padEnd(17)} SET${deadKey.has(k.name) ? ' (rejected: ' + deadKey.get(k.name) + ')' : ''}`) : ['GEMINI_API_KEY    MISSING'];
const getStats = () => ({ ...stats, deadModels: [...deadModel], deadKeys: [...deadKey.keys()] });

module.exports = { generateJSON, parseArticleJSON, hasKeys, providerStatus, getStats };
