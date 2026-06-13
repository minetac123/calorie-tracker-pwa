const handler = require('../../api/search.js');
const fs = require('fs');
const path = require('path');

const logFilePath = path.join(__dirname, 'challenge_test.log');
const logStream = fs.createWriteStream(logFilePath, { flags: 'w' });

function log(message, ...args) {
  const formatted = typeof message === 'string' ? message : JSON.stringify(message, null, 2);
  console.log(formatted, ...args);
  logStream.write(formatted + ' ' + args.join(' ') + '\n');
}

const originalFetch = globalThis.fetch;

function mockReq(query, method = 'GET') {
  return {
    method: method,
    query: query !== undefined ? { q: query } : {}
  };
}

function mockRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(name, value) {
      this.headers[name] = value;
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(data) {
      this.body = data;
      return this;
    },
    end() {
      return this;
    }
  };
  return res;
}

function setupMockFetch({ ok, status, jsonPayload, delay = 0, networkError = false }) {
  globalThis.fetch = async (url, options) => {
    if (networkError) {
      throw new TypeError('fetch failed');
    }

    if (options && options.signal) {
      if (options.signal.aborted) {
        const err = new Error('The operation was aborted.');
        err.name = 'AbortError';
        throw err;
      }

      if (delay > 0) {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            resolve();
          }, delay);
          options.signal.addEventListener('abort', () => {
            clearTimeout(timer);
            const err = new Error('The operation was aborted.');
            err.name = 'AbortError';
            reject(err);
          });
        });
      }
    } else if (delay > 0) {
      await new Promise(resolve => setTimeout(resolve, delay));
    }

    return {
      ok,
      status,
      json: async () => jsonPayload
    };
  };
}

function restoreFetch() {
  globalThis.fetch = originalFetch;
}

const tests = [];

function addTest(name, fn) {
  tests.push({ name, fn });
}

// -------------------------------------------------------------
// Test Case 1: OPTIONS request
// -------------------------------------------------------------
addTest('OPTIONS request handling', async () => {
  const req = mockReq('jablko', 'OPTIONS');
  const res = mockRes();
  
  await handler(req, res);
  
  if (res.statusCode !== 200) {
    throw new Error(`Expected status 200, got ${res.statusCode}`);
  }
  if (res.headers['Access-Control-Allow-Origin'] !== '*') {
    throw new Error(`Expected CORS origin header '*', got ${res.headers['Access-Control-Allow-Origin']}`);
  }
  log('  PASS: OPTIONS request returns 200 and headers.');
});

// -------------------------------------------------------------
// Test Case 2: POST/PUT/DELETE request
// -------------------------------------------------------------
addTest('Non-GET request handling (POST)', async () => {
  const req = mockReq('jablko', 'POST');
  const res = mockRes();
  
  await handler(req, res);
  
  if (res.statusCode !== 405) {
    throw new Error(`Expected status 405, got ${res.statusCode}`);
  }
  if (!res.body || res.body.error !== 'Metoda není povolena') {
    throw new Error(`Expected error body "Metoda není povolena", got ${JSON.stringify(res.body)}`);
  }
  log('  PASS: POST request returns 405 with proper Czech error message.');
});

// -------------------------------------------------------------
// Test Case 3: Missing query parameter
// -------------------------------------------------------------
addTest('Missing q query parameter', async () => {
  const req = mockReq(undefined, 'GET');
  const res = mockRes();
  
  await handler(req, res);
  
  if (res.statusCode !== 400) {
    throw new Error(`Expected status 400, got ${res.statusCode}`);
  }
  if (!res.body || res.body.error !== 'Chybí vyhledávací dotaz') {
    throw new Error(`Expected error body "Chybí vyhledávací dotaz", got ${JSON.stringify(res.body)}`);
  }
  log('  PASS: Missing q parameter returns 400 with proper error.');
});

// -------------------------------------------------------------
// Test Case 4: Empty query parameter
// -------------------------------------------------------------
addTest('Empty q query parameter', async () => {
  const req = mockReq('', 'GET');
  const res = mockRes();
  
  await handler(req, res);
  
  if (res.statusCode !== 400) {
    throw new Error(`Expected status 400, got ${res.statusCode}`);
  }
  if (!res.body || res.body.error !== 'Chybí vyhledávací dotaz') {
    throw new Error(`Expected error body "Chybí vyhledávací dotaz", got ${JSON.stringify(res.body)}`);
  }
  log('  PASS: Empty q parameter returns 400.');
});

