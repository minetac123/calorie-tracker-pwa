const handler = require('./proposed_search.js');

async function runTest(query) {
  let statusCode = null;
  let responseData = null;

  const req = {
    method: 'GET',
    query: { q: query }
  };

  const res = {
    setHeader: () => {},
    status: (code) => {
      statusCode = code;
      return res;
    },
    json: (data) => {
      responseData = data;
      return res;
    },
    end: () => {
      return res;
    }
  };

  try {
    await handler(req, res);
    return { statusCode, responseData };
  } catch (error) {
    return { error };
  }
}

async function main() {
  console.log('--- SPUŠTĚNÍ TESTŮ VYHLEDÁVÁNÍ POTRAVIN (PROPOSED) ---');

  // Test 1: jablko
  console.log('\nTest 1: Vyhledávání dotazu "jablko"');
  const result1 = await runTest('jablko');
  
  if (result1.error) {
    console.error('❌ Test 1 selhal: Neočekávaná chyba psovodu:', result1.error);
    process.exit(1);
  }

  if (result1.statusCode !== 200) {
    console.error(`❌ Test 1 selhal: Neočekávaný stavový kód ${result1.statusCode}`);
    console.error('Odpověď:', result1.responseData);
    process.exit(1);
  }

  const products1 = result1.responseData.products;
  if (!Array.isArray(products1)) {
    console.error('❌ Test 1 selhal: Odpověď neobsahuje pole "products"');
    process.exit(1);
  }

  console.log(`Počet nalezených produktů: ${products1.length}`);
  if (products1.length === 0) {
    console.error('❌ Test 1 selhal: Nebyl nalezen žádný produkt pro dotaz "jablko"');
    process.exit(1);
  }

  const p = products1[0];
  console.log('Vzorek prvního produktu:', JSON.stringify(p, null, 2));

  // Verify calories, protein, carbs, fat are defined
  const nut = p.nutriments || {};
  const energy = nut['energy-kcal_100g'] !== null && nut['energy-kcal_100g'] !== undefined ? nut['energy-kcal_100g'] : nut['energy-kcal_100ml'];
  const protein = nut['proteins_100g'] !== null && nut['proteins_100g'] !== undefined ? nut['proteins_100g'] : nut['proteins_100ml'];
  const carbs = nut['carbohydrates_100g'] !== null && nut['carbohydrates_100g'] !== undefined ? nut['carbohydrates_100g'] : nut['carbohydrates_100ml'];
  const fat = nut['fat_100g'] !== null && nut['fat_100g'] !== undefined ? nut['fat_100g'] : nut['fat_100ml'];

  console.log(`Makroživiny: Kalorie=${energy}, Bílkoviny=${protein}, Sacharidy=${carbs}, Tuky=${fat}`);

  if (energy === null || energy === undefined) console.warn('⚠️ Varování: Kalorie chybí.');
  if (protein === null || protein === undefined) console.warn('⚠️ Varování: Bílkoviny chybí.');
  if (carbs === null || carbs === undefined) console.warn('⚠️ Varování: Sacharidy chybí.');
  if (fat === null || fat === undefined) console.warn('⚠️ Varování: Tuky chybí.');

  console.log('✅ Test 1 úspěšný.');

  // Test 2: xqyzzzz
  console.log('\nTest 2: Vyhledávání nesmyslného dotazu "xqyzzzz"');
  const result2 = await runTest('xqyzzzz');

  if (result2.error) {
    console.error('❌ Test 2 selhal: Neočekávaná chyba psovodu:', result2.error);
    process.exit(1);
  }

  if (result2.statusCode !== 200) {
    console.error(`❌ Test 2 selhal: Neočekávaný stavový kód ${result2.statusCode}`);
    console.error('Odpověď:', result2.responseData);
    process.exit(1);
  }

  const products2 = result2.responseData.products;
  if (!Array.isArray(products2)) {
    console.error('❌ Test 2 selhal: Odpověď neobsahuje pole "products"');
    process.exit(1);
  }

  console.log(`Počet nalezených produktů pro nesmyslný dotaz: ${products2.length}`);
  if (products2.length !== 0) {
    console.error('❌ Test 2 selhal: Očekáváno prázdné pole [], ale vráceno:', products2);
    process.exit(1);
  }

  console.log('✅ Test 2 úspěšný.');
  console.log('\n🎉 VŠECHNY TESTY ÚSPĚŠNĚ DOKONČENY!');
}

main().catch(err => {
  console.error('Neošetřená chyba v testu:', err);
  process.exit(1);
});
