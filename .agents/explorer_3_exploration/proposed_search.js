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

  const fetchFromOpenFoodFacts = async (query, domain) => {
    const url = `https://${domain}/cgi/search.pl?search_terms=${encodeURIComponent(query)}&search_simple=1&action=process&json=1&page_size=10`;
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'FitAICalorieTracker - Web - Version 1.0 (behrikadam@gmail.com)'
      }
    });

    if (!response.ok) {
      throw new Error(`OpenFoodFacts error status ${response.status} on domain ${domain}`);
    }

    return response.json();
  };

  const fetchWithRetry = async (query, domain, retries = 1, delayMs = 500) => {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await fetchFromOpenFoodFacts(query, domain);
      } catch (error) {
        const isTransientError = error.message.includes('503') || error.message.includes('429') || error.message.includes('502') || error.message.includes('504');
        if (attempt < retries && isTransientError) {
          console.warn(`Attempt ${attempt + 1} for ${domain} failed with transient error: ${error.message}. Retrying in ${delayMs}ms...`);
          await new Promise(resolve => setTimeout(resolve, delayMs));
          continue;
        }
        throw error;
      }
    }
  };

  try {
    let data;
    try {
      // Primary search domain for Czech food (more stable and has regional cache)
      data = await fetchWithRetry(q, 'cz.openfoodfacts.org');
    } catch (primaryError) {
      console.warn(`Primary search domain (cz) failed after retries, trying fallback: ${primaryError.message}`);
      try {
        // Fallback search domain
        data = await fetchWithRetry(q, 'world.openfoodfacts.org');
      } catch (fallbackError) {
        console.error(`Fallback search domain (world) also failed after retries: ${fallbackError.message}`);
        // Gracefully return empty products list instead of 500 error to keep PWA working
        return res.status(200).json({
          products: [],
          warning: 'External food database is currently unavailable.'
        });
      }
    }

    const rawProducts = Array.isArray(data.products) ? data.products : [];
    
    // Map raw OpenFoodFacts products to the exact minimal structure expected by the frontend.
    // This reduces payload size by ~95% and guarantees schema stability.
    const mappedProducts = rawProducts.map(p => ({
      product_name_cs: p.product_name_cs || null,
      product_name: p.product_name || null,
      brands: p.brands || null,
      quantity: p.quantity || null,
      categories: p.categories || null,
      categories_tags: Array.isArray(p.categories_tags) ? p.categories_tags : [],
      nutriments: {
        'energy-kcal_100g': p.nutriments?.['energy-kcal_100g'] !== undefined ? Number(p.nutriments['energy-kcal_100g']) : null,
        'energy-kcal_100ml': p.nutriments?.['energy-kcal_100ml'] !== undefined ? Number(p.nutriments['energy-kcal_100ml']) : null,
        'energy-kcal_value': p.nutriments?.['energy-kcal_value'] !== undefined ? Number(p.nutriments['energy-kcal_value']) : null,
        'proteins_100g': p.nutriments?.['proteins_100g'] !== undefined ? Number(p.nutriments['proteins_100g']) : null,
        'proteins_100ml': p.nutriments?.['proteins_100ml'] !== undefined ? Number(p.nutriments['proteins_100ml']) : null,
        'carbohydrates_100g': p.nutriments?.['carbohydrates_100g'] !== undefined ? Number(p.nutriments['carbohydrates_100g']) : null,
        'carbohydrates_100ml': p.nutriments?.['carbohydrates_100ml'] !== undefined ? Number(p.nutriments['carbohydrates_100ml']) : null,
        'fat_100g': p.nutriments?.['fat_100g'] !== undefined ? Number(p.nutriments['fat_100g']) : null,
        'fat_100ml': p.nutriments?.['fat_100ml'] !== undefined ? Number(p.nutriments['fat_100ml']) : null
      }
    }));

    return res.status(200).json({ products: mappedProducts });
  } catch (error) {
    console.error('Search proxy error:', error);
    return res.status(500).json({ error: 'Chyba serveru: ' + error.message });
  }
};