// -------------------------------------------------------------
// Test Case 5: Whitespace-only query parameter
// -------------------------------------------------------------
addTest('Whitespace-only q query parameter', async () => {
  const req = mockReq('   ', 'GET');
  const res = mockRes();
  setupMockFetch({ ok: true, status: 200, jsonPayload: { products: [] } });
  
  try {
    await handler(req, res);
    
    // We want to see how the proxy handles it. Currently, it allows it through.
    log(`  INFO: Whitespace-only query returns status ${res.statusCode}. Body: ${JSON.stringify(res.body)}`);
    if (res.statusCode === 200) {
      log('  PASS: Handles whitespace query by forwarding it (returns empty list).');
    } else {
      throw new Error(`Unexpected status ${res.statusCode}`);
    }
  } finally {
    restoreFetch();
  }
});

// -------------------------------------------------------------
// Test Case 6: OpenFoodFacts Offline (Network failure)
// -------------------------------------------------------------
addTest('OpenFoodFacts Offline / Network failure', async () => {
  const req = mockReq('jablko', 'GET');
  const res = mockRes();
  setupMockFetch({ networkError: true });
  
  try {
    await handler(req, res);
    
    if (res.statusCode !== 500) {
      throw new Error(`Expected status 500, got ${res.statusCode}`);
    }
    if (!res.body || !res.body.error.includes('Chyba serveru: fetch failed')) {
      throw new Error(`Expected server error, got ${JSON.stringify(res.body)}`);
    }
    log('  PASS: Network failure returns 500 with descriptive error.');
  } finally {
    restoreFetch();
  }
});

// -------------------------------------------------------------
// Test Case 7: OpenFoodFacts Timeout
// -------------------------------------------------------------
addTest('OpenFoodFacts Timeout handling', async () => {
  const req = mockReq('jablko', 'GET');
  const res = mockRes();
  // Set delay to 9000ms, which is > 8000ms timeout
  setupMockFetch({ ok: true, status: 200, jsonPayload: { products: [] }, delay: 9000 });
  
  const startTime = Date.now();
  try {
    await handler(req, res);
    const duration = Date.now() - startTime;
    
    log(`  INFO: Timeout test finished in ${duration}ms.`);
    if (res.statusCode !== 504) {
      throw new Error(`Expected status 504 on timeout, got ${res.statusCode}. Body: ${JSON.stringify(res.body)}`);
    }
    if (!res.body || res.body.error !== 'Dotaz na OpenFoodFacts vypršel (timeout)') {
      throw new Error(`Expected timeout error message, got ${JSON.stringify(res.body)}`);
    }
    log('  PASS: 8-second timeout correctly aborted and returned 504.');
  } finally {
    restoreFetch();
  }
});

// -------------------------------------------------------------
// Test Case 8: OpenFoodFacts returns non-OK status (502 Bad Gateway)
// -------------------------------------------------------------
addTest('OpenFoodFacts returns 502 Bad Gateway', async () => {
  const req = mockReq('jablko', 'GET');
  const res = mockRes();
  setupMockFetch({ ok: false, status: 502, jsonPayload: null });
  
  try {
    await handler(req, res);
    
    if (res.statusCode !== 502) {
      throw new Error(`Expected status 502, got ${res.statusCode}`);
    }
    if (!res.body || res.body.error !== 'Chyba při komunikaci s Open Food Facts API (502)') {
      throw new Error(`Expected message for API status error, got ${JSON.stringify(res.body)}`);
    }
    log('  PASS: Correct handling and propagation of downstream non-OK HTTP status.');
  } finally {
    restoreFetch();
  }
});

