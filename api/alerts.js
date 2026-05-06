/**
 * Public read endpoint. The frontend polls this every 60s; it just
 * returns whatever the most-recent cron run wrote to KV. No upstream
 * Anthropic call ever happens here — fixed cost regardless of traffic.
 *
 * Response shape:
 *   { alerts: [...], lastRun: ISO|null, queriesRun: number,
 *     errors: [], stale: boolean }
 *
 * `stale` is true when the cached lastRun is more than 75 minutes old
 * (cron runs every 30; we allow 1.5x slack for transient cron skips).
 * The UI uses it to show a warning banner.
 */

import { kv } from '@vercel/kv';

const STALE_AFTER_MS = 75 * 60 * 1000;

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();

  let cached;
  try {
    cached = await kv.get('asts:alerts');
  } catch (e) {
    console.error('kv.get failed:', e.message);
    return res.status(500).json({
      error: 'KV read failed (is the KV store connected?)',
      detail: e.message,
    });
  }

  if (!cached) {
    // Cron hasn't run yet (fresh deploy, or KV was just attached).
    return res.json({
      alerts: [],
      lastRun: null,
      queriesRun: 0,
      errors: [],
      stale: false,
      empty: true,
    });
  }

  const lastRunMs = cached.lastRun ? Date.parse(cached.lastRun) : 0;
  const stale = lastRunMs > 0 && Date.now() - lastRunMs > STALE_AFTER_MS;

  // Light browser caching — fine for a 60s poll cadence.
  res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
  return res.json({ ...cached, stale });
}
