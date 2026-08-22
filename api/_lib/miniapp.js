// Coach-generated mini apps.
//
// The coach can build a small purpose-made screen for a situation the plan
// doesn't cover — a restaurant menu tonight, a trip, a party, meal prep.
//
// It emits a DECLARATIVE SPEC, never code. The client renders the blocks with
// its own components, so nothing the model produces is ever executed and the
// result always looks like the rest of the app. Everything below is the shape
// of that spec plus the validation that makes model output safe to store.

const MINIAPP_BLOCK_TYPES = ['info', 'options', 'checklist', 'stats'];

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function str(v, max) {
  return String(v == null ? '' : v).slice(0, max);
}

function genId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

// An option the user can pick — a dish, a snack, a whole combo. Macros are
// optional: some options are just choices, others are loggable food.
function normOption(o) {
  if (!o || !o.name) return null;
  const hasMacros = o.calories != null;
  const out = {
    id: o.id || genId('opt'),
    name: str(o.name, 90),
    description: o.description ? str(o.description, 200) : '',
    tag: o.tag ? str(o.tag, 30) : '',
    recommended: o.recommended === true
  };
  if (hasMacros) {
    out.calories = Math.round(num(o.calories));
    out.protein = Math.round(num(o.protein) * 10) / 10;
    out.carbs = Math.round(num(o.carbs) * 10) / 10;
    out.fat = Math.round(num(o.fat) * 10) / 10;
    out.amount = o.amount ? str(o.amount, 30) : '';
    out.loggable = true;
  }
  return out;
}

function normBlock(b) {
  if (!b || !MINIAPP_BLOCK_TYPES.includes(b.type)) return null;

  if (b.type === 'info') {
    if (!b.text) return null;
    return { type: 'info', title: str(b.title, 80), text: str(b.text, 600) };
  }

  if (b.type === 'options') {
    const options = (b.options || []).map(normOption).filter(Boolean).slice(0, 20);
    if (!options.length) return null;
    return {
      type: 'options',
      title: str(b.title, 80),
      note: b.note ? str(b.note, 300) : '',
      options
    };
  }

  if (b.type === 'checklist') {
    const items = (b.items || [])
      .map((i) => {
        const label = str(i && (i.label || i), 120);
        return label ? { id: (i && i.id) || genId('chk'), label, done: false } : null;
      })
      .filter(Boolean)
      .slice(0, 25);
    if (!items.length) return null;
    return { type: 'checklist', title: str(b.title, 80), items };
  }

  if (b.type === 'stats') {
    const items = (b.items || [])
      .map((i) => (i && i.label && i.value != null)
        ? { label: str(i.label, 40), value: str(i.value, 24), sub: i.sub ? str(i.sub, 40) : '' }
        : null)
      .filter(Boolean)
      .slice(0, 6);
    if (!items.length) return null;
    return { type: 'stats', title: str(b.title, 80), items };
  }

  return null;
}

// Build a stored mini app from a tool call. Returns null when nothing usable
// survived validation.
function buildMiniApp(args, existing) {
  const a = args || {};
  const blocks = (a.blocks || []).map(normBlock).filter(Boolean).slice(0, 10);
  if (!blocks.length) return null;

  return {
    id: (existing && existing.id) || a.id || genId('app'),
    title: str(a.title, 60) || 'Bez názvu',
    subtitle: a.subtitle ? str(a.subtitle, 120) : '',
    icon: a.icon ? str(a.icon, 8) : '📱',
    context: a.context ? str(a.context, 200) : '',
    blocks,
    createdAt: (existing && existing.createdAt) || Date.now(),
    updatedAt: Date.now()
  };
}

// Compact rendering for the coach's own context, so it can talk about an app
// it made earlier and update it instead of building a duplicate.
function fmtMiniApps(apps) {
  if (!Array.isArray(apps) || !apps.length) return 'Zatím žádné appky.';
  return apps.map((app) => {
    const parts = (app.blocks || []).map((b) => {
      if (b.type === 'options') return `${b.options.length} voleb (${b.options.slice(0, 4).map((o) => o.name).join(', ')}${b.options.length > 4 ? '…' : ''})`;
      if (b.type === 'checklist') return `checklist ${b.items.length} položek`;
      if (b.type === 'stats') return `${b.items.length} čísel`;
      return 'text';
    });
    return `- [id:${app.id}] ${app.icon} ${app.title}${app.subtitle ? ` — ${app.subtitle}` : ''}: ${parts.join(', ')}`;
  }).join('\n');
}

// ---------------------------------------------------------------------------
// Tool declarations
// ---------------------------------------------------------------------------

const OPTION_SCHEMA = {
  type: 'OBJECT',
  properties: {
    name: { type: 'STRING', description: 'Název volby, např. "Pizza Diavola (32 cm)"' },
    description: { type: 'STRING', description: 'Krátký popis nebo proč se to hodí' },
    tag: { type: 'STRING', description: 'Krátký štítek, např. "nejvíc bílkovin" nebo "nejlevnější"' },
    recommended: { type: 'BOOLEAN', description: 'true u varianty, kterou doporučuješ nejvíc' },
    amount: { type: 'STRING', description: 'Množství, např. "400g" (volitelné)' },
    calories: { type: 'NUMBER', description: 'Vyplň, pokud jde o jídlo — pak si ho uživatel může jedním ťuknutím zapsat do deníku' },
    protein: { type: 'NUMBER' },
    carbs: { type: 'NUMBER' },
    fat: { type: 'NUMBER' }
  },
  required: ['name']
};

