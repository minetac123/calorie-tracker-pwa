// Shared Vercel Blob helpers.
//
// ALL blobs in this project are stored with addRandomSuffix:false, which makes
// their URLs fully deterministic: https://<storeId>.public.blob.vercel-storage.com/<path>
//
// We extract the storeId from BLOB_READ_WRITE_TOKEN (format: vercel_blob_rw_<storeId>_<secret>)
// so reads can go directly to the CDN — a Simple Operation (free) — instead of calling
// list() which is an Advanced Operation and counts against the monthly 2k cap.
const { put, del, list } = require('@vercel/blob');

function getBlobBaseUrl() {
  const token = process.env.BLOB_READ_WRITE_TOKEN || '';
  const m = token.match(/^vercel_blob_rw_([^_]+)_/);
  return m ? `https://${m[1]}.public.blob.vercel-storage.com` : null;
}

const BASE_URL = getBlobBaseUrl();

// Read a blob by pathname. Returns parsed JSON or null.
// Uses a direct CDN fetch (Simple Op) rather than list() (Advanced Op).
async function blobGet(path) {
  try {
    if (BASE_URL) {
      const resp = await fetch(`${BASE_URL}/${path}?_=${Date.now()}`, { cache: 'no-store' });
      if (!resp.ok) return null;
      return resp.json();
    }
    // Fallback when token format is unexpected
    const { blobs } = await list({ prefix: path });
    if (!blobs.length) return null;
    const resp = await fetch(`${blobs[0].url}?_=${Date.now()}`, { cache: 'no-store' });
    return resp.json();
  } catch (e) {
    return null;
  }
}

// Write a blob by pathname. put() is always an Advanced Op.
async function blobPut(path, data) {
  await put(path, JSON.stringify(data), {
    access: 'public',
    addRandomSuffix: false,
    cacheControlMaxAge: 0
  });
}

// Delete a blob by pathname. Uses the deterministic URL to skip list().
async function blobDel(path) {
  try {
    if (BASE_URL) {
      await del(`${BASE_URL}/${path}`);
      return;
    }
    const { blobs } = await list({ prefix: path });
    if (blobs.length) await del(blobs.map((b) => b.url));
  } catch (e) { /* ignore */ }
}

module.exports = { blobGet, blobPut, blobDel, BASE_URL };