// -------------------------------------------------------------
// Test Case 9: Missing nutriments entirely
// -------------------------------------------------------------
addTest('Missing nutriments object entirely', async () => {
  const req = mockReq('jablko', 'GET');
  const res = mockRes();
  setupMockFetch({
    ok: true,
    status: 200,
    jsonPayload: {
      products: [
        {
          product_name: 'Test Product',
          brands: 'Test Brand'
          // no nutriments key
        }
      ]
    }
  });
  
  try {
    await handler(req, res);
    
    if (res.statusCode !== 200) {
      throw new Error(`Expected status 200, got ${res.statusCode}`);
    }
    
    const p = res.body.products[0];
    if (!p.nutriments) {
      throw new Error('Expected nutriments object to be created even if missing from source');
    }
    
    // Check fields are null
    const keys = ['energy-kcal_100g', 'energy-kcal_100ml', 'energy-kcal_value', 'proteins_100g', 'proteins_100ml', 'carbohydrates_100g', 'carbohydrates_100ml', 'fat_100g', 'fat_100ml', 'calories', 'protein', 'carbs', 'fat'];
    for (const key of keys) {
      if (p.nutriments[key] !== null) {
        throw new Error(`Expected key "${key}" to be null, got: ${p.nutriments[key]}`);
      }
    }
    
    log('  PASS: Missing nutriments object does not crash and fills default nulls.');
  } finally {
    restoreFetch();
  }
});

// -------------------------------------------------------------
// Test Case 10: Empty nutriments object
// -------------------------------------------------------------
addTest('Empty nutriments object {}', async () => {
  const req = mockReq('jablko', 'GET');
  const res = mockRes();
  setupMockFetch({
    ok: true,
    status: 200,
    jsonPayload: {
      products: [
        {
          product_name: 'Test Product',
          nutriments: {}
        }
      ]
    }
  });
  
  try {
    await handler(req, res);
    const p = res.body.products[0];
    const keys = ['energy-kcal_100g', 'proteins_100g', 'carbohydrates_100g', 'fat_100g', 'calories', 'protein', 'carbs', 'fat'];
    for (const key of keys) {
      if (p.nutriments[key] !== null) {
        throw new Error(`Expected key "${key}" to be null, got: ${p.nutriments[key]}`);
      }
    }
    log('  PASS: Empty nutriments object does not crash and fills default nulls.');
  } finally {
    restoreFetch();
  }
});

// -------------------------------------------------------------
// Test Case 11: Partially missing keys (calories from 100g)
// -------------------------------------------------------------
addTest('Partially missing keys (has energy-kcal_100g and proteins_100g)', async () => {
  const req = mockReq('jablko', 'GET');
  const res = mockRes();
  setupMockFetch({
    ok: true,
    status: 200,
    jsonPayload: {
      products: [
        {
          product_name: 'Test Product',
          nutriments: {
            'energy-kcal_100g': 120,
            proteins_100g: 8.5
          }
        }
      ]
    }
  });
  
  try {
    await handler(req, res);
    const p = res.body.products[0];
    
    if (p.nutriments.calories !== 120) {
      throw new Error(`Expected calories to be 120, got: ${p.nutriments.calories}`);
    }
    if (p.nutriments.protein !== 8.5) {
      throw new Error(`Expected protein to be 8.5, got: ${p.nutriments.protein}`);
    }
    if (p.nutriments.carbs !== null) {
      throw new Error(`Expected carbs to be null, got: ${p.nutriments.carbs}`);
    }
    if (p.nutriments.fat !== null) {
      throw new Error(`Expected fat to be null, got: ${p.nutriments.fat}`);
    }
    
    log('  PASS: Correctly maps calories/protein and handles missing carbs/fat.');
  } finally {
    restoreFetch();
  }
});

