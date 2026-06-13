module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Metoda není povolena' });
  }

  const { q } = req.query;
  if (!q) {
    return res.status(400).json({ error: 'Chybí vyhledávací dotaz' });
  }

  try {
    const url = `https://cs.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(q)}&search_simple=1&action=process&json=1&page_size=10`;
    
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
    console.error('Search proxy error:', error);
    return res.status(500).json({ error: 'Chyba serveru: ' + error.message });
  }
};
