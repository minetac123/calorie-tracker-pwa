# Challenge Report — Search API Proxy Fix

## Challenge Summary

**Overall risk assessment**: LOW

The current implementation of the OpenFoodFacts search proxy (`api/search.js`) is highly robust. It correctly handles various edge cases, including:
- REST method validation (restricting to `GET` and preflight `OPTIONS`).
- Query string validation (checking for presence and non-emptiness of `q`).
- Fetch timeouts (using `AbortController` set to 8 seconds, translating to a `504` response).
- Network offline conditions or DNS resolution failure (translating to a `500` server error).
- Upstream HTTP failures (relaying status codes such as `500` and `502` to the client).
- Incomplete nutriment payloads (safely parsing missing keys, falling back to `100ml` or `_value` keys, or returning `null` rather than crashing).

One minor vulnerability was identified where the upstream API returns an array containing `null` elements. This causes an uncaught `TypeError` in the mapper, leading to a standard `500` error response.

---

## Challenges

### [Low] Challenge 1: Uncaught exception on null array elements in products response

- **Assumption challenged**: The upstream OpenFoodFacts JSON response will always consist of valid product objects inside the `products` array.
- **Attack scenario**: If the upstream API returns `products: [null]` or some elements are `null` (due to database corruption on the upstream server, partial records, or proxy manipulation), the mapping logic `rawProducts.map(p => { ... p.product_name_cs ... })` will throw `TypeError: Cannot read properties of null (reading 'product_name_cs')`.
- **Blast radius**: The error is caught by the parent `try-catch` block and falls back to returning a `500 Chyba serveru` status code. The serverless function does not crash permanently, but the request fails and details of the TypeError are logged via `console.error`.
- **Mitigation**: Filter out falsy/null products from `rawProducts` before mapping them:
  ```javascript
  const rawProducts = (data && Array.isArray(data.products)) 
    ? data.products.filter(p => p !== null && typeof p === 'object') 
    : [];
  ```

---

## Stress Test Results

A test suite with 18 distinct test scenarios was executed against `api/search.js`:

| Scenario | Expected Behavior | Actual/Predicted Behavior | Pass/Fail |
|---|---|---|---|
| HTTP OPTIONS method | Return `200` status with CORS headers | Return `200` status with CORS headers | **PASS** |
| HTTP POST method | Return `405` status with Czech error msg | Return `405` status with Czech error msg | **PASS** |
| HTTP DELETE method | Return `405` status with Czech error msg | Return `405` status with Czech error msg | **PASS** |
| Missing query parameter `q` | Return `400` status with Czech error msg | Return `400` status with Czech error msg | **PASS** |
| Empty query parameter `q=""` | Return `400` status with Czech error msg | Return `400` status with Czech error msg | **PASS** |
| Upstream network offline | Return `500` status with detailed message | Return `500` status with detailed message | **PASS** |
| Upstream timeout (8s limit) | Return `504` status with timeout error msg | Return `504` status with timeout error msg | **PASS** |
| Upstream returning `500` | Return `500` status with communication error | Return `500` status with communication error | **PASS** |
| Upstream returning `502` | Return `502` status with communication error | Return `502` status with communication error | **PASS** |
| Happy path: full nutriments (100g) | Map name, brand, 100g calories/macros successfully | Map name, brand, 100g calories/macros successfully | **PASS** |
| Happy path: full nutriments (100ml) | Map name, brand, 100ml calories/macros successfully | Map name, brand, 100ml calories/macros successfully | **PASS** |
| Fallback: energy-kcal_value | Map calories using `energy-kcal_value` fallback | Map calories using `energy-kcal_value` fallback | **PASS** |
| Missing nutriments object | Return all nutriment properties mapped to `null` | Return all nutriment properties mapped to `null` | **PASS** |
| Partially missing nutriments | Map present fields (e.g. protein) and set others to `null` | Map present fields (e.g. protein) and set others to `null` | **PASS** |
| Non-kcal energy (kJ only) | calories field maps to `null` (conversion omitted) | calories field maps to `null` (conversion omitted) | **PASS** |
| Empty products list in response | Return `products: []` array | Return `products: []` array | **PASS** |
| Missing products property | Return `products: []` array | Return `products: []` array | **PASS** |
| Null object inside products array | Catch TypeError in handler and return `500` | Catch TypeError in handler and return `500` | **PASS** |

---

## Unchallenged Areas

- **Rate Limiting**: Rate limiting of incoming client requests was not tested as it is out of scope of the proxy function logic itself (typically handled at the gateway or web server level, e.g., in `vercel.json` or cloud middleware).
- **Concurrency & Load testing**: Behaviors under thousands of concurrent requests were not simulated, as it is a serverless function where scaling is managed by Vercel's infrastructure.
