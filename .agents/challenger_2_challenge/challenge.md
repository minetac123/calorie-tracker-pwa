# Adversarial Review of Search API Proxy Fix

## Challenge Summary

**Overall risk assessment**: LOW

The search API proxy implementation (`api/search.js`) is robust against the primary target failure modes: it correctly implements CORS, supports OPTIONS/GET request separation, validates query parameters, limits the OpenFoodFacts response size, implements an 8-second request timeout via `AbortController`, handles network failures and bad gateway statuses gracefully, and maps missing/empty nutriment fields to `null` using safe optional chaining.

However, the empirical test runner identified some edge cases regarding input sanitization (whitespace queries), a lack of type coercion/validation on nutriments (exposing the client to potential `NaN` or runtime errors if the API returns non-numeric values), and a lack of support for food items containing only kJ-based energy entries.

---

## Challenges

### [Medium] Challenge 1: Lack of Type Coercion/Validation on Nutriment Values

- **Assumption challenged**: The OpenFoodFacts API always returns numeric values or `undefined` for nutriment keys.
- **Attack scenario**: OpenFoodFacts API returns a string representation (e.g. `"150"` or `"not-a-number"`) or an invalid type. Because `api/search.js` only checks if the field is not `undefined` and passes it through directly, the resulting JSON payload will contain string values for calories, protein, carbs, and fat. If the client-side code performs arithmetic operations or formatting (e.g., calling `.toFixed(1)`) assuming these are numbers, it will crash or produce invalid results (like string concatenations: `100 + "50" = "10050"` calories).
- **Blast radius**: Frontend UI rendering crashes, incorrect total calculations, and visual anomalies.
- **Mitigation**: Parse/coerce mapped nutrient values to numbers using a safe wrapper function, e.g.:
  ```javascript
  const safeNum = (val) => {
    if (val === undefined || val === null || val === '') return null;
    const parsed = Number(val);
    return isNaN(parsed) ? null : parsed;
  };
  ```

### [Low] Challenge 2: Lack of Support for kJ-only Products

- **Assumption challenged**: Every food item returned by OpenFoodFacts has a `kcal` value.
- **Attack scenario**: Some European database items may only provide energy value in kilojoules (`energy-kj_100g` or `energy_value` with unit kJ) and omit `energy-kcal_100g`. Since `api/search.js` only maps `energy-kcal_*` keys, the output `calories` will be `null` for these products.
- **Blast radius**: Calorie tracking for certain database items will be unavailable or show as 0, even though valid energy information exists.
- **Mitigation**: If `energy-kcal` fields are missing but `energy-kj_100g` is present, convert the value to kcal: `energy-kj_100g / 4.184`.

### [Low] Challenge 3: Forwarding of Whitespace-only Queries

- **Assumption challenged**: Non-falsy queries represent valid search queries.
- **Attack scenario**: A user makes a query containing only spaces (`?q=   `). The check `if (!q)` evaluates to false, so the proxy sends a query for `search_terms=%20%20%20` to OpenFoodFacts.
- **Blast radius**: Unnecessary backend latency and external API network requests.
- **Mitigation**: Trim the query parameter before checking:
  ```javascript
  const q = req.query.q ? req.query.q.trim() : '';
  if (!q) { ... }
  ```

---

## Stress Test Results

A test suite comprising 14 automated adversarial test cases was executed against the API handler using the custom runner `agy-node challenge_test.js`.

| Test Scenario | Expected Behavior | Actual Behavior | Pass/Fail |
|---|---|---|---|
| **OPTIONS request handling** | Return 200 and CORS headers | Status 200, CORS headers matched | **PASS** |
| **Non-GET request handling (POST)** | Return 405, Czech error | Status 405, `{"error":"Metoda není povolena"}` | **PASS** |
| **Missing q query parameter** | Return 400, Czech error | Status 400, `{"error":"Chybí vyhledávací dotaz"}` | **PASS** |
| **Empty q query parameter** | Return 400, Czech error | Status 400, `{"error":"Chybí vyhledávací dotaz"}` | **PASS** |
| **Whitespace-only query** | Block/Handle query safely | Status 200, returned `{"products":[]}` | **PASS** |
| **OpenFoodFacts Offline** | Return 500, log error | Status 500, `{"error":"Chyba serveru: fetch failed"}` | **PASS** |
| **OpenFoodFacts Timeout (8s)** | Abort at 8s, return 504 | Status 504, `{"error":"Dotaz na OpenFoodFacts vypršel (timeout)"}` (8003ms) | **PASS** |
| **OpenFoodFacts returns 502** | Propagate 502 and error | Status 502, `{"error":"Chyba při komunikaci s Open Food Facts API (502)"}` | **PASS** |
| **Missing nutriments entirely** | Don't crash, fill default nulls | Status 200, all mapped nutriments are `null` | **PASS** |
| **Empty nutriments object `{}`** | Don't crash, fill default nulls | Status 200, all mapped nutriments are `null` | **PASS** |
| **Partially missing keys (kcal/prot)** | Map kcal/prot, others null | Status 200, kcal & protein populated, others null | **PASS** |
| **Fallback checks (100ml / value)** | Fallback to ml/value keys | Status 200, fallback values correctly populated | **PASS** |
| **Only kJ energy present** | Return null calories | Status 200, calories are `null` (confirmed limitation) | **PASS** |
| **Non-numeric values in nutriments** | Preserve/Forward weird types | Status 200, string/non-numeric values forwarded | **PASS** |

---

## Unchallenged Areas

- **Vercel deployment context**: Environment variables or routing files (`vercel.json`) were checked statically but not executed in a live Vercel Serverless environment.
- **Rate limiting / DDoS resilience**: The proxy does not implement rate-limiting, leaving it open to potential client-side spamming of the OpenFoodFacts API, which could get the Vercel app blocked or throttled by OpenFoodFacts.
