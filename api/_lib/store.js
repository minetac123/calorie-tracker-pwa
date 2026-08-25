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

// Read a key. Returns the parsed value, or null if the key does not exist.
// The client (de)serializes JSON automatically, so callers pass and receive
// plain objects — no manual JSON.stringify/parse at the call sites.
async function kvGet(key) {
  return (await requireRedis().get(key)) ?? null;
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
