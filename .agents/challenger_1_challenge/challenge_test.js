const assert = require('assert');
const fs = require('fs');
const path = require('path');
const handler = require('../../api/search.js');

// Mock request helper
function mockReq({ method = 'GET', query = {} } = {}) {
  return {
    method,
    query
  };
}

// Mock response helper
function mockRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    ended: false,
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
      this.ended = true;
      return this;
    },
    end() {
      this.ended = true;
      return this;
    }
  };
  return res;
}

// Intercept console.error to avoid spamming the log with expected stack traces
const originalConsoleError = console.error;
let capturedErrors = [];
function silenceConsoleError() {
  console.error = (...args) => {
    capturedErrors.push(args.join(' '));
  };
}
function restoreConsoleError() {
  console.error = originalConsoleError;
}

const originalFetch = globalThis.fetch;
let mockFetchHandler = null;

// Mock global fetch
globalThis.fetch = async (url, options) => {
  if (mockFetchHandler) {
    return mockFetchHandler(url, options);
  }
  throw new Error('Fetch mock not set');
};

const results = [];
const logMessages = [];

function log(msg) {
  console.log(msg);
  logMessages.push(msg);
}

function test(name, fn) {
  results.push({ name, fn });
}

// Register tests

// 1. HTTP Method Restrictions
test('HTTP OPTIONS method should return 200 and end', async () => {
  const req = mockReq({ method: 'OPTIONS' });
  const res = mockRes();
  await handler(req, res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body, null);
  assert.strictEqual(res.ended, true);
  assert.strictEqual(res.headers['Access-Control-Allow-Origin'], '*');
});

test('HTTP POST method should be forbidden (405)', async () => {
  const req = mockReq({ method: 'POST', query: { q: 'test' } });
  const res = mockRes();
  await handler(req, res);
  assert.strictEqual(res.statusCode, 405);
  assert.deepStrictEqual(res.body, { error: 'Metoda není povolena' });
});

test('HTTP DELETE method should be forbidden (405)', async () => {
  const req = mockReq({ method: 'DELETE', query: { q: 'test' } });
  const res = mockRes();
  await handler(req, res);
  assert.strictEqual(res.statusCode, 405);
  assert.deepStrictEqual(res.body, { error: 'Metoda není povolena' });
});

// 2. Query Parameters Validation
test('Missing query parameter should return 400', async () => {
  const req = mockReq({ method: 'GET' });
  const res = mockRes();
  await handler(req, res);
  assert.strictEqual(res.statusCode, 400);
  assert.deepStrictEqual(res.body, { error: 'Chybí vyhledávací dotaz' });
});

test('Empty query parameter q="" should return 400', async () => {
  const req = mockReq({ method: 'GET', query: { q: '' } });
  const res = mockRes();
  await handler(req, res);
  assert.strictEqual(res.statusCode, 400);
  assert.deepStrictEqual(res.body, { error: 'Chybí vyhledávací dotaz' });
});

// 3. OpenFoodFacts Network/Offline Handling
test('Network offline or DNS error should return 500', async () => {
  mockFetchHandler = async () => {
    throw new TypeError('fetch failed');
  };
  silenceConsoleError();
  capturedErrors = [];
  const req = mockReq({ method: 'GET', query: { q: 'apple' } });
  const res = mockRes();
  try {
    await handler(req, res);
    assert.strictEqual(res.statusCode, 500);
    assert.match(res.body.error, /Chyba serveru: fetch failed/);
    assert.ok(capturedErrors.length > 0);
  } finally {
    restoreConsoleError();
  }
});

// 4. OpenFoodFacts Timeout Handling
test('Timeout from OpenFoodFacts should return 504', async () => {
  mockFetchHandler = async (url, options) => {
    const err = new DOMException('The user aborted a request.', 'AbortError');
    throw err;
  };
  const req = mockReq({ method: 'GET', query: { q: 'apple' } });
  const res = mockRes();
  await handler(req, res);
  assert.strictEqual(res.statusCode, 504);
  assert.deepStrictEqual(res.body, { error: 'Dotaz na OpenFoodFacts vypršel (timeout)' });
});

