/**
 * Vercel Cron — runs every 30 minutes per vercel.json schedule.
 *
 * Hits Anthropic 6 times with consolidated topic queries, lets the
 * model classify each result into one of 8 categories, dedupes by
 * summary, and writes the merged feed to Vercel Blob storage as a
 * single JSON object at pathname `asts-alerts.json`. Every visitor
 * to the site reads from Blob via /api/alerts, so the API quota is
 * fixed (12 calls/hour) regardless of audience size.
 *
 * Auth: optional. If CRON_SECRET is set (Vercel auto-injects on Pro),
 * we require Bearer-token auth. On Hobby it's open by default.
 *
 * Blob shape (pathname = `asts-alerts.json`):
 *   { alerts: [...{summary, source, category, date, id, timestamp}],
 *     lastRun: ISO string,
 *     queriesRun: number,
 *     errors: [{query, error}] }
 */

import { put } from '@vercel/blob';

const BLOB_PATHNAME = 'asts-alerts.json';

// 6 broad queries spanning the 8 dashboard categories. The model
// classifies each result into the right category — no hardcoded
// per-query category, we trust the model's per-item label.
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
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return res.status(500).json({
      error: 'BLOB_READ_WRITE_TOKEN not set — connect a Vercel Blob store to the project',
    });
  }

  // Run the 6 queries in parallel — each Anthropic web-search call
  // takes 10-30s, so sequential execution blew the 90s function ceiling
  // (FUNCTION_INVOCATION_TIMEOUT) on the first prod run. With
  // Promise.allSettled total wall time is max(latency) instead of sum.
  const results = await Promise.allSettled(
    QUERIES.map((query) => runOneQuery(query))
  );

  const allItems = [];
  const errors = [];
  results.forEach((r, i) => {
    const query = QUERIES[i];
    if (r.status === 'fulfilled') {
      for (const item of r.value) allItems.push(item);
    } else {
      const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
      console.error('cron query failed:', query, msg);
      errors.push({ query, error: msg });
    }
  });

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

  let blobUrl;
  try {
    // Overwrite the same pathname every run. `addRandomSuffix: false`
    // is required to keep a stable path; `allowOverwrite: true` lets
    // subsequent runs replace the prior payload.
    const blob = await put(BLOB_PATHNAME, JSON.stringify(payload), {
      access: 'private',
      contentType: 'application/json',
      addRandomSuffix: false,
      allowOverwrite: true,
      cacheControlMaxAge: 30, // edge can cache for 30s; cron runs every 1800s
    });
    blobUrl = blob.url;
  } catch (e) {
    console.error('blob put failed:', e.message);
    return res.status(500).json({
      error: 'Blob write failed (is BLOB_READ_WRITE_TOKEN set? store connected?)',
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
    blobUrl,
  });
}

// Function timeout. Pro plan ceiling is 300s; we set 180s for headroom
// on slow web-search responses. The first prod run hit the prior 90s
// limit (FUNCTION_INVOCATION_TIMEOUT) before parallelization landed —
// even with parallel queries, individual web-search calls can run 30s+
// when the model decides to do multiple searches per query.
export const config = {
  maxDuration: 180,
};
