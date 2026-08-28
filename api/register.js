const { kvGet, kvPut } = require('./_lib/store');
const { generateToken, hashPassword } = require('./_lib/auth');

module.exports = async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Metoda není povolena' });
  }

  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Vyplň uživatelské jméno a heslo' });
    }

    if (username.length < 3 || username.length > 30) {
      return res.status(400).json({ error: 'Jméno musí mít 3–30 znaků' });
    }

    // Čtyři znaky nechrání vůbec nic — takové heslo se uhodne hrubou silou
    // rychleji, než se stihne dopsat. Osm je pořád mírné minimum.
    if (password.length < 8) {
      return res.status(400).json({ error: 'Heslo musí mít alespoň 8 znaků' });
    }

    const safeUsername = username.toLowerCase().replace(/[^a-z0-9_-]/g, '');
    if (safeUsername.length < 3) {
      return res.status(400).json({ error: 'Jméno smí mít jen písmena, číslice, _ a -' });
    }

    const blobPath = `users/${safeUsername}.json`;

    // Check if user already exists
    const existing = await kvGet(blobPath);
    if (existing) {
      return res.status(409).json({ error: 'Uživatel už existuje' });
    }

    const hashedPassword = await hashPassword(password);
    const token = await generateToken(safeUsername);

    const userData = {
      username: safeUsername,
      password: hashedPassword,
      createdAt: new Date().toISOString()
      // Token se sem záměrně neukládá: je podepsaný, takže ho server ověří sám,
      // a držet ho navíc v databázi by znamenalo jen další místo, odkud může
      // uniknout.
    };

    await kvPut(blobPath, userData);

    return res.status(200).json({
      success: true,
      username: safeUsername,
      token: token
    });

  } catch (error) {
    console.error('Register error:', error);
    return res.status(500).json({ error: 'Chyba serveru: ' + error.message });
  }
};
