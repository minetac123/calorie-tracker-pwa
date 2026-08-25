// Key-value store backed by Upstash Redis (via the Vercel Storage integration).
//
// Replaces Vercel Blob, which was being used as a JSON key-value store — the
// wrong shape for it. Every write to Blob is billed as an "Advanced Operation"
// with a monthly cap, so each sync, login and Telegram action ate into that
// cap. Redis has no such distinction: reads and writes are both cheap, plain
// commands, and Upstash's free tier (10k commands/day) covers this app many
// times over.
//
// Accepts either env var naming Vercel's marketplace has used for this
// integration, so it works regardless of which one provisioned the database.
const { Redis } = require('@upstash/redis');

let client = null;
let clientChecked = false;

function getRedis() {
  if (clientChecked) return client;
  clientChecked = true;
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '';
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';
  if (url && token) client = new Redis({ url, token });
  return client;
}

function requireRedis() {
  const redis = getRedis();
  if (!redis) {
    throw new Error('Redis není nastavený — chybí KV_REST_API_URL/TOKEN (nebo UPSTASH_REDIS_REST_URL/TOKEN)');
  }
  return redis;
}

// --- Read-through migration from the old Vercel Blob store -----------------
//
// The cutover to Redis must not require a big-bang migration to have run
// first: if it hasn't, every user would hit an empty database and look
// logged-out with their data gone. So a key that isn't in Redis yet is
// looked up in Blob, copied across, and returned. Each record migrates the
// first time anyone touches it, and after that Blob is never consulted for
// it again.
//
// Once the Blob store is known to be drained this whole section — and the
// @vercel/blob dependency — can be deleted.

function blobBaseUrl() {
  const token = process.env.BLOB_READ_WRITE_TOKEN || '';
  const m = token.match(/^vercel_blob_rw_([^_]+)_/);
  return m ? `https://${m[1]}.public.blob.vercel-storage.com` : null;
}

async function legacyBlobGet(key) {
  const base = blobBaseUrl();
  if (!base) return null;
  try {
    const resp = await fetch(`${base}/${key}?_=${Date.now()}`, { cache: 'no-store' });
    if (!resp.ok) return null;
    return await resp.json();
  } catch (e) {
    return null;
  }
}

// Read a key. Returns the parsed value, or null if the key does not exist.
// The client (de)serializes JSON automatically, so callers pass and receive
// plain objects — no manual JSON.stringify/parse at the call sites.
async function kvGet(key) {
  const hit = (await requireRedis().get(key)) ?? null;
  if (hit !== null) return hit;

  const legacy = await legacyBlobGet(key);
  if (legacy === null) return null;

  // Copy it across so this is the last time Blob is asked for this key. A
  // failure here is not fatal — the caller still gets its data, it just
  // migrates on a later read instead.
  try {
    await requireRedis().set(key, legacy);
    console.log(`Migrováno z Blobu do Redisu: ${key}`);
  } catch (e) {
    console.error(`Nepodařilo se přenést ${key} do Redisu:`, e.message);
  }
  return legacy;
}

// Write a key. Overwrites whatever was there.
async function kvPut(key, data) {
  await requireRedis().set(key, data);
}

// Delete a key. A missing key is not an error.
async function kvDel(key) {
  await requireRedis().del(key);
}

module.exports = { kvGet, kvPut, kvDel, getRedis };
