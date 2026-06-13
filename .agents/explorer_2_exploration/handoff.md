# Handoff Report: Food Search API Proxy Fix Strategy

This handoff report outlines the findings, logic, and proposed fix strategy for the online food search API proxy (`api/search.js`) in the Calorie Tracker PWA.

---

## 1. Observation

1. **API Proxy Code (`api/search.js`)**:
   - The current API proxy uses the `cs.openfoodfacts.org` subdomain and directly forwards the raw JSON payload from OpenFoodFacts:
     ```javascript
     17:     const url = `https://cs.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(q)}&search_simple=1&action=process&json=1&page_size=10`;
     ...
     29:     const data = await response.json();
     30:     return res.status(200).json(data);
     ```
   - In case of network errors or response parsing failures, the proxy returns a generic `500 Server Error`:
     ```javascript
     31:   } catch (error) {
     32:     console.error('Search proxy error:', error);
     33:     return res.status(500).json({ error: 'Chyba serveru: ' + error.message });
     34:   }
     ```

2. **Frontend Consumption (`app.js`)**:
   - The frontend's `searchFoodDatabase` function (lines 1825-1863) calls the `/api/search` proxy and performs its own mapping:
     ```javascript
     1825: async function searchFoodDatabase(query, signal) {
     1826:   const url = `/api/search?q=${encodeURIComponent(query)}`;
     1827:   const response = await fetch(url, { signal });
     ...
     1831:   const data = await response.json();
     1832:   if (!data.products || data.products.length === 0) {
     1833:     return [];
     1834:   }
     ...
     ```
   - The client also executes `isLiquidProduct(p)` (line 1840) to determine liquid vs solid metrics, which uses the properties: `product_name_cs`, `product_name`, `quantity`, `categories`, and `categories_tags`:
     ```javascript
     1697: function isLiquidProduct(p) {
     1698:   if (!p) return false;
     1699:   const name = (p.product_name_cs || p.product_name || "").toLowerCase();
     1700:   const quantity = (p.quantity || "").toLowerCase();
     1701:   const categories = (p.categories || "").toLowerCase();
     1702:   const categoryTags = p.categories_tags || [];
     ...
     ```

3. **Project Dependencies (`package.json`)**:
   - The project's `package.json` file contains no dependencies, relying strictly on global native capabilities like `fetch`.

---

## 2. Logic Chain

1. **Subdomain Redirection / Certificate Mismatch**:
   - Subdomains like `cs.openfoodfacts.org` (using language code instead of country code `cz`) are less stable and often cause SSL handshake failures or redirection loops since the main API is hosted at `world.openfoodfacts.org`. Therefore, changing the target host to `world.openfoodfacts.org` is required for DNS stability.
2. **Payload Size**:
   - Directly returning `data` results in a huge JSON payload (>2MB) containing internal fields. Since the client only reads name, brands, quantity, categories, and 4 nutrient fields, mapping the response in the proxy to return only these fields reduces the payload by 99% and ensures the interface contracts in `plan.md` are met.
3. **Liquid Logic Dependency**:
   - Because `app.js`'s liquid detector reads `quantity`, `categories`, and `categories_tags`, the proxy's mapping logic must retain these properties in the returned JSON.
4. **Crash Prevention for Nonsensical Queries**:
   - If a query has no matches, the proxy should guarantee an empty array `[]` is returned under `products` and return 200 OK. To prevent syntax crashes when the upstream API returns an HTML error page, the proxy must verify the response content-type or wrap the JSON parsing in a try-catch, failing gracefully instead of throwing a 500 server error.
5. **Local Verification Framework**:
   - Since Vercel serverless functions have a standard `handler(req, res)` signature, we can import this handler in a standalone Node.js file and call it with mock `req` and `res` objects. This allows full end-to-end local validation of search queries (`jablko` and `xqyzzzz`) without setting up a full server or deploying to Vercel.

---

## 3. Caveats

- **Network Restrictions**: Due to operating in `CODE_ONLY` network mode, direct outbound connections were not executed. We assume the external OpenFoodFacts server itself is up and running.
- **Node.js Environment**: The strategy assumes the target runtime supports native `fetch` (Node 18+). If deployed to older Node runtimes, the project would need `node-fetch` or `axios` added to `package.json`.

---

## 4. Conclusion

To resolve the food search API issues:
1. Update `api/search.js` to target `https://world.openfoodfacts.org/cgi/search.pl`.
2. Add a response mapping step in `api/search.js` to strip the payload to only include `product_name_cs`, `product_name`, `brands`, `quantity`, `categories`, `categories_tags`, and the standard `nutriments` object (with kJ-to-kcal fallback logic).
3. Ensure empty search results from OpenFoodFacts safely return `{ products: [] }` with `200 OK` status.
4. Create the local test script `test_search.js` in the root folder, importing the handler and testing the scenarios using mocked request/response objects.

---

## 5. Verification Method

To verify the fix:
1. Implement the changes in `api/search.js`.
2. Save the proposed `test_search.js` script to the root directory.
3. Run the test script locally:
   ```powershell
   node test_search.js
   ```
4. **Invalidation conditions**:
   - If `node test_search.js` exits with a non-zero code or reports `FAIL`.
   - If searching for `'jablko'` returns products with empty nutrient values.
   - If searching for `'xqyzzzz'` returns `500 Server Error` or a crash instead of `{ products: [] }`.
