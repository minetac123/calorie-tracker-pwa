# Analysis & Fix Strategy — Food Search API Proxy

## 1. Why the Current API Search Proxy Fails
The existing API proxy in `api/search.js` fails for the following reasons:
- **Deprecated or Unstable Subdomain:** It targets `https://cs.openfoodfacts.org/cgi/search.pl`. This subdomain frequently returns `503 Service Unavailable` or HTML error pages rather than JSON, causing standard parsing to crash.
- **Lack of Error Resilience:** The proxy makes a single fetch attempt without retries. If the upstream service is slow, rate-limited, or throws an transient error, the entire request fails immediately.
- **No Mapping or Filtering:** The proxy passes the raw upstream response directly to the client. This results in:
  - **Bandwidth Waste:** Upstream product documents are massive (hundreds of KB per product), containing redundant translation history, ingredients in dozens of languages, image variants, etc. The frontend only uses name, brand, volume detection, and 4 macronutrients.
  - **Schema Drift Risks:** If any expected field is missing in the upstream JSON, it passes through to `app.js` which might fail or crash, or have issues.
  - **No Graceful Fallback:** If the upstream fails, it throws a `500 Internal Server Error` instead of safely resolving to an empty array `{ "products": [] }`.

---

## 2. Requirements & Structure of OpenFoodFacts API
OpenFoodFacts search endpoint is structured as follows:
- **Endpoint:** `https://<subdomain>.openfoodfacts.org/cgi/search.pl`
- **Query Parameters:**
  - `search_terms=<query>`: The search term (e.g. `jablko`).
  - `search_simple=1`: Simplifies search logic.
  - `action=process`: Triggers the search processor.
  - `json=1`: Tells the server to return JSON instead of HTML.
  - `page_size=10`: Limits results to 10.
- **Subdomains:**
  - `cz.openfoodfacts.org`: Best for Czech local queries. Shows higher stability currently than the deprecated `cs` subdomain.
  - `world.openfoodfacts.org`: Global fallback domain.
- **Response Structure (relevant fields):**
  ```json
  {
    "products": [
      {
        "product_name_cs": "Název v češtině",
        "product_name": "English name",
        "brands": "Brand name",
        "quantity": "100 g",
        "categories": "Categories string",
        "categories_tags": ["en:snacks"],
        "nutriments": {
          "energy-kcal_100g": 433,
          "energy-kcal_100ml": null,
          "energy-kcal_value": 433,
          "proteins_100g": 9,
          "carbohydrates_100g": 51,
          "fat_100g": 19
        }
      }
    ]
  }
  ```

---

## 3. How the API Response Should Be Mapped
To align with what the client's `searchFoodDatabase` expects, the proxy should sanitize and map each product to a predictable structure:

```javascript
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
```

Benefits:
- Eliminates overhead (payload drops from ~200KB to ~2KB).
- Handles missing data gracefully.
- Normalizes number formats.

---

## 4. Proposed Local Verification (test_search.js)
To test Vercel serverless functions locally, we require the handler directly, mock the `req` (request) and `res` (response) interfaces, and execute.

The test verifies two cases:
1. **Valid Query ("jablko"):** Confirms at least 1 product is returned with populated nutrients.
2. **Nonsensical Query ("xqyzzzz"):** Confirms empty array `[]` is returned with `200 OK` rather than a 500 crash.

---

## Proposed Code Artifacts (in Working Directory)
We have prepared two ready-to-use proposed files:
1. `proposed_search.js` — Robust proxy implementation with:
   - Czech-first search (`cz.openfoodfacts.org`).
   - Transient error retries (for 503, 429 status codes).
   - Global fallback to `world.openfoodfacts.org`.
   - Empty products fallback on total failure.
   - Clean, lightweight mapping schema.
2. `proposed_test_search.js` — Test runner that imports `proposed_search.js` and asserts acceptance criteria.
