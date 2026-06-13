module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Metoda není povolena' });
  }

  const { code } = req.query;
  if (!code) {
    return res.status(400).json({ error: 'Chybí čárový kód' });
  }

  try {
    const url = `https://world.openfoodfacts.org/api/v0/product/${code}.json`;
    
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'FitAICalorieTracker - Web - Version 1.0 (behrikadam@gmail.com)'
      }
    });

    if (!response.ok) {
      return res.status(response.status).json({ error: `Chyba při komunikaci s Open Food Facts API (${response.status})` });
    }

    const data = await response.json();
    return res.status(200).json(data);
  } catch (error) {
    console.error('Barcode proxy error:', error);
    return res.status(500).json({ error: 'Chyba serveru: ' + error.message });
  }
};
