/**
 * Public read endpoint. The frontend polls this every 60s; it returns
 * whatever the most-recent cron run wrote to Vercel Blob. No upstream
 * Anthropic call ever happens here — fixed cost regardless of traffic.
 *
 * Implementation: `head(pathname)` looks up the blob's metadata + URL
 * (Blob URLs are random-host so we can't hardcode them), then we fetch
 * the JSON body from that URL and forward it.
 *
 * Response shape:
 *   { alerts: [...], lastRun: ISO|null, queriesRun: number,
 *     errors: [], stale: boolean, empty?: boolean }
 *
 * `stale` is true when the cached lastRun is more than 75 minutes old
 * (cron runs every 30; 1.5x slack for transient cron skips).
 */

import { head, BlobNotFoundError } from '@vercel/blob';

const BLOB_PATHNAME = 'asts-alerts.json';
const STALE_AFTER_MS = 75 * 60 * 1000;

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();

  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return res.status(500).json({
      error: 'BLOB_READ_WRITE_TOKEN not set — connect a Vercel Blob store to the project',
    });
  }

  let blobMeta;
  try {
    blobMeta = await head(BLOB_PATHNAME);
  } catch (e) {
    // Cron hasn't run yet (fresh deploy / Blob just attached) — return
    // an empty payload rather than 5xx so the UI shows "waiting" state.
    if (e instanceof BlobNotFoundError) {
      return res.json({
        alerts: [],
        lastRun: null,
        queriesRun: 0,
        errors: [],
        stale: false,
        empty: true,
      });
    }
    console.error('blob head failed:', e.message);
    return res.status(500).json({
      error: 'Blob read failed',
      detail: e.message,
    });
  }

  let cached;
  try {
    const response = await fetch(blobMeta.url, {
      // Bypass the edge cache so newly-written cron payloads aren't
      // shadowed by a stale CDN copy. The Blob CDN's own cache is
      // already short (cacheControlMaxAge: 30 set by the cron writer).
      cache: 'no-store',
    });
    if (!response.ok) {
      throw new Error(`fetch ${response.status} ${response.statusText}`);
    }
    cached = await response.json();
  } catch (e) {
    console.error('blob body fetch failed:', e.message);
    return res.status(500).json({
      error: 'Blob body fetch failed',
      detail: e.message,
    });
  }

  const lastRunMs = cached?.lastRun ? Date.parse(cached.lastRun) : 0;
  const stale = lastRunMs > 0 && Date.now() - lastRunMs > STALE_AFTER_MS;

  // Light browser caching — fine for a 60s poll cadence.
  res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
  return res.json({ ...cached, stale });
}
