const handler = require('./api/search.js');

// Mock request and response structures
function mockReq(query) {
  return {
    method: 'GET',
    query: { q: query }
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

async function testQuery(query) {
  console.log(`\nTesting query: "${query}"...`);
  const req = mockReq(query);
  const res = mockRes();
  
  try {
    await handler(req, res);
    console.log(`Response Status: ${res.statusCode}`);
    if (res.statusCode !== 200) {
      console.error(`Error Response:`, res.body);
      return false;
    }
    
    const data = res.body;
    if (!data || !Array.isArray(data.products)) {
      console.error(`Invalid response structure: expected { products: [...] } but got`, data);
      return false;
    }
    
    console.log(`Found ${data.products.length} products.`);
    
    if (query === 'jablko') {
      if (data.products.length === 0) {
        console.error(`Fail: "jablko" query returned 0 products.`);
        return false;
      }
      
      const p = data.products[0];
      console.log(`First product: "${p.product_name_cs || p.product_name || 'unknown'}" by "${p.brands || 'unknown'}"`);
      const nuts = p.nutriments || {};
      const kcal = nuts['energy-kcal_100g'] !== undefined ? nuts['energy-kcal_100g'] : (nuts['energy-kcal_100ml'] || nuts['energy-kcal_value']);
      const prot = nuts.proteins_100g !== undefined ? nuts.proteins_100g : nuts.proteins_100ml;
      const carb = nuts.carbohydrates_100g !== undefined ? nuts.carbohydrates_100g : nuts.carbohydrates_100ml;
      const fat = nuts.fat_100g !== undefined ? nuts.fat_100g : nuts.fat_100ml;
      
      console.log(`Nutriments (per 100g/ml):`);
      console.log(` - Calories: ${kcal} kcal`);
      console.log(` - Protein: ${prot} g`);
      console.log(` - Carbs: ${carb} g`);
      console.log(` - Fat: ${fat} g`);
      
      if (kcal === undefined || prot === undefined || carb === undefined || fat === undefined ||
          kcal === null || prot === null || carb === null || fat === null) {
        console.error(`Fail: Macronutrients are missing or null.`);
        return false;
      }
      console.log(`Pass: "jablko" test passed successfully!`);
    } else if (query === 'xqyzzzz') {
      if (data.products.length !== 0) {
        console.error(`Fail: "xqyzzzz" query returned ${data.products.length} products instead of 0.`);
        return false;
      }
      console.log(`Pass: "xqyzzzz" test passed successfully (returned empty array).`);
    }
    
    return true;
  } catch (err) {
    console.error(`Fail: Unhandled exception:`, err);
    return false;
  }
}

async function runAll() {
  if (typeof fetch === 'undefined') {
    console.error('Error: Node.js version 18+ is required to run this test script due to the use of native fetch API.');
    process.exit(1);
  }
  
  console.log('Starting Calorie Tracker food search API integration tests...');
  const t1 = await testQuery('jablko');
  const t2 = await testQuery('xqyzzzz');
  
  if (t1 && t2) {
    console.log('\nAll tests passed successfully! ✅');
    process.exit(0);
  } else {
    console.error('\nSome tests failed. ❌');
    process.exit(1);
  }
}

runAll();
