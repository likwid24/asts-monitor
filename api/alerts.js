/**
 * Public read endpoint. The frontend polls this every 60s; it returns
 * whatever the most-recent cron run wrote to Vercel Blob. No upstream
 * Anthropic call ever happens here — fixed cost regardless of traffic.
 *
 * Implementation: the Blob store is private, so we use the SDK's
 * `get(pathname, { access: 'private' })` which returns a body stream
 * the function reads + forwards. No public URL ever touches the
 * client. Returns null when the blob doesn't exist yet (first deploy
 * before cron has run).
 *
 * Response shape:
 *   { alerts: [...], lastRun: ISO|null, queriesRun: number,
 *     errors: [], stale: boolean, empty?: boolean }
 *
 * `stale` is true when the cached lastRun is more than 75 minutes old
 * (cron runs every 30; 1.5x slack for transient cron skips).
 */

import { get } from '@vercel/blob';

const BLOB_PATHNAME = 'asts-alerts.json';
const STALE_AFTER_MS = 75 * 60 * 1000;

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();

  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return res.status(500).json({
      error: 'BLOB_READ_WRITE_TOKEN not set — connect a Vercel Blob store to the project',
    });
  }

  let result;
  try {
    result = await get(BLOB_PATHNAME, { access: 'private' });
  } catch (e) {
    console.error('blob get failed:', e.message);
    return res.status(500).json({
      error: 'Blob read failed',
      detail: e.message,
    });
  }

  if (!result) {
    // Cron hasn't run yet (fresh deploy / Blob just attached) — return
    // an empty payload rather than 5xx so the UI shows "waiting" state.
    return res.json({
      alerts: [],
      lastRun: null,
      queriesRun: 0,
      errors: [],
      stale: false,
      empty: true,
    });
  }

  let cached;
  try {
    // result.stream is a ReadableStream<Uint8Array>; Response wraps it
    // and gives us a .json() helper for free.
    cached = await new Response(result.stream).json();
  } catch (e) {
    console.error('blob body parse failed:', e.message);
    return res.status(500).json({
      error: 'Blob body parse failed',
      detail: e.message,
    });
  }

  const lastRunMs = cached?.lastRun ? Date.parse(cached.lastRun) : 0;
  const stale = lastRunMs > 0 && Date.now() - lastRunMs > STALE_AFTER_MS;

  // Light browser caching — fine for a 60s poll cadence.
  res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
  return res.json({ ...cached, stale });
}
