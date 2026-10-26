// FitAI MCP Server - Analytics, Coach Memory & Sync Module
const { applyTool, fmtProfile } = require('../api/_lib/plans');
const { applyStatsTool } = require('../api/_lib/tools_stats');

function registerStatsProfileTools(client) {
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
    'estimate_1rm',
    'Vypočítá teoretické maximum na jedno opakování (1RM) z pracovní váhy a opakování pomocí vzorců Brzycki a Epley, a spočítá tréninkové procentní zóny.',
    {
      properties: {
        weightKg: { type: 'number', description: 'Váha v kg.' },
        reps: { type: 'number', description: 'Počet opakování (doporučeno 1 až 10 pro přesnost).' },
        exerciseName: { type: 'string', description: 'Název cviku (pokud není uvedena váha/opakování, načte se z historie).' }
      }
    },\
    async (args) => {
      const w = Number(args.weightKg || 0);\
      const r = Number(args.reps || 0);\
      if (w > 0 && r > 0) {
        const epley = Math.round(w * (1 + r / 30));
        const brzycki = Math.round(w / (1.0278 - 0.0278 * r));
        const onerm = Math.round((epley + brzycki) / 2);

        const zones = {
          '100% (1RM)': onerm,
          '95% (1-2 op.)': Math.round(onerm * 0.95 / 2.5) * 2.5,
          '90% (3-4 op.)': Math.round(onerm * 0.90 / 2.5) * 2.5,
          '85% (5-6 op.)': Math.round(onerm * 0.85 / 2.5) * 2.5,
          '80% (7-8 op.)': Math.round(onerm * 0.80 / 2.5) * 2.5,
          '75% (9-10 op.)': Math.round(onerm * 0.75 / 2.5) * 2.5,
          '70% (Hypertrofie 10-12 op.)': Math.round(onerm * 0.70 / 2.5) * 2.5
        };

        return JSON.stringify({
          exercise: args.exerciseName || 'Cvik',
          input: `${w} kg × ${r} op.`,
          onerm,
          epley,
          brzycki,
          percentZonesKg: zones
        }, null, 2);
      }

      const state = await client.getState();
      const exName = args.exerciseName || args.name;
      const res = applyStatsTool('estimate_1rm', { exerciseName: exName }, state);
      return JSON.stringify(res, null, 2);
    }
  );

  def(
    'get_volume_stats',
    'Získá statistiky tréninkového objemu (celková tonáž ve zvednutých kilogramech a počet sérií).',
    {
      properties: {
        weeks: { type: 'number', description: 'Počet týdnů zpětně (výchozí 4).' }
      }
    },\
    async (args) => {
      const state = await client.getState();
      const days = (args.weeks || 4) * 7;
      const res = applyStatsTool('get_volume_stats', { days }, state);
      return JSON.stringify(res, null, 2);
    }
  );

  def(
    'get_progress_summary',
    'Vytvoří komplexní trenérský přehled: počet odjetých tréninků, splnění cílů, váhový progres a rekordy.',
    {
      properties: {
        days: { type: 'number', description: 'Počet dní zpětně (výchozí 30).' }
      }
    },\
    async (args) => {
      const state = await client.getState();
      const res = applyStatsTool('get_progress_summary', { days: args.days || 30 }, state);
      return JSON.stringify(res, null, 2);
    }
  );

  def(
    'detect_stagnation',
    'Analyzuje historii cviků a detekuje stagnaci (kde se váha ani opakování nepohnuly 3+ tréninky).',
    {},
    async () => {
      const state = await client.getState();
      const res = applyStatsTool('detect_stagnation', {}, state);
      return JSON.stringify(res, null, 2);
    }
  );

  def(
    'get_user_profile',
    'Zobrazí profil uživatele (věk, výška, váha, cíl, úroveň zkušeností, vybavení posilovny).',
    {},
    async () => {
      const state = await client.getState();
      return fmtProfile(state.profile);
    }
  );

  def(
    'update_user_profile',
    'Upraví údaje v profilu uživatele.',
    {
      properties: {
        age: { type: 'number', description: 'Věk uživatele.' },
        heightCm: { type: 'number', description: 'Výška v cm.' },
        weightKg: { type: 'number', description: 'Hmotnost v kg.' },
        goal: { type: 'string', description: 'Hlavní fitness cíl (nabírání, hubnutí, síla, kondice).' },
        experience: { type: 'string', description: 'Zkušenosti (začátečník, pokročilý).' },
        equipment: { type: 'string', description: 'Dostupné vybavení (posilovna, činky doma, vlastní váha).' },
        trainingDaysPerWeek: { type: 'number', description: 'Kolik dní v týdnu chce cvičit.' }
      }
    },\
    async (args) => {
      const state = await client.getState();
      const res = applyTool('save_profile', args, state);
      if (res && res.error) throw new Error(res.error);
      await client.saveState(state);
      return `Profil aktualizován: ${fmtProfile(state.profile)}`;
    }
  );

  def(
    'list_coach_memories',
    'Zobrazí trvalou paměť kouče – všechny zaznamenané fakty a preference o uživateli.',
    {},
    async () => {
      const state = await client.getState();
      const facts = state.coachMemories || [];
      if (!facts.length) return 'Kouč zatím nemá uloženy žádné specifické poznámky v paměti.';
      return facts.map((f, i) => `${i + 1}. ${f}`).join('\n');
    }
  );

  def(
    'add_coach_memory',
    'Uloží důležitý trvalý fakt do paměti kouče (např. "trénuje v Legends Gym Zlín", "nemá rád stroje na břicho").',
    {
      required: ['fact'],
      properties: {
        fact: { type: 'string', description: 'Text faktu k zapamatování.' }
      }
    },\
    async (args) => {
      const state = await client.getState();
      if (!Array.isArray(state.coachMemories)) state.coachMemories = [];
      state.coachMemories.push(args.fact.trim());
      await client.saveState(state);
      return `Uloženo do paměti: "${args.fact}"`;
    }
  );

  def(
    'forget_coach_memory',
    'Odstraní fakt z paměti kouče.',
    {
      required: ['fact'],
      properties: {
        fact: { type: 'string', description: 'Text faktu k zapomenutí.' }
      }
    },\
    async (args) => {
      const state = await client.getState();
      const before = (state.coachMemories || []).length;\
      state.coachMemories = (state.coachMemories || []).filter(\
        (f) => !f.toLowerCase().includes(args.fact.toLowerCase())\
      );\
      if (state.coachMemories.length === before) {\
        return `Fakt "${args.fact}" nebyl v paměti nalezen.`;\
      }\
      await client.saveState(state);\
      return `Fakt byl z paměti odstraněn.`;\
    }\
  );\

  def(\
    'fitai_login',\
    'Přihlásí se k FitAI účtu uživatele jménem a heslem a stáhne data z cloudu.',\
    {\
      required: ['username', 'password'],\
      properties: {\
        username: { type: 'string', description: 'Uživatelské jméno ve FitAI.' },\
        password: { type: 'string', description: 'Heslo k účtu.' }\
      }\
    },\
    async (args) => {\
      const res = await client.login(args.username, args.password);\
      return `Úspěšně přihlášen jako "${res.username}". Token získán a data stažena.`;\
    }\
  );\

  def(\
    'fitai_sync',\
    'Vynutí okamžitou synchronizaci dat mezi MCP serverem a FitAI cloudem.',\
    {\
      properties: {\
        forcePull: { type: 'boolean', description: 'Zda přednostně stáhnout nejnovější stav z cloudu.' }\
      }\
    },\
    async (args) => {\
      const state = await client.getState(args.forcePull);\
      const res = await client.saveState(state);\
      return JSON.stringify({\
        status: res.cloudSynced ? 'Synchronizováno s cloudem' : 'Uloženo pouze lokálně (nepřihlášen nebo offline)',\
        lastSync: res.lastSync,\
        error: res.cloudError || null\
      }, null, 2);\
    }\
  );\

  def(\
    'fitai_status',\
    'Zobrazí stav připojení k FitAI, přihlášeného uživatele a počty evidovaných dat.',\
    {},\
    async () => {\
      const st = client.getStatus();\
      return JSON.stringify(st, null, 2);\
    }\
  );\

  return tools;\
}\

module.exports = { registerStatsProfileTools };\
