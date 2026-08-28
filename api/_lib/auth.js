// Session tokens a hesla.
//
// Původní podoba tokenu byla base64("jméno_čas_náhoda") a server z něj jméno
// jen přečetl — nic nepodepisoval, nic neověřoval. Kdo znal cizí uživatelské
// jméno, složil si platný token za pár vteřin a četl i zapisoval cizí data.
//
// Token je teď podepsaný HMAC-SHA256. Payload zůstává čitelný (není to
// tajemství), ale bez podpisu ho server odmítne, a podpis nejde vyrobit bez
// serverového tajemství. Staré tokeny tím přestávají platit — to je záměr,
// právě ony byly ten problém. Uživatelé se jednou znovu přihlásí, data jim
// zůstanou, protože jsou v úložišti vedená pod jménem, ne pod tokenem.
const crypto = require('crypto');
const { kvGet, kvPut } = require('./store');

const TOKEN_TTL_MS = 180 * 24 * 60 * 60 * 1000; // půl roku
const SECRET_KEY = 'auth/secret.json';

let cachedSecret = null;

// Tajemství na podepisování. Nejraději z proměnné prostředí, ale nikdo si po
// nasazení nemá muset nic nastavovat, aby appka nebyla děravá — takže když
// chybí, vygeneruje se náhodné a uloží do stejného úložiště jako zbytek dat.
async function getSecret() {
  if (cachedSecret) return cachedSecret;

  const fromEnv = (process.env.AUTH_SECRET || '').trim();
  if (fromEnv) {
    cachedSecret = fromEnv;
    return cachedSecret;
  }

  const stored = await kvGet(SECRET_KEY);
  if (stored && stored.secret) {
    cachedSecret = stored.secret;
    return cachedSecret;
  }

  const generated = crypto.randomBytes(32).toString('hex');
  await kvPut(SECRET_KEY, { secret: generated, createdAt: Date.now() });

  // Přečíst zpátky: když dvě první requesty dorazí naráz, obě si vygenerují
  // jiné tajemství a jedno zvítězí. Bez tohohle kroku by si lambda pamatovala
  // to svoje a podepisovala tokeny, které nikdo jiný neuzná.
  const confirmed = await kvGet(SECRET_KEY);
  cachedSecret = (confirmed && confirmed.secret) || generated;
  return cachedSecret;
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(s) {
  return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function sign(payloadB64, secret) {
  return b64url(crypto.createHmac('sha256', secret).update(payloadB64).digest());
}

async function generateToken(username) {
  const secret = await getSecret();
  const payload = JSON.stringify({
    u: String(username),
    t: Date.now(),
    n: crypto.randomBytes(9).toString('base64')
  });
  const payloadB64 = b64url(payload);
  return `${payloadB64}.${sign(payloadB64, secret)}`;
}

// Vrátí uživatelské jméno, nebo null. Null znamená "nepouštěj dál" — ať už je
// token rozbitý, podvržený, nebo prostě starý.
async function extractUsername(authHeader) {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;

  const token = authHeader.slice('Bearer '.length).trim();
  const dot = token.indexOf('.');
  if (dot <= 0) return null; // starý nepodepsaný formát

  const payloadB64 = token.slice(0, dot);
  const providedSig = token.slice(dot + 1);
  if (!providedSig) return null;

  try {
    const secret = await getSecret();
    const expectedSig = sign(payloadB64, secret);

    // Porovnání odolné proti měření času. Různá délka by timingSafeEqual
    // shodila výjimkou, proto ta kontrola napřed.
    const a = Buffer.from(providedSig);
    const b = Buffer.from(expectedSig);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

    const payload = JSON.parse(fromB64url(payloadB64).toString('utf-8'));
    if (!payload || typeof payload.u !== 'string' || !payload.u) return null;
    if (!Number.isFinite(payload.t) || Date.now() - payload.t > TOKEN_TTL_MS) return null;

    return payload.u;
  } catch (e) {
    return null;
  }
}

// --- Hesla -----------------------------------------------------------------
//
// Dřív SHA-256 se statickou solí sdílenou všemi. To je pro hesla špatně hned
// dvakrát: jedna sůl znamená, že stejná hesla mají stejný otisk, a SHA-256 je
// tak rychlá, že se slovníkový útok počítá na miliardy pokusů za vteřinu.
// scrypt je navržená přesně naopak — je záměrně pomalá a paměťově náročná — a
// každý uživatel má vlastní náhodnou sůl.
//
// scrypt je součástí Node.js, takže to nepřidává žádnou závislost.

const SCRYPT_N = 16384; // ~100 ms na jeden hash
const KEY_LEN = 64;
const LEGACY_SALT = '_fitai_salt_2026';

function scryptHash(password, saltHex) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(password), saltHex, KEY_LEN, { N: SCRYPT_N, r: 8, p: 1 }, (err, key) => {
      if (err) reject(err);
      else resolve(key.toString('hex'));
    });
  });
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = await scryptHash(password, salt);
  return `scrypt$${salt}$${hash}`;
}

function legacyHash(password) {
  return crypto.createHash('sha256').update(password + LEGACY_SALT).digest('hex');
}

function timingSafeEqualStr(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// Ověří heslo proti uloženému otisku. Rozumí i starému SHA-256 formátu, aby se
// nikdo z existujících uživatelů nezamkl venku; `needsUpgrade` říká volajícímu,
// že má otisk přepsat na nový formát (viz login.js).
async function verifyPassword(password, stored) {
  const s = String(stored || '');

  if (s.startsWith('scrypt$')) {
    const parts = s.split('$');
    if (parts.length !== 3) return { ok: false, needsUpgrade: false };
    const computed = await scryptHash(password, parts[1]);
    return { ok: timingSafeEqualStr(computed, parts[2]), needsUpgrade: false };
  }

  // Starý formát: holý SHA-256 hex.
  if (/^[a-f0-9]{64}$/i.test(s)) {
    return { ok: timingSafeEqualStr(legacyHash(password), s), needsUpgrade: true };
  }

  return { ok: false, needsUpgrade: false };
}

module.exports = {
  extractUsername,
  generateToken,
  hashPassword,
  verifyPassword
};
