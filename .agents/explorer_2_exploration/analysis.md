# Analysis: Calorie Tracker Food Search API Proxy Fix Strategy

This report analyzes the issues with the current food search API proxy (`api/search.js`), examines the requirements of the external OpenFoodFacts (OFF) API, details the mapping strategy to align with the frontend client expectations, and outlines the design for a local test script (`test_search.js`).

---

## 1. Why the Current API Search Proxy Fails or Returns Errors

The current implementation of the API proxy (`api/search.js`) has several vulnerabilities and design issues:

1. **Subdomain Instability (`cs.openfoodfacts.org`)**:
   - The proxy targets `https://cs.openfoodfacts.org/cgi/search.pl`. In the ISO standard, `cs` represents the Czech language, not the country code for the Czech Republic (which is `cz`). 
   - Language-specific subdomains on OpenFoodFacts are primarily intended for localized web browsing. When used for API requests, they often experience DNS resolution failures, redirection loops, or SSL certificate handshake errors (e.g., mismatch where the SSL cert is valid only for `*.openfoodfacts.org` or `world.openfoodfacts.org`).
   - OpenFoodFacts recommends querying their primary CDN-backed domain `world.openfoodfacts.org` for read operations and using search parameters to filter by country or language.

2. **Native `fetch` Environment Limitations**:
   - The code relies on the global `fetch` API. In older Node.js runtimes (Node.js < 18), `fetch` is not defined globally. While Vercel deployment environments support Node.js 18+, local developers using older Node.js versions will experience a `ReferenceError: fetch is not defined` crash.

3. **Absence of Response Mapping (Payload Bloat)**:
   - The proxy currently forwards the entire raw response from OpenFoodFacts directly to the client:
     ```javascript
     const data = await response.json();
     return res.status(200).json(data);
     ```
   - A raw OFF search response for 10 products can exceed **2MB** because it contains hundreds of internal database fields, images, historical tags, and localized names. 
   - This causes substantial payload bloat, high latency, potential Vercel function timeouts, and browser-side parsing slowdowns.

4. **Fragile JSON Parsing**:
   - If OpenFoodFacts returns a non-200 error code (e.g., 502 Bad Gateway, 504 Gateway Timeout, or 429 Too Many Requests) or returns an HTML-formatted block page (e.g. Cloudflare security check), `await response.json()` will throw a syntax error (`Unexpected token < in JSON...`). 
   - The catch block intercepts this and returns a `500 Server Error`, masking the actual upstream response status and failing to return a graceful empty array `[]` where appropriate.

---

## 2. Requirements and Structure of the External Database API (OpenFoodFacts)

To query OpenFoodFacts reliably:

### Endpoint & Base URL
- **Recommended Domain**: `https://world.openfoodfacts.org`
- **Search CGI Script**: `/cgi/search.pl`
- **Request Parameters**:
  - `search_terms=<query>`: The search string (URL-encoded).
  - `search_simple=1`: Enables simplified keyword search.
  - `action=process`: Triggers the search processor.
  - `json=1`: Crucial to instruct the server to return JSON rather than HTML.
  - `page_size=10`: Limits results to the top 10 matches.
  - `lc=cs`: (Optional/Recommended) Restricts search language preference to Czech.

### Compliance Headers
- **User-Agent**: OpenFoodFacts explicitly requests a unique `User-Agent` header identifying the app name, version, platform, and contact email to prevent rate-limiting or blocking. The current header is compliant but should be preserved:
  `FitAICalorieTracker - Web - Version 1.0 (behrikadam@gmail.com)`

### Product Schema Structure
The raw search response contains a `products` array. Each product object contains:
- `product_name_cs`: The Czech name of the product (if available).
- `product_name`: The fallback English/generic name.
- `brands`: Brands associated with the product.
- `quantity`: Quantity string (e.g., `"500 ml"`, `"1 kg"`).
- `categories`: Categories string (e.g., `"Napoje, Džusy"`).
- `categories_tags`: Array of category identifier tags (e.g., `["en:beverages", "en:fruit-juices"]`).
- `nutriments`: Object containing nutritional values per 100g or 100ml:
  - `energy-kcal_100g` or `energy-kcal_100ml` or `energy-kcal_value` (energy in kcal).
  - `energy_100g` (energy in kJ; fallback if kcal fields are missing).
  - `proteins_100g` or `proteins_100ml` (proteins in g).
  - `carbohydrates_100g` or `carbohydrates_100ml` (carbs in g).
  - `fat_100g` or `fat_100ml` (fats in g).

---

## 3. API Response Mapping Strategy

To satisfy the contract in `plan.md` and keep the client load minimal, the proxy must map the raw response into a clean, unified structure.

### Critical Considerations for Client Consumption
1. **Liquid Product Detection (`isLiquidProduct(p)`)**:
   The client function `isLiquidProduct` in `app.js` inspects `quantity`, `categories`, and `categories_tags`. If these fields are omitted by the proxy, liquid detection (which decides whether to display `ml` or `g`) will fall back to using only the name, which is less accurate. The proxy must preserve these three fields.
2. **Nutrient Value Normalization**:
   Nutrients should be numbers, defaulting to `0` if missing. We should also handle kJ-to-kcal fallback (`1 kcal = 4.184 kJ`) if `energy-kcal` is missing.

