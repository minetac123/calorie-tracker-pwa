// FitAI MCP Server - Nutrition, Food & Body Tools Module
const { applyTool, fmtTargets } = require('../api/_lib/plans');
const { applyBodyTool } = require('../api/_lib/tools_body');

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function registerNutritionBodyTools(client) {
  const tools = [];

  function def(name, description, inputSchema, handler) {
    tools.push({
      name,
      description,
      inputSchema: {
        type: 'object',
        properties: inputSchema.properties || {},
        required: inputSchema.required || []
      },
      handler
    });
  }

  def(
    'get_food_log',
    'Získá přehled zapsaných jídel, celkový součet kalorií a maker pro dnešek nebo zadaný den.',
    {
      properties: {
        date: { type: 'string', description: 'Datum ve formátu YYYY-MM-DD (výchozí dnešek).' }
      }
    },
    async (args) => {
      const state = await client.getState();
      const d = args.date || todayStr();
      const items = (state.logs && state.logs[d]) || [];
      const targets = state.targets || { calories: 2000, protein: 140, carbs: 220, fat: 65 };

      let totalKcal = 0, totalP = 0, totalC = 0, totalF = 0;
      items.forEach((item) => {
        totalKcal += Number(item.calories || 0);
        totalP += Number(item.protein || 0);
        totalC += Number(item.carbs || 0);
        totalF += Number(item.fat || 0);
      });

      return JSON.stringify({
        date: d,
        totals: {
          calories: Math.round(totalKcal),
          protein: Math.round(totalP),
          carbs: Math.round(totalC),
          fat: Math.round(totalF)
        },
        targets,
        remaining: {
          calories: Math.round(targets.calories - totalKcal),
          protein: Math.round(targets.protein - totalP),
          carbs: Math.round(targets.carbs - totalC),
          fat: Math.round(targets.fat - totalF)
        },
        itemsCount: items.length,
        items
      }, null, 2);
    }
  );

  def(
    'log_food_item',
    'Zapíše jídlo do jídelníčku uživatele (název, kalorie, bílkoviny, sacharidy, tuky, gramáž a kategorie).',
    {
      required: ['name', 'calories', 'protein', 'carbs', 'fat'],
      properties: {
        name: { type: 'string', description: 'Název jídla nebo suroviny.' },
        calories: { type: 'number', description: 'Kalorie (kcal).' },
        protein: { type: 'number', description: 'Bílkoviny v gramech.' },
        carbs: { type: 'number', description: 'Sacharidy v gramech.' },
        fat: { type: 'number', description: 'Tuky v gramech.' },
        amount: { type: 'string', description: 'Množství / gramáž (např. "200g", "1 porce").' },
        category: { type: 'string', description: 'Kategorie (Snídaně, Oběd, Večeře, Svačina).' },
        date: { type: 'string', description: 'Datum ve formátu YYYY-MM-DD (výchozí dnešek).' }
      }
    },
    async (args) => {
      const state = await client.getState();
      const d = args.date || todayStr();
      if (!state.logs) state.logs = {};
      if (!Array.isArray(state.logs[d])) state.logs[d] = [];

      const item = {
        id: 'food_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6),
        time: new Date().toTimeString().slice(0, 5),
        name: args.name,
        amount: args.amount || '1 porce',
        calories: Math.round(Number(args.calories) || 0),
        protein: Math.round(Number(args.protein) || 0),
        carbs: Math.round(Number(args.carbs) || 0),
        fat: Math.round(Number(args.fat) || 0),
        category: args.category || 'Jídlo'
      };

      state.logs[d].push(item);
      await client.saveState(state);
      return `Jídlo "${args.name}" (${item.calories} kcal, ${item.protein}g B) bylo zapsáno do dne ${d}.`;
    }
  );

  def(
    'delete_food_item',
    'Smaže zapsané jídlo z denního přehledu podle ID nebo názvu.',
    {
      properties: {
        foodId: { type: 'string', description: 'ID jídla.' },
        foodName: { type: 'string', description: 'Název jídla ke smazání.' },
        date: { type: 'string', description: 'Datum YYYY-MM-DD (výchozí dnešek).' }
      }
    },
    async (args) => {
      const state = await client.getState();
      const d = args.date || todayStr();
      const list = (state.logs && state.logs[d]) || [];
      const initLen = list.length;

      state.logs[d] = list.filter((item) => {
        if (args.foodId && item.id === args.foodId) return false;
        if (args.foodName && item.name?.toLowerCase().includes(args.foodName.toLowerCase())) return false;
        return true;
      });

      if (state.logs[d].length === initLen) {
        return `Žádné odpovídající jídlo pro smazání nebylo nalezeno v datu ${d}.`;
      }
      await client.saveState(state);\n      return `Jídlo bylo smazáno.`;
    }
  );

  def(
    'get_targets',
    'Získá aktuální denní kalorické a makro cíle.',
    {},
    async () => {
      const state = await client.getState();
      return fmtTargets(state.targets);
    }
  );

  def(
    'set_targets',
    'Nastaví nebo upraví denní nutriční cíle (kalorie, bílkoviny, sacharidy, tuky).',
    {
      properties: {
        calories: { type: 'number', description: 'Denní cíl kalorií v kcal.' },
        protein: { type: 'number', description: 'Denní cíl bílkovin v g.' },
        carbs: { type: 'number', description: 'Denní cíl sacharidů v g.' },
        fat: { type: 'number', description: 'Denní cíl tuků v g.' }
      }
    },
    async (args) => {
      const state = await client.getState();
      const res = applyTool('set_targets', args, state);
      if (res && res.error) throw new Error(res.error);
      await client.saveState(state);
      return `Denní cíle nastaveny: ${fmtTargets(state.targets)}`;
    }
  );

  def(
    'set_calorie_mode',
    'Dočasně upraví denní kalorie na zadaný počet dní (dovolená, svátky, cheat day, refeed, nemoc). Po uplynutí se samy vrátí.',
    {
      required: ['label', 'calories', 'days'],
      properties: {
        label: { type: 'string', description: 'Název režimu (např. Dovolená, Vánoce, Refeed day).' },
        calories: { type: 'number', description: 'Upravený denní kalorický příjem v kcal.' },
        days: { type: 'number', description: 'Počet dní, po které má režim trvat.' }
      }
    },
    async (args) => {
      const state = await client.getState();
      const res = applyTool('set_calorie_mode', {
        label: args.label,
        calories: args.calories,
        days: args.days
      }, state);
      if (res && res.error) throw new Error(res.error);
      await client.saveState(state);
      return `Nastaven dočasný režim "${args.label}": ${args.calories} kcal na ${args.days} dní.`;
    }
  );

  def(
    'clear_calorie_mode',
    'Zruší běžící dočasný kalorický režim a vrátí standardní cíle.',
    {},
    async () => {
      const state = await client.getState();
      const res = applyTool('clear_calorie_mode', {}, state);
      if (res && res.error) throw new Error(res.error);
      await client.saveState(state);
      return 'Dočasný kalorický režim byl zrušen.';
    }
  );

  def(
    'get_weight_history',
    'Získá historii tělesné hmotnosti a trend.',
    {
      properties: {
        limit: { type: 'number', description: 'Počet posledních záznamů (výchozí 20).' }
      }
    },
    async (args) => {
      const state = await client.getState();
      const logs = (state.weightLogs || []).slice(0, args.limit || 20);
      return JSON.stringify(logs, null, 2);
    }
  );

  def(
    'log_weight',
    'Zapíše tělesnou váhu v kg na dnešek nebo zadané datum.',
    {
      required: ['weightKg'],
      properties: {
        weightKg: { type: 'number', description: 'Váha v kg (např. 74.5).' },
        date: { type: 'string', description: 'Datum YYYY-MM-DD (výchozí dnešek).' }
      }
    },
    async (args) => {
      const state = await client.getState();
      const d = args.date || todayStr();
      const res = applyBodyTool('log_weight', { weight: args.weightKg, date: d }, state);
      if (!res.ok) throw new Error(res.error);
      await client.saveState(state);
      return res.note || `Váha ${args.weightKg} kg byla zapsána pro datum ${d}.`;
    }
  );

  def(
    'log_body_measurement',
    'Zapíše obvody těla v cm (pas, hrudník, paže, stehna, boky, krk).',
    {
      properties: {
        date: { type: 'string', description: 'Datum YYYY-MM-DD.' },
        waist: { type: 'number', description: 'Obvod pasu v cm.' },
        chest: { type: 'number', description: 'Obvod hrudníku v cm.' },
        arm: { type: 'number', description: 'Obvod paže v cm.' },
        thigh: { type: 'number', description: 'Obvod stehna v cm.' },
        hips: { type: 'number', description: 'Obvod boků v cm.' },
        neck: { type: 'number', description: 'Obvod krku v cm.' }
      }
    },
    async (args) => {
      const state = await client.getState();
      const d = args.date || todayStr();
      const res = applyBodyTool('log_body_measurement', {
        date: d,
        waist: args.waist,
        chest: args.chest,
        arm: args.arm,
        thigh: args.thigh,
        hips: args.hips,
        neck: args.neck
      }, state);
      if (!res.ok) throw new Error(res.error);
      await client.saveState(state);
      return res.note || `Tělesné míry byly uloženy pro datum ${d}.`;
    }
  );

  def(
    'log_water',
    'Zapíše příjem vody v mililitrech.',
    {
      required: ['ml'],
      properties: {
        ml: { type: 'number', description: 'Množství vody v ml (např. 500).' },
        date: { type: 'string', description: 'Datum YYYY-MM-DD (výchozí dnešek).' }
      }
    },
    async (args) => {
      const state = await client.getState();
      const d = args.date || todayStr();
      const res = applyBodyTool('log_water', { ml: args.ml, date: d }, state);
      if (!res.ok) throw new Error(res.error);
      await client.saveState(state);
      return res.note || `Vypito ${args.ml} ml vody.`;
    }
  );

  def(
    'log_cardio',
    'Zapíše kardio aktivitu (běh, chůze, plavání, kolo - délka, km, intenzita).',
    {
      required: ['type', 'durationMinutes'],
      properties: {
        type: { type: 'string', description: 'Typ aktivity (běh, chůze, plavání, kolo, veslování).' },
        durationMinutes: { type: 'number', description: 'Trvání v minutách.' },
        distanceKm: { type: 'number', description: 'Vzdálenost v kilometrech.' },
        intensity: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Intenzita.' },
        date: { type: 'string', description: 'Datum YYYY-MM-DD.' }
      }
    },
    async (args) => {
      const state = await client.getState();
      const d = args.date || todayStr();
      const res = applyBodyTool('log_cardio', {
        type: args.type,
        minutes: args.durationMinutes || args.minutes,
        distanceKm: args.distanceKm,
        intensity: args.intensity || 'medium',
        date: d
      }, state);
      if (!res.ok) throw new Error(res.error);
      await client.saveState(state);
      return res.note || `Kardio (${args.type}, ${args.durationMinutes} min) bylo zapsáno.`;
    }
  );

  def(
    'log_sleep',
    'Zapíše dobu spánku a kvalitu regenerace (vhodné pro integraci s WHOOP 5.0).',
    {
      required: ['hours'],
      properties: {
        hours: { type: 'number', description: 'Počet hodin spánku (např. 7.5).' },
        quality: { type: 'number', description: 'Kvalita spánku 1-5.' },
        date: { type: 'string', description: 'Datum YYYY-MM-DD.' }
      }
    },
    async (args) => {
      const state = await client.getState();
      const d = args.date || todayStr();
      const res = applyBodyTool('log_sleep', {
        hours: args.hours,
        quality: args.quality,
        date: d
      }, state);
      if (!res.ok) throw new Error(res.error);
      await client.saveState(state);
      return res.note || `Spánek (${args.hours} h) byl zapsán.`;
    }
  );

  def(
    'log_injury',
    'Zaeviduje zranění nebo omezení (např. bolest zápěstí, přetížení hamstringu), aby kouč neplánoval problémové cviky.',
    {
      required: ['affectedBodyPart'],
      properties: {
        affectedBodyPart: { type: 'string', description: 'Zasažená partie (rameno, koleno, zápěstí, záda).' },
        severity: { type: 'number', description: 'Závažnost 1-5 (výchozí 3).' },
        notes: { type: 'string', description: 'Podrobnosti o bolesti a cvicích, kterým se vyhnout.' },
        date: { type: 'string', description: 'Datum YYYY-MM-DD.' }
      }
    },
    async (args) => {
      const state = await client.getState();
      const d = args.date || todayStr();
      const res = applyBodyTool('log_injury', {
        bodyPart: args.affectedBodyPart || args.bodyPart || args.name,
        severity: args.severity || 3,
        note: args.notes || args.note || '',
        date: d
      }, state);
      if (!res.ok) throw new Error(res.error);
      await client.saveState(state);
      return res.note || `Zranění "${args.affectedBodyPart || args.name}" bylo zaevidováno.`;
    }
  );

  def(
    'resolve_injury',
    'Označí dříve zapsané zranění za vyléčené a vyřešené.',
    {
      required: ['affectedBodyPart'],
      properties: {
        affectedBodyPart: { type: 'string', description: 'Část těla (např. rameno, koleno).' }
      }
    },
    async (args) => {
      const state = await client.getState();
      const res = applyBodyTool('resolve_injury', {
        bodyPart: args.affectedBodyPart || args.bodyPart || args.name
      }, state);
      if (!res.ok) throw new Error(res.error);
      await client.saveState(state);
      return res.note || 'Zranění bylo označeno za vyřešené.';
    }
  );

  return tools;
}

module.exports = { registerNutritionBodyTools };
