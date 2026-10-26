// Automated test suite for FitAI MCP Server
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const SERVER_PATH = path.join(__dirname, 'server.js');
const TEST_CACHE = path.join(__dirname, '..', '.test_fitai_cache.json');

async function runTests() {
  console.log('--- Spouštím integrační testy FitAI MCP Serveru ---');

  if (fs.existsSync(TEST_CACHE)) {
    fs.unlinkSync(TEST_CACHE);
  }

  const proc = spawn('node', [SERVER_PATH], {
    env: Object.assign({}, process.env, {
      FITAI_CACHE_FILE: TEST_CACHE
    })
  });

  let idCounter = 1;
  const pendingRequests = new Map();

  proc.stdout.on('data', (data) => {
    const lines = data.toString().split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const msg = JSON.parse(line);
        if (msg.id && pendingRequests.has(msg.id)) {
          const resolve = pendingRequests.get(msg.id);
          pendingRequests.delete(msg.id);
          resolve(msg);
        }
      } catch (e) {
        console.error('Test stdout parse error:', e.message);
      }
    }
  });

  proc.stderr.on('data', (data) => {
    // console.log('[Server Stderr]', data.toString().trim());
  });

  function sendReq(method, params) {
    const id = idCounter++;
    return new Promise((resolve) => {
      pendingRequests.set(id, resolve);
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  // 1. Initialize
  console.log('1. Testuji initialize...');
  const initRes = await sendReq('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'test-client', version: '1.0' }
  });
  if (!initRes.result?.serverInfo?.name) throw new Error('Initialize selhalo');
  console.log('   OK - Server:', initRes.result.serverInfo.name);

  // 2. tools/list
  console.log('2. Testuji tools/list...');
  const toolsRes = await sendReq('tools/list', {});
  const tools = toolsRes.result?.tools || [];
  console.log(`   OK - Načteno ${tools.length} nástrojů`);
  if (tools.length < 40) throw new Error(`Očekáváno 40+ nástrojů, ale nalezeno jen ${tools.length}`);

  // Helper pro tools/call
  async function callTool(name, args) {
    const res = await sendReq('tools/call', { name, arguments: args });
    if (res.result?.isError) {
      throw new Error(`Tool ${name} vrátil chybu: ${res.result.content?.[0]?.text}`);
    }
    return res.result?.content?.[0]?.text;
  }

  // 3. Status
  console.log('3. Testuji fitai_status...');
  const statusOut = await callTool('fitai_status', {});
  console.log('   OK - Status:', JSON.parse(statusOut).apiUrl);

  // 4. Přidání cviku do plánu
  console.log('4. Testuji add_exercise_to_plan...');
  const addExOut = await callTool('add_exercise_to_plan', {
    day: 'mon',
    name: 'Bench press s velkou činkou',
    sets: 4,
    reps: '6-8',
    weight: '85 kg',
    restSec: 120,
    note: 'Kontrolovaná excentrika, pauza na hrudníku'
  });
  console.log('   OK - Výsledek přidání:', addExOut);

  // 5. Rozcvičkové série
  console.log('5. Testuji suggest_warmup_sets...');
  const warmupOut = await callTool('suggest_warmup_sets', {
    exerciseName: 'Bench press s velkou činkou',
    targetWeightKg: 85
  });
  console.log('   OK - Rozcvička vygenerována:\n', warmupOut);

  // 6. Zápis odcvičené série
  console.log('6. Testuji log_set...');
  const logSetOut = await callTool('log_set', {
    exerciseName: 'Bench press s velkou činkou',
    weightKg: 85,
    reps: 7,
    rpe: 8.5
  });
  console.log('   OK - Zápis série:', logSetOut);

  // 7. Historie cviku
  console.log('7. Testuji get_exercise_history...');
  const histOut = await callTool('get_exercise_history', {
    exerciseName: 'Bench press s velkou činkou'
  });
  console.log('   OK - Historie získána');

  // 8. 1RM odhad
  console.log('8. Testuji estimate_1rm...');
  const rmOut = await callTool('estimate_1rm', {
    weightKg: 85,
    reps: 7,
    exerciseName: 'Bench press s velkou činkou'
  });
  console.log('   OK - 1RM odhad:', JSON.parse(rmOut).onerm, 'kg');

  // 9. Zápis jídla
  console.log('9. Testuji log_food_item & get_food_log...');
  await callTool('log_food_item', {
    name: 'Hovězí steak s batáty',
    calories: 620,
    protein: 52,
    carbs: 45,
    fat: 18,
    category: 'Oběd'
  });
  const foodLogOut = await callTool('get_food_log', {});
  const parsedFood = JSON.parse(foodLogOut);
  console.log(`   OK - Jídlo zapsáno (celkem ${parsedFood.totals.calories} kcal, ${parsedFood.totals.protein}g bílkovin)`);

  // 10. Zápis ranní váhy
  console.log('10. Testuji log_weight...');
  const weightOut = await callTool('log_weight', { weightKg: 74.2 });
  console.log('   OK - Váha zapsána:', weightOut);

  // 11. Paměť kouče
  console.log('11. Testuji add_coach_memory & list_coach_memories...');
  await callTool('add_coach_memory', {
    fact: 'Trénuje v Legends Gym Zlín, prioritou je síla a hypertrofie hrudníku a ramen.'
  });
  const memsOut = await callTool('list_coach_memories', {});
  console.log('   OK - Paměť kouče:\n' + memsOut);

  // 12. Deload týden
  console.log('12. Testuji deload_week...');
  const deloadOut = await callTool('deload_week', {
    intensityReductionPct: 15,
    volumeReductionPct: 30
  });
  console.log('   OK - Deload aplikován:', deloadOut);

  proc.kill('SIGINT');
  if (fs.existsSync(TEST_CACHE)) {
    fs.unlinkSync(TEST_CACHE);
  }
  console.log('\n✅ VŠECHNY MCP TESTY ÚSPĚŠNĚ PROŠLY! 🔥🤝');
}

runTests().catch((err) => {
  console.error('\n❌ Testy selhaly:', err);
  process.exit(1);
});
