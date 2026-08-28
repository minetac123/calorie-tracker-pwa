// Open Food Facts asks callers to identify themselves with a contact address
// in the User-Agent, so anyone running their own copy should put their own
// there via OFF_CONTACT rather than inherit whoever wrote this.
const OFF_USER_AGENT = `FitAI Calorie Tracker - Web - Version 1.0 (${process.env.OFF_CONTACT || 'https://github.com/minetac123/calorie-tracker-pwa'})`;

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

  let timeoutId;
  try {
    const url = `https://world.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(q)}&search_simple=1&action=process&json=1&page_size=10&lc=cs`;
    
    // Set up an AbortController to implement timeout (8 seconds)
    const controller = new AbortController();
    timeoutId = setTimeout(() => controller.abort(), 8000);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': OFF_USER_AGENT
      }
    });
    
    clearTimeout(timeoutId);

    if (!response.ok) {
      return res.status(response.status).json({ error: `Chyba při komunikaci s Open Food Facts API (${response.status})` });
    }

    const data = await response.json();
    
    const rawProducts = (data && Array.isArray(data.products)) ? data.products : [];
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
          fat_100ml: p.nutriments?.fat_100ml !== undefined ? p.nutriments.fat_100ml : null,
          calories: p.nutriments?.['energy-kcal_100g'] !== undefined ? p.nutriments['energy-kcal_100g'] : (p.nutriments?.['energy-kcal_100ml'] !== undefined ? p.nutriments['energy-kcal_100ml'] : (p.nutriments?.['energy-kcal_value'] !== undefined ? p.nutriments['energy-kcal_value'] : null)),
          protein: p.nutriments?.proteins_100g !== undefined ? p.nutriments.proteins_100g : (p.nutriments?.proteins_100ml !== undefined ? p.nutriments.proteins_100ml : null),
          carbs: p.nutriments?.carbohydrates_100g !== undefined ? p.nutriments.carbohydrates_100g : (p.nutriments?.carbohydrates_100ml !== undefined ? p.nutriments.carbohydrates_100ml : null),
          fat: p.nutriments?.fat_100g !== undefined ? p.nutriments.fat_100g : (p.nutriments?.fat_100ml !== undefined ? p.nutriments.fat_100ml : null)
        }
      };
    });

    return res.status(200).json({ products: mappedProducts });
  } catch (error) {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    if (error.name === 'AbortError') {
      return res.status(504).json({ error: 'Dotaz na OpenFoodFacts vypršel (timeout)' });
    }
    console.error('Search proxy error:', error);
    return res.status(500).json({ error: 'Chyba serveru: ' + error.message });
  }
};