// 5. OpenFoodFacts HTTP Error Responses
test('OpenFoodFacts returning 500 status should return corresponding status and error', async () => {
  mockFetchHandler = async () => {
    return {
      ok: false,
      status: 500,
      json: async () => ({})
    };
  };
  const req = mockReq({ method: 'GET', query: { q: 'apple' } });
  const res = mockRes();
  await handler(req, res);
  assert.strictEqual(res.statusCode, 500);
  assert.deepStrictEqual(res.body, { error: 'Chyba při komunikaci s Open Food Facts API (500)' });
});

test('OpenFoodFacts returning 502 status should return corresponding status and error', async () => {
  mockFetchHandler = async () => {
    return {
      ok: false,
      status: 502,
      json: async () => ({})
    };
  };
  const req = mockReq({ method: 'GET', query: { q: 'apple' } });
  const res = mockRes();
  await handler(req, res);
  assert.strictEqual(res.statusCode, 502);
  assert.deepStrictEqual(res.body, { error: 'Chyba při komunikaci s Open Food Facts API (502)' });
});

// 6. Nutriments Mapping Edge Cases

test('Happy path with all nutriments present (100g format)', async () => {
  mockFetchHandler = async () => {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        products: [
          {
            product_name_cs: 'Jablko',
            product_name: 'Apple',
            brands: 'Bio',
            quantity: '500g',
            categories: 'Ovoce',
            categories_tags: ['en:fruits'],
            nutriments: {
              'energy-kcal_100g': 52,
              proteins_100g: 0.3,
              carbohydrates_100g: 14,
              fat_100g: 0.2
            }
          }
        ]
      })
    };
  };
  const req = mockReq({ method: 'GET', query: { q: 'apple' } });
  const res = mockRes();
  await handler(req, res);
  assert.strictEqual(res.statusCode, 200);
  const prod = res.body.products[0];
  assert.strictEqual(prod.product_name_cs, 'Jablko');
  assert.strictEqual(prod.nutriments.calories, 52);
  assert.strictEqual(prod.nutriments.protein, 0.3);
  assert.strictEqual(prod.nutriments.carbs, 14);
  assert.strictEqual(prod.nutriments.fat, 0.2);
});

test('Happy path with all nutriments present (100ml format)', async () => {
  mockFetchHandler = async () => {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        products: [
          {
            product_name: 'Juice',
            nutriments: {
              'energy-kcal_100ml': 45,
              proteins_100ml: 0.1,
              carbohydrates_100ml: 10,
              fat_100ml: 0.0
            }
          }
        ]
      })
    };
  };
  const req = mockReq({ method: 'GET', query: { q: 'juice' } });
  const res = mockRes();
  await handler(req, res);
  assert.strictEqual(res.statusCode, 200);
  const prod = res.body.products[0];
  assert.strictEqual(prod.nutriments.calories, 45);
  assert.strictEqual(prod.nutriments.protein, 0.1);
  assert.strictEqual(prod.nutriments.carbs, 10);
  assert.strictEqual(prod.nutriments.fat, 0.0);
});

test('Nutriments populated using energy-kcal_value fallback', async () => {
  mockFetchHandler = async () => {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        products: [
          {
            product_name: 'Test Value',
            nutriments: {
              'energy-kcal_value': 88
            }
          }
        ]
      })
    };
  };
  const req = mockReq({ method: 'GET', query: { q: 'test' } });
  const res = mockRes();
  await handler(req, res);
  assert.strictEqual(res.statusCode, 200);
  const prod = res.body.products[0];
  assert.strictEqual(prod.nutriments.calories, 88);
  assert.strictEqual(prod.nutriments.protein, null);
  assert.strictEqual(prod.nutriments.carbs, null);
  assert.strictEqual(prod.nutriments.fat, null);
});

