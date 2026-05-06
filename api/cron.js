/**
 * Vercel Cron — runs every 30 minutes per vercel.json schedule.
 *
 * Hits Anthropic 6 times with consolidated topic queries, lets the
 * model classify each result into one of 8 categories, dedupes by
 * summary, and stores the merged feed in Vercel KV. Every visitor
 * to the site reads from KV via /api/alerts, so the API quota is
 * fixed (12 calls/hour) regardless of audience size.
 *
 * Auth: optional. If CRON_SECRET is set (Vercel auto-injects on Pro),
 * we require Bearer-token auth. On Hobby it's open by default.
 *
 * KV shape (key = `asts:alerts`):
 *   { alerts: [...{summary, source, category, date, id, timestamp}],
 *     lastRun: ISO string,
 *     queriesRun: number,
 *     errors: [{query, error}] }
 */

import { kv } from '@vercel/kv';

// 6 broad queries spanning the 8 dashboard categories. The model
// classifies each result into the right category (no hardcoded
// per-query category — trust the model's per-item label).
const QUERIES = [
  'AST SpaceMobile breaking news announcement press release latest',
  'ASTS stock SEC filing earnings analyst rating capital raise',
  'AST SpaceMobile FCC docket spectrum filing regulatory ITU',
  'AST SpaceMobile lawsuit court legal patent litigation',
  'AST SpaceMobile BlueBird satellite launch orbit constellation',
  'AST SpaceMobile Abel Avellan CEO executives partnership AT&T Verizon Vodafone government carrier deal',
];

const VALID_CATEGORIES = new Set([
  'news', 'stock', 'fcc', 'legal',
  'launch', 'satellite', 'people', 'partners',
]);

const SYSTEM_PROMPT = `You are an intelligence analyst monitoring AST SpaceMobile (ticker: ASTS) and everything related to it — executives, satellites, partners, regulators, financials, and the broader space-based cellular industry.
Search the web for the latest updates. Reply with NOTHING but a single JSON array of alert objects. No preamble, no markdown, no code fences. First character must be \`[\`, last must be \`]\`.
Each object must have:
- "summary": 1-2 specific sentences (dates, numbers, names)
- "source": publication or source name
- "category": EXACTLY one of: news, stock, fcc, legal, launch, satellite, people, partners
- "date": ISO date string if known, else null
Focus on updates from the last 7 days. Be exhaustive — return every relevant result. Return [] if nothing found.`;

async function runOneQuery(query) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: query }],
    }),
  });

  const data = await response.json();
  if (data.error) {
    throw new Error(`${data.error.type || 'api_error'}: ${data.error.message}`);
  }

  let jsonText = '';
  for (const block of data.content || []) {
    if (block.type === 'text') jsonText += block.text;
  }
  jsonText = jsonText.replace(/```json|```/g, '').trim();
  const startIdx = jsonText.indexOf('[');
  const endIdx = jsonText.lastIndexOf(']');
  if (startIdx === -1 || endIdx === -1) return [];
  return JSON.parse(jsonText.slice(startIdx, endIdx + 1));
}

export default async function handler(req, res) {
  // Auth gate — only enforce when CRON_SECRET is set (Pro plan auto-sets it).
  if (
    process.env.CRON_SECRET &&
    req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`
  ) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({
      error: 'ANTHROPIC_API_KEY not set on server',
    });
  }

  const allItems = [];
  const errors = [];

  for (const query of QUERIES) {
    try {
      const items = await runOneQuery(query);
      for (const item of items) allItems.push(item);
    } catch (e) {
      console.error('cron query failed:', query, e.message);
      errors.push({ query, error: e.message });
    }
  }

  // Dedupe by summary (model can return overlapping stories across queries).
  const seen = new Set();
  const unique = [];
  for (const item of allItems) {
    if (!item || typeof item.summary !== 'string') continue;
    const key = item.summary.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    // Coerce category to a valid bucket — fallback "news" if model went
    // off-script.
    const category = VALID_CATEGORIES.has(item.category) ? item.category : 'news';
    unique.push({
      summary: item.summary,
      source: item.source ?? null,
      category,
      date: item.date ?? null,
    });
  }

  // Sort by date desc (null dates fall to the bottom), cap at 200.
  unique.sort((a, b) => {
    const ad = a.date ? new Date(a.date).getTime() : 0;
    const bd = b.date ? new Date(b.date).getTime() : 0;
    return bd - ad;
  });
  const limited = unique.slice(0, 200);

  const lastRun = new Date().toISOString();
  // Stamp ids + numeric timestamps client-side-ready.
  const enriched = limited.map((a, i) => ({
    ...a,
    id: `${a.category}-${Date.parse(lastRun)}-${i}`,
    timestamp: a.date ?? lastRun,
  }));

  const payload = {
    alerts: enriched,
    lastRun,
    queriesRun: QUERIES.length,
    errors,
  };

  try {
    await kv.set('asts:alerts', payload);
  } catch (e) {
    console.error('kv.set failed:', e.message);
    return res.status(500).json({
      error: 'KV write failed (is the KV store connected?)',
      detail: e.message,
      payloadCount: enriched.length,
    });
  }

  return res.json({
    ok: true,
    count: enriched.length,
    queriesRun: QUERIES.length,
    errors: errors.length,
    lastRun,
  });
}

// Vercel function config — bump max duration for the long upstream call
// (web search + 6 queries can run 30-60s total).
export const config = {
  maxDuration: 90,
};
