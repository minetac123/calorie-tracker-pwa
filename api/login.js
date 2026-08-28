const { kvGet, kvPut } = require('./_lib/store');
const { generateToken, verifyPassword, hashPassword } = require('./_lib/auth');

module.exports = async function handler(req, res) {
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

    const safeUsername = username.toLowerCase().replace(/[^a-z0-9_-]/g, '');
    const blobPath = `users/${safeUsername}.json`;

    const userData = await kvGet(blobPath);

    // Stejná hláška pro neexistující účet i pro špatné heslo. Rozlišovat je
    // znamená prozradit, která jména jsou zabraná — a jméno je půlka toho, co
    // útočník k útoku na účet potřebuje.
    if (!userData) {
      return res.status(401).json({ error: 'Špatné jméno nebo heslo' });
    }

    const check = await verifyPassword(password, userData.password);
    if (!check.ok) {
      return res.status(401).json({ error: 'Špatné jméno nebo heslo' });
    }

    // Účet založený za starého hashování se při prvním úspěšném přihlášení
    // tiše převede na scrypt. Uživatel o tom neví a nic dělat nemusí.
    if (check.needsUpgrade) {
      try {
        userData.password = await hashPassword(password);
        await kvPut(blobPath, userData);
      } catch (e) {
        // Přihlášení kvůli tomu nepadá — otisk se převede příště.
        console.error('Nepodařilo se převést heslo na scrypt:', e.message);
      }
    }

    const newToken = await generateToken(safeUsername);

    const appData = await kvGet(`data/${safeUsername}.json`);

    return res.status(200).json({
      success: true,
      username: safeUsername,
      token: newToken,
      appData: appData
    });

  } catch (error) {
    console.error('Login error:', error);
    return res.status(500).json({ error: 'Chyba serveru: ' + error.message });
  }
};