const BLOCK_SCHEMA = {
  type: 'OBJECT',
  properties: {
    type: { type: 'STRING', enum: MINIAPP_BLOCK_TYPES, description: 'info = text, options = výběr z možností, checklist = odškrtávací seznam, stats = pár klíčových čísel' },
    title: { type: 'STRING' },
    text: { type: 'STRING', description: 'Jen pro type "info"' },
    note: { type: 'STRING', description: 'Poznámka pod nadpisem, jen pro "options"' },
    options: { type: 'ARRAY', items: OPTION_SCHEMA, description: 'Jen pro type "options"' },
    items: {
      type: 'ARRAY',
      description: 'Pro "checklist" použij {label}, pro "stats" {label, value, sub}',
      items: {
        type: 'OBJECT',
        properties: {
          label: { type: 'STRING' },
          value: { type: 'STRING' },
          sub: { type: 'STRING' }
        },
        required: ['label']
      }
    }
  },
  required: ['type']
};

const MINIAPP_TOOLS = [
  {
    name: 'create_mini_app',
    description: `Vytvoř uživateli malou appku na míru situaci, kterou plán neřeší — večeře v konkrétní restauraci, výlet, oslava, vaření dopředu, nákup.

KDY: když uživatel popíše situaci a souhlasí, že mu na to něco uděláš. Vždy se nejdřív zeptej, jestli appku chce.

JAK: vezmi jeho denní cíle a co už dnes snědl, a naskládej bloky, které mu v té situaci fakt pomůžou. U jídel VŽDY vyplň makra — pak si je může jedním ťuknutím zapsat do deníku. Buď konkrétní: u restaurace uveď skutečná jídla z její nabídky, ne obecné kategorie.`,
    parameters: {
      type: 'OBJECT',
      properties: {
        title: { type: 'STRING', description: 'Krátký název, např. "Pizza Komín"' },
        subtitle: { type: 'STRING', description: 'Podtitulek, např. "večeře dnes · zbývá ti 900 kcal"' },
        icon: { type: 'STRING', description: 'Jedno emoji, např. 🍕' },
        context: { type: 'STRING', description: 'K čemu appka je — ať víš, o co šlo, až se k ní vrátíte' },
        blocks: { type: 'ARRAY', items: BLOCK_SCHEMA, description: 'Obsah appky, max 10 bloků' }
      },
      required: ['title', 'blocks']
    }
  },
  {
    name: 'update_mini_app',
    description: 'Přepiš už existující appku — když uživatel chce jiné možnosti, doplnit něco nebo opravit. Pošli id z kontextu a celý nový obsah.',
    parameters: {
      type: 'OBJECT',
      properties: {
        id: { type: 'STRING', description: 'ID appky z kontextu' },
        title: { type: 'STRING' },
        subtitle: { type: 'STRING' },
        icon: { type: 'STRING' },
        context: { type: 'STRING' },
        blocks: { type: 'ARRAY', items: BLOCK_SCHEMA }
      },
      required: ['id', 'blocks']
    }
  }
];

const MINIAPP_TOOL_NAMES = new Set(['create_mini_app', 'update_mini_app']);

// Apply a mini-app tool over the list the client sent. Mutates `apps`.
function applyMiniAppTool(name, args, apps) {
  const a = args || {};

  if (name === 'create_mini_app') {
    const app = buildMiniApp(a, null);
    if (!app) return { ok: false, error: 'Appka nemá žádný použitelný obsah — přidej aspoň jeden blok.' };
    apps.unshift(app);
    if (apps.length > 20) apps.length = 20;
    return {
      ok: true,
      id: app.id,
      title: app.title,
      blocks: app.blocks.map((b) => b.type),
      optionCount: app.blocks.reduce((n, b) => n + (b.type === 'options' ? b.options.length : 0), 0),
      note: 'Appka je hotová a uživateli se v chatu ukázala karta na otevření. Krátce mu řekni, co v ní najde.'
    };
  }

  if (name === 'update_mini_app') {
    const idx = apps.findIndex((x) => x.id === a.id);
    if (idx === -1) return { ok: false, error: `Appka s id ${a.id} neexistuje.` };
    const app = buildMiniApp(a, apps[idx]);
    if (!app) return { ok: false, error: 'Nový obsah je prázdný.' };
    apps[idx] = app;
    return { ok: true, id: app.id, title: app.title, blocks: app.blocks.map((b) => b.type) };
  }

  return { ok: false, error: `Neznámý nástroj: ${name}` };
}

module.exports = {
  MINIAPP_TOOLS, MINIAPP_TOOL_NAMES, applyMiniAppTool, fmtMiniApps, buildMiniApp
};
