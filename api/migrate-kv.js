// ONE-OFF migration: copies every blob out of Vercel Blob into the new Redis
// store, key for key, so the cutover away from Blob does not lose any
// existing user's data. Delete this file (and the @vercel/blob dependency)
// once the migration has run successfully in production — it is not part of
// the app's normal operation and does not need to exist afterwards.
//
// Protected by CRON_SECRET (already provisioned for the daily cron) rather
// than a new secret, since this is exactly the same kind of "not for public
// traffic" endpoint.
const { list } = require('@vercel/blob');
const { kvPut, kvGet, kvDel, getRedis } = require('./_lib/store');

// Trimmed at both ends: a mobile paste into the Vercel dashboard can pick up
// a trailing newline that is otherwise invisible and unfixable from the UI,
// and the same could happen to whatever a caller sends back. Comparing
// trimmed values makes the check tolerant of that without weakening it —
// the secret's actual content still has to match exactly.
const CRON_SECRET = (process.env.CRON_SECRET || '').trim();

module.exports = async function handler(req, res) {
  // No-secret diagnostic: just "is Redis configured", nothing sensitive.
  // Lets a human check whether the Storage integration is connected without
  // needing CRON_SECRET in hand for a yes/no answer.
  if (req.query && req.query.ping === '1') {
    const configured = !!getRedis();
    let roundtrip = null;
    if (configured) {
      const key = '_ping/' + Date.now();
      try {
        await kvPut(key, { ok: true });
        const back = await kvGet(key);
        roundtrip = !!(back && back.ok === true);
      } catch (e) {
        roundtrip = false;
      } finally {
        kvDel(key).catch(() => {});
      }
    }
    return res.status(200).json({ redisConfigured: configured, roundtrip });
  }

  if (CRON_SECRET) {
    const auth = req.headers.authorization || '';
    if (auth.replace(/^Bearer\s+/, '').trim() !== CRON_SECRET) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  const dryRun = req.query && req.query.dryRun === '1';
  const results = [];
  const errors = [];

  try {
    let cursor;
    do {
      const page = await list({ cursor, limit: 1000 });
      for (const b of page.blobs) {
        try {
          const resp = await fetch(`${b.url}?_=${Date.now()}`, { cache: 'no-store' });
          if (!resp.ok) { errors.push({ path: b.pathname, error: `fetch ${resp.status}` }); continue; }
          const data = await resp.json();
          if (!dryRun) await kvPut(b.pathname, data);
          results.push(b.pathname);
        } catch (e) {
          errors.push({ path: b.pathname, error: e.message });
        }
      }
      cursor = page.cursor;
    } while (cursor);

    return res.status(200).json({
      success: true,
      dryRun,
      migrated: results.length,
      keys: results,
      errors
    });
  } catch (error) {
    console.error('Migrace selhala:', error);
    return res.status(500).json({ error: 'Chyba serveru: ' + error.message });
  }
};
