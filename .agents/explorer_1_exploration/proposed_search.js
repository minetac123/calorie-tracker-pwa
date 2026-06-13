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
    // OpenFoodFacts recommended URL format with lc=cs for localized names
    const url = `https://world.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(q)}&search_simple=1&action=process&json=1&page_size=10&lc=cs`;
    
    // Set up a timeout controller to prevent hanging requests
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'FitAICalorieTracker - Web - Version 1.0 (behrikadam@gmail.com)'
      }
    });
    
    clearTimeout(timeoutId);

    if (!response.ok) {
      return res.status(response.status).json({ error: `Chyba při komunikaci s Open Food Facts API (${response.status})` });
    }

    const data = await response.json();
    
    // Clean and map products array to significantly reduce payload size
    // and match the expected properties required by frontend (app.js)
    const rawProducts = Array.isArray(data.products) ? data.products : [];
    const mappedProducts = rawProducts.map(p => {
      return {
        product_name_cs: p.product_name_cs || null,
        product_name: p.product_name || null,
        brands: p.brands || null,
        quantity: p.quantity || null,
        categories: p.categories || null,
        categories_tags: p.categories_tags || [],
        nutriments: {
          'energy-kcal_100g': p.nutriments?.['energy-kcal_100g'] !== undefined ? p.nutriments['energy-kcal_100g'] : null,
          'energy-kcal_100ml': p.nutriments?.['energy-kcal_100ml'] !== undefined ? p.nutriments['energy-kcal_100ml'] : null,
          'energy-kcal_value': p.nutriments?.['energy-kcal_value'] !== undefined ? p.nutriments['energy-kcal_value'] : null,
          proteins_100g: p.nutriments?.proteins_100g !== undefined ? p.nutriments.proteins_100g : null,
          proteins_100ml: p.nutriments?.proteins_100ml !== undefined ? p.nutriments.proteins_100ml : null,
          carbohydrates_100g: p.nutriments?.carbohydrates_100g !== undefined ? p.nutriments.carbohydrates_100g : null,
          carbohydrates_100ml: p.nutriments?.carbohydrates_100ml !== undefined ? p.nutriments.carbohydrates_100ml : null,
          fat_100g: p.nutriments?.fat_100g !== undefined ? p.nutriments.fat_100g : null,
          fat_100ml: p.nutriments?.fat_100ml !== undefined ? p.nutriments.fat_100ml : null
        }
      };
    });

    return res.status(200).json({ products: mappedProducts });
  } catch (error) {
    if (error.name === 'AbortError') {
      return res.status(504).json({ error: 'Dotaz na OpenFoodFacts vypršel (timeout)' });
    }
    console.error('Search proxy error:', error);
    return res.status(500).json({ error: 'Chyba serveru: ' + error.message });
  }
};