// -------------------------------------------------------------
// Test Case 12: Partially missing keys (fallbacks check - ml and value)
// -------------------------------------------------------------
addTest('Fallback checks for calories/macronutrients (100ml / value)', async () => {
  const req = mockReq('jablko', 'GET');
  const res = mockRes();
  setupMockFetch({
    ok: true,
    status: 200,
    jsonPayload: {
      products: [
        {
          product_name: 'Liquid Product',
          nutriments: {
            'energy-kcal_100ml': 45,
            proteins_100ml: 0.5,
            carbohydrates_100ml: 11,
            fat_100ml: 0.1
          }
        },
        {
          product_name: 'Value Product',
          nutriments: {
            'energy-kcal_value': 350
          }
        }
      ]
    }
  });
  
  try {
    await handler(req, res);
    const p1 = res.body.products[0];
    const p2 = res.body.products[1];
    
    if (p1.nutriments.calories !== 45) {
      throw new Error(`Expected liquid calories to fallback to energy-kcal_100ml (45), got: ${p1.nutriments.calories}`);
    }
    if (p1.nutriments.protein !== 0.5) {
      throw new Error(`Expected liquid protein to be 0.5, got: ${p1.nutriments.protein}`);
    }
    if (p1.nutriments.carbs !== 11) {
      throw new Error(`Expected liquid carbs to be 11, got: ${p1.nutriments.carbs}`);
    }
    if (p1.nutriments.fat !== 0.1) {
      throw new Error(`Expected liquid fat to be 0.1, got: ${p1.nutriments.fat}`);
    }
    
    if (p2.nutriments.calories !== 350) {
      throw new Error(`Expected value calories to fallback to energy-kcal_value (350), got: ${p2.nutriments.calories}`);
    }
    
    log('  PASS: Fallbacks to ml and value keys work correctly.');
  } finally {
    restoreFetch();
  }
});

// -------------------------------------------------------------
// Test Case 13: Only kJ energy present (no kcal)
// -------------------------------------------------------------
addTest('Only kJ is present, no kcal keys', async () => {
  const req = mockReq('jablko', 'GET');
  const res = mockRes();
  setupMockFetch({
    ok: true,
    status: 200,
    jsonPayload: {
      products: [
        {
          product_name: 'kJ Product',
          nutriments: {
            'energy-kj_100g': 418.4,
            'energy_value': 418.4
          }
        }
      ]
    }
  });
  
  try {
    await handler(req, res);
    const p = res.body.products[0];
    
    log(`  INFO: Only kJ present. Calories output: ${p.nutriments.calories}`);
    if (p.nutriments.calories !== null) {
      throw new Error(`Expected calories to be null (since kJ is not mapped), got: ${p.nutriments.calories}`);
    }
    
    log('  PASS: Verified that calories is null when only kJ is provided (mapping limitation confirmed).');
  } finally {
    restoreFetch();
  }
});

// -------------------------------------------------------------
// Test Case 14: Non-numeric and weird types for nutriments
// -------------------------------------------------------------
addTest('Non-numeric values in nutriments (strings, arrays, objects)', async () => {
  const req = mockReq('jablko', 'GET');
  const res = mockRes();
  setupMockFetch({
    ok: true,
    status: 200,
    jsonPayload: {
      products: [
        {
          product_name: 'Stringy Product',
          nutriments: {
            'energy-kcal_100g': '150', // string number
            proteins_100g: '10.5',
            carbohydrates_100g: 'not-a-number', // invalid string
            fat_100g: null // explicit null
          }
        }
      ]
    }
  });
  
  try {
    await handler(req, res);
    const p = res.body.products[0];
    
    if (p.nutriments.calories !== '150') {
      throw new Error(`Expected string '150' to be preserved, got: ${p.nutriments.calories}`);
    }
    if (p.nutriments.protein !== '10.5') {
      throw new Error(`Expected string '10.5' to be preserved, got: ${p.nutriments.protein}`);
    }
    if (p.nutriments.carbs !== 'not-a-number') {
      throw new Error(`Expected string 'not-a-number' to be preserved, got: ${p.nutriments.carbs}`);
    }
    if (p.nutriments.fat !== null) {
      throw new Error(`Expected null fat to be preserved, got: ${p.nutriments.fat}`);
    }
    
    log('  PASS: Confirmed that API passes through non-numeric/string values without parsing/validation.');
  } finally {
    restoreFetch();
  }
});

// -------------------------------------------------------------
// Runner execution
// -------------------------------------------------------------
async function runAll() {
  log(`=== Running Challenge Tests at ${new Date().toISOString()} ===`);
  let passedCount = 0;
  let failedCount = 0;
  
  for (const t of tests) {
    log(`\nRunning: ${t.name}`);
    try {
      await t.fn();
      passedCount++;
    } catch (err) {
      log(`  FAIL: ${err.message}`);
      if (err.stack) {
        log(err.stack);
      }
      failedCount++;
    }
  }
  
  log('\n=== Summary ===');
  log(`Total tests: ${tests.length}`);
  log(`Passed:      ${passedCount}`);
  log(`Failed:      ${failedCount}`);
  
  logStream.end();
  
  if (failedCount > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runAll();