### Proposed Mapping Logic
In `api/search.js`:
```javascript
const mappedProducts = (data.products || []).map(p => {
  const nut = p.nutriments || {};
  
  // Safely extract energy in kcal
  let energyKcal = 0;
  if (nut['energy-kcal_100g'] !== undefined) {
    energyKcal = Number(nut['energy-kcal_100g']);
  } else if (nut['energy-kcal_100ml'] !== undefined) {
    energyKcal = Number(nut['energy-kcal_100ml']);
  } else if (nut['energy-kcal_value'] !== undefined) {
    energyKcal = Number(nut['energy-kcal_value']);
  } else if (nut['energy_100g'] !== undefined) {
    // Convert kJ to kcal (1 kcal ≈ 4.184 kJ)
    energyKcal = Math.round(Number(nut['energy_100g']) / 4.184);
  }

  return {
    product_name_cs: p.product_name_cs || null,
    product_name: p.product_name || null,
    brands: p.brands || null,
    quantity: p.quantity || null,
    categories: p.categories || null,
    categories_tags: p.categories_tags || [],
    nutriments: {
      'energy-kcal_100g': energyKcal,
      'proteins_100g': Number(nut.proteins_100g ?? nut.proteins_100ml ?? 0),
      'carbohydrates_100g': Number(nut.carbohydrates_100g ?? nut.carbohydrates_100ml ?? 0),
      'fat_100g': Number(nut.fat_100g ?? nut.fat_100ml ?? 0)
    }
  };
});

return res.status(200).json({ products: mappedProducts });
```

---

## 4. Local Test Script Strategy (`test_search.js`)

To enable local verification without Vercel deployment, `test_search.js` can mock the Vercel request and response lifecycles.

### Test Script Architecture
1. **Mock Request & Response**: Create an execution harness that feeds a mock `req` and intercepts `res` methods (`status`, `json`, `end`, `setHeader`).
2. **Execute In-Process**: `require('./api/search.js')` directly into the test context and invoke it asynchronously.
3. **Assert Criteria**:
   - Query `'jablko'`: Expect `200 OK` status, a `products` array with `length >= 1`, and valid values for `energy-kcal_100g`, `proteins_100g`, `carbohydrates_100g`, and `fat_100g`.
   - Query `'xqyzzzz'` (nonsensical): Expect `200 OK` status, and an empty products array (`{ products: [] }`) instead of a `500 Server Error`.

### Proposed `test_search.js` Implementation Code
```javascript
const handler = require('./api/search.js');

async function runTest(query) {
  let statusCode = 200;
  let responseData = null;
  const headers = {};

  const req = {
    method: 'GET',
    query: { q: query }
  };

  const res = {
    setHeader(name, value) {
      headers[name] = value;
      return this;
    },
    status(code) {
      statusCode = code;
      return this;
    },
    json(data) {
      responseData = data;
      return this;
    },
    end() {
      return this;
    }
  };

  try {
    await handler(req, res);
    return { statusCode, responseData };
  } catch (error) {
    return { statusCode: 500, error: error.message };
  }
}

async function runSuite() {
  console.log("=== CALORIE TRACKER API PROXY TEST SUITE ===\n");

  // Test 1: Valid Czech food query ("jablko")
  try {
    const result = await runTest('jablko');
    console.log("Test 'jablko' Status Code:", result.statusCode);
    
    if (result.statusCode !== 200) {
      throw new Error(`Expected 200 OK, got ${result.statusCode}. Error: ${JSON.stringify(result.responseData || result.error)}`);
    }

    const data = result.responseData;
    if (!data || !Array.isArray(data.products)) {
      throw new Error("Response is missing 'products' array");
    }

    console.log(`Found ${data.products.length} products for 'jablko'.`);
    if (data.products.length === 0) {
      throw new Error("No products returned for 'jablko'");
    }

    const firstProduct = data.products[0];
    const name = firstProduct.product_name_cs || firstProduct.product_name || "Neznámý produkt";
    const brand = firstProduct.brands ? ` (${firstProduct.brands})` : "";
    console.log(`First Product: ${name}${brand}`);

    const nut = firstProduct.nutriments || {};
    const kcal = nut['energy-kcal_100g'];
    const proteins = nut['proteins_100g'];
    const carbs = nut['carbohydrates_100g'];
    const fat = nut['fat_100g'];

    console.log(`Nutritional values: Calories: ${kcal} kcal, Protein: ${proteins}g, Carbs: ${carbs}g, Fat: ${fat}g`);

    if (kcal === undefined || proteins === undefined || carbs === undefined || fat === undefined) {
      throw new Error("Product is missing required nutrient fields in nutriments object");
    }
    
    console.log("PASS: 'jablko' test completed successfully.\n");
  } catch (err) {
    console.error("FAIL: 'jablko' test failed:", err.message);
    process.exit(1);
  }

  // Test 2: Nonsensical query ("xqyzzzz")
  try {
    const result = await runTest('xqyzzzz');
    console.log("Test 'xqyzzzz' Status Code:", result.statusCode);

    if (result.statusCode !== 200) {
      throw new Error(`Expected 200 OK for nonsensical search, got ${result.statusCode}`);
    }

    const data = result.responseData;
    if (!data || !Array.isArray(data.products) || data.products.length !== 0) {
      throw new Error(`Expected empty products array [], got: ${JSON.stringify(data)}`);
    }

    console.log("PASS: 'xqyzzzz' test completed successfully.\n");
  } catch (err) {
    console.error("FAIL: 'xqyzzzz' test failed:", err.message);
    process.exit(1);
  }

  console.log("All tests passed successfully!");
}

runSuite();
```
