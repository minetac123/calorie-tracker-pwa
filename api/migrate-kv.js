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
const { kvPut } = require('./_lib/store');

const CRON_SECRET = process.env.CRON_SECRET || '';

module.exports = async function handler(req, res) {
  if (CRON_SECRET) {
    const auth = req.headers.authorization || '';
    if (auth !== `Bearer ${CRON_SECRET}`) {
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