test('Product with null or missing nutriments object', async () => {
  mockFetchHandler = async () => {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        products: [
          {
            product_name: 'No Nutriments',
            nutriments: null
          }
        ]
      })
    };
  };
  const req = mockReq({ method: 'GET', query: { q: 'none' } });
  const res = mockRes();
  await handler(req, res);
  assert.strictEqual(res.statusCode, 200);
  const prod = res.body.products[0];
  assert.deepStrictEqual(prod.nutriments, {
    'energy-kcal_100g': null,
    'energy-kcal_100ml': null,
    'energy-kcal_value': null,
    proteins_100g: null,
    proteins_100ml: null,
    carbohydrates_100g: null,
    carbohydrates_100ml: null,
    fat_100g: null,
    fat_100ml: null,
    calories: null,
    protein: null,
    carbs: null,
    fat: null
  });
});

test('Product with partially missing nutriments (only proteins_100g, fat/carbs missing)', async () => {
  mockFetchHandler = async () => {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        products: [
          {
            product_name: 'Partially Missing',
            nutriments: {
              proteins_100g: 2.5
            }
          }
        ]
      })
    };
  };
  const req = mockReq({ method: 'GET', query: { q: 'part' } });
  const res = mockRes();
  await handler(req, res);
  assert.strictEqual(res.statusCode, 200);
  const prod = res.body.products[0];
  assert.strictEqual(prod.nutriments.calories, null);
  assert.strictEqual(prod.nutriments.protein, 2.5);
  assert.strictEqual(prod.nutriments.carbs, null);
  assert.strictEqual(prod.nutriments.fat, null);
});

test('Product with non-kcal energy (energy-kj_100g only)', async () => {
  mockFetchHandler = async () => {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        products: [
          {
            product_name: 'Only kJ',
            nutriments: {
              'energy-kj_100g': 1200
            }
          }
        ]
      })
    };
  };
  const req = mockReq({ method: 'GET', query: { q: 'kj' } });
  const res = mockRes();
  await handler(req, res);
  assert.strictEqual(res.statusCode, 200);
  const prod = res.body.products[0];
  assert.strictEqual(prod.nutriments.calories, null);
});

test('Empty products list in OpenFoodFacts response', async () => {
  mockFetchHandler = async () => {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        products: []
      })
    };
  };
  const req = mockReq({ method: 'GET', query: { q: 'notfound' } });
  const res = mockRes();
  await handler(req, res);
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(res.body.products, []);
});

test('OpenFoodFacts response with null/undefined products array', async () => {
  mockFetchHandler = async () => {
    return {
      ok: true,
      status: 200,
      json: async () => ({})
    };
  };
  const req = mockReq({ method: 'GET', query: { q: 'nullproducts' } });
  const res = mockRes();
  await handler(req, res);
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(res.body.products, []);
});

test('Adversarial: product object itself is null inside products array', async () => {
  mockFetchHandler = async () => {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        products: [null]
      })
    };
  };
  silenceConsoleError();
  capturedErrors = [];
  const req = mockReq({ method: 'GET', query: { q: 'nullproduct' } });
  const res = mockRes();
  try {
    await handler(req, res);
    assert.strictEqual(res.statusCode, 500);
    assert.match(res.body.error, /Chyba serveru/);
    assert.ok(capturedErrors.length > 0);
  } finally {
    restoreConsoleError();
  }
});


// Test executor
async function runTests() {
  log(`=== Starting Adversarial Search Proxy Tests ===`);
  log(`Date: ${new Date().toISOString()}`);
  log(`Total registered tests: ${results.length}\n`);

  let passed = 0;
  let failed = 0;

  for (const t of results) {
    try {
      await t.fn();
      log(`[ PASS ] ${t.name}`);
      passed++;
    } catch (err) {
      log(`[ FAIL ] ${t.name}`);
      log(`         Error: ${err.message}`);
      if (err.stack) {
        log(`         Stack: ${err.stack.split('\n').slice(0, 3).join('\n         ')}`);
      }
      failed++;
    }
  }

  log(`\n=== Test Results Summary ===`);
  log(`Total:  ${results.length}`);
  log(`Passed: ${passed}`);
  log(`Failed: ${failed}`);

  // Write log file
  const logContent = logMessages.join('\n');
  fs.writeFileSync(path.join(__dirname, 'challenge_test.log'), logContent, 'utf8');

  // Restore fetch
  globalThis.fetch = originalFetch;

  process.exit(failed > 0 ? 1 : 0);
}

runTests();
