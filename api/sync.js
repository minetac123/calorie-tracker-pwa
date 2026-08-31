const { kvGet, kvPut } = require('./_lib/store');
const { extractUsername } = require('./_lib/auth');

// The Telegram bot is a second writer to this same document — it adds food
// via [[ACTION]], weight via /vaha, and its own chat messages, all straight
// to the cloud copy. If a device pushes its full local snapshot as a blind
// overwrite, anything Telegram wrote after that device's last pull is gone —
// silently, because the device has no idea it was ever there. So on every
// push, every field a second writer can touch gets merged against whatever is
// already stored instead of replaced outright. The plan layer keeps the simple
// "client wins" behavior, since only the app itself writes it.
function mergeLogsByDate(existing, incoming) {
  const out = Object.assign({}, incoming || {});
  const ex = existing || {};
  Object.keys(ex).forEach((date) => {
    const exItems = Array.isArray(ex[date]) ? ex[date] : [];
    const inItems = Array.isArray(out[date]) ? out[date] : [];
    const seen = new Set(inItems.filter(Boolean).map((i) => i.id).filter(Boolean));
    out[date] = inItems.concat(exItems.filter((i) => i && i.id && !seen.has(i.id)));
  });
  return out;
}

function mergeDatedEntries(existing, incoming) {
  const byDate = new Map();
  // Incoming (this device's copy) is applied second so it wins when both
  // sides logged the same date — the more common case is the device editing
  // today's entry after having already pulled it.
  (Array.isArray(existing) ? existing : []).forEach((l) => { if (l && l.date) byDate.set(l.date, l); });
  (Array.isArray(incoming) ? incoming : []).forEach((l) => { if (l && l.date) byDate.set(l.date, l); });
  return Array.from(byDate.values()).sort((a, b) => String(b.date).localeCompare(String(a.date)));
}

function mergeCoachChats(existing, incoming) {
  const out = (Array.isArray(incoming) ? incoming : []).map((c) => Object.assign({}, c));
  const byId = new Map(out.filter((c) => c && c.id).map((c) => [c.id, c]));
  (Array.isArray(existing) ? existing : []).forEach((exChat) => {
    if (!exChat || !exChat.id) return;
    const inChat = byId.get(exChat.id);
    if (!inChat) { out.push(exChat); return; }
    const seen = new Set((inChat.messages || []).map((m) => m && `${m.ts}|${m.role}|${m.text}`));
    const newMsgs = (exChat.messages || []).filter((m) => m && !seen.has(`${m.ts}|${m.role}|${m.text}`));
    if (newMsgs.length) {
      inChat.messages = (inChat.messages || []).concat(newMsgs).sort((a, b) => (a.ts || 0) - (b.ts || 0));
      if ((exChat.updatedAt || 0) > (inChat.updatedAt || 0)) inChat.updatedAt = exChat.updatedAt;
    }
  });
  return out;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const username = await extractUsername(req.headers.authorization);
  if (!username) {
    return res.status(401).json({ error: 'Nepřihlášen' });
  }

  const blobPath = `data/${username}.json`;

  try {
    // SAVE data to cloud
    if (req.method === 'POST') {
      const appData = req.body;

      if (!appData) {
        return res.status(400).json({ error: 'Žádná data k uložení' });
      }

      const existing = await kvGet(blobPath);
      if (existing) {
        appData.logs = mergeLogsByDate(existing.logs, appData.logs);
        appData.weightLogs = mergeDatedEntries(existing.weightLogs, appData.weightLogs);
        appData.coachChats = mergeCoachChats(existing.coachChats, appData.coachChats);

        // Health logs the coach's tools write. Same reasoning as weightLogs:
        // the Telegram bot and the app are both writers, so a blind overwrite
        // would drop whatever the other one added since this device last read.
        ['measurements', 'sleepLogs', 'moodLogs'].forEach((k) => {
          appData[k] = mergeDatedEntries(existing[k], appData[k]);
        });
        ['cardioLogs', 'injuries'].forEach((k) => {
          const out = Array.isArray(appData[k]) ? appData[k].slice() : [];
          const seen = new Set(out.map((x) => x && x.id).filter(Boolean));
          (Array.isArray(existing[k]) ? existing[k] : []).forEach((x) => {
            if (x && x.id && !seen.has(x.id)) out.push(x);
          });
          appData[k] = out;
        });
        ['dayNotes', 'steps', 'water', 'workoutLogs'].forEach((k) => {
          appData[k] = Object.assign({}, existing[k] || {}, appData[k] || {});
        });
        // Keep the scalar "current weight" pointed at whichever entry ended
        // up newest after the merge, so a /vaha logged on another surface
        // isn't shadowed by this device's older value.
        if (appData.weightLogs.length) appData.weight = appData.weightLogs[0].weight;
      }

      await kvPut(blobPath, appData);

      return res.status(200).json({ success: true, message: 'Data uložena' });
    }

    // LOAD data from cloud
    if (req.method === 'GET') {
      const appData = await kvGet(blobPath);
      return res.status(200).json({ success: true, appData: appData || null });
    }

    return res.status(405).json({ error: 'Metoda není povolena' });

  } catch (error) {
    console.error('Sync error:', error);
    return res.status(500).json({ error: 'Chyba serveru: ' + error.message });
  }
};
