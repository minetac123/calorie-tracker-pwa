// FitAI Cloud & Local State Client for MCP Server
const fs = require('fs');
const path = require('path');

const DEFAULT_API_URL = 'https://project-8rjn0.vercel.app';
const CACHE_FILE = process.env.FITAI_CACHE_FILE || path.join(__dirname, '..', '.fitai_cache.json');

function logDebug(...args) {
  process.stderr.write(`[FitAI-MCP] ${args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' ')}\n`);
}

class FitAIClient {
  constructor(options = {}) {
    this.apiUrl = (options.apiUrl || process.env.FITAI_API_URL || DEFAULT_API_URL).replace(/\/+$/, '');
    this.username = options.username || process.env.FITAI_USERNAME || null;
    this.password = options.password || process.env.FITAI_PASSWORD || null;
    this.token = options.token || process.env.FITAI_TOKEN || null;
    this.state = null;
    this.lastSync = null;
    this.cacheFile = options.cacheFile || CACHE_FILE;

    this._loadCache();
  }

  _loadCache() {
    try {
      if (fs.existsSync(this.cacheFile)) {
        const raw = fs.readFileSync(this.cacheFile, 'utf8');
        const data = JSON.parse(raw);
        if (data) {
          if (data.token && !this.token) this.token = data.token;
          if (data.username && !this.username) this.username = data.username;
          if (data.state) this.state = this._normalizeState(data.state);
          if (data.lastSync) this.lastSync = data.lastSync;
          logDebug(`Načtena lokální cache pro uživatele "${this.username || 'anonymní'}"`);
        }
      }
    } catch (e) {
      logDebug('Chyba při čtení lokální cache:', e.message);
    }
  }

  _saveCache() {
    try {
      const payload = {
        username: this.username,
        token: this.token,
        lastSync: this.lastSync || new Date().toISOString(),
        state: this.state
      };
      fs.writeFileSync(this.cacheFile, JSON.stringify(payload, null, 2), 'utf8');
    } catch (e) {
      logDebug('Chyba při ukládání lokální cache:', e.message);
    }
  }

  _normalizeState(raw) {
    const s = raw || {};
    return {
      profile: s.profile || {},
      targets: s.targets || { calories: 2000, protein: 140, carbs: 220, fat: 65 },
      calorieMode: s.calorieMode || null,
      workoutPlan: s.workoutPlan || {
        days: {
          mon: { name: 'Push (Hrudník, ramena, triceps)', rest: false, exercises: [] },
          tue: { name: 'Pull (Záda, zadní ramena, biceps)', rest: false, exercises: [] },
          wed: { name: 'Rest Day (Volno)', rest: true, exercises: [] },
          thu: { name: 'Legs (Nohy a lýtka)', rest: false, exercises: [] },
          fri: { name: 'Upper (Vrch těla)', rest: false, exercises: [] },
          sat: { name: 'Rest Day (Volno)', rest: true, exercises: [] },
          sun: { name: 'Rest Day (Volno)', rest: true, exercises: [] }
        }
      },
      mealPlan: s.mealPlan || null,
      exerciseLogs: (s.exerciseLogs && typeof s.exerciseLogs === 'object') ? s.exerciseLogs : {},
      sessionHistory: Array.isArray(s.sessionHistory) ? s.sessionHistory : [],
      workoutLogs: (s.workoutLogs && typeof s.workoutLogs === 'object') ? s.workoutLogs : {},
      logs: (s.logs && typeof s.logs === 'object') ? s.logs : {},
      weightLogs: Array.isArray(s.weightLogs) ? s.weightLogs : [],
      measurements: Array.isArray(s.measurements) ? s.measurements : [],
      cardioLogs: Array.isArray(s.cardioLogs) ? s.cardioLogs : [],
      sleepLogs: Array.isArray(s.sleepLogs) ? s.sleepLogs : [],
      moodLogs: Array.isArray(s.moodLogs) ? s.moodLogs : [],
      injuries: Array.isArray(s.injuries) ? s.injuries : [],
      water: (s.water && typeof s.water === 'object') ? s.water : {},
      dayNotes: (s.dayNotes && typeof s.dayNotes === 'object') ? s.dayNotes : {},
      steps: (s.steps && typeof s.steps === 'object') ? s.steps : {},
      favorites: Array.isArray(s.favorites) ? s.favorites : [],
      coachMemories: Array.isArray(s.coachMemories) ? s.coachMemories : [],
      miniApps: Array.isArray(s.miniApps) ? s.miniApps : []
    };
  }

  async login(username, password) {
    const user = username || this.username;
    const pass = password || this.password;
    if (!user || !pass) {
      throw new Error('Chybí přihlašovací jméno nebo heslo');
    }

    logDebug(`Přihlašuji uživatele "${user}" na ${this.apiUrl}/api/login...`);
    const resp = await fetch(`${this.apiUrl}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: user, password: pass })
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error || `Chyba přihlášení HTTP ${resp.status}`);
    }

    const data = await resp.json();
    this.username = data.username || user;
    this.token = data.token;
    if (data.appData) {
      this.state = this._normalizeState(data.appData);
    }
    this.lastSync = new Date().toISOString();
    this._saveCache();

    logDebug(`Uživatel "${this.username}" úspěšně přihlášen`);
    return {
      success: true,
      username: this.username,
      token: this.token
    };
  }

  async getState(forcePull = false) {
    if (this.state && !forcePull && !this.token) {
      return this.state;
    }

    // Pokud nemáme token, ale máme username + heslo v env, zkusíme login
    if (!this.token && this.username && this.password) {
      try {
        await this.login(this.username, this.password);
      } catch (e) {
        logDebug('Auto-login selhal:', e.message);
      }
    }

    if (this.token && (forcePull || !this.state)) {
      try {
        logDebug(`Stahuji data z ${this.apiUrl}/api/sync...`);
        const resp = await fetch(`${this.apiUrl}/api/sync`, {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${this.token}`,
            'Content-Type': 'application/json'
          }
        });

        if (resp.status === 401) {
          logDebug('Token vypršel');
          this.token = null;
        } else if (resp.ok) {
          const data = await resp.json();
          if (data && data.appData) {
            this.state = this._normalizeState(data.appData);
            this.lastSync = new Date().toISOString();
            this._saveCache();
            return this.state;
          }
        }
      } catch (e) {
        logDebug('Chyba při stahování ze sync API:', e.message);
      }
    }

    if (!this.state) {
      this.state = this._normalizeState({});
      this._saveCache();
    }
    return this.state;
  }

  async saveState(updatedState) {
    this.state = this._normalizeState(updatedState);
    this._saveCache();

    let cloudSynced = false;
    let cloudError = null;

    if (this.token) {
      try {
        const payload = Object.assign({}, this.state, { planSavedAt: Date.now() });
        const resp = await fetch(`${this.apiUrl}/api/sync`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${this.token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(payload)
        });

        if (resp.ok) {
          cloudSynced = true;
          this.lastSync = new Date().toISOString();
          this._saveCache();
        } else {
          const err = await resp.json().catch(() => ({}));
          cloudError = err.error || `HTTP ${resp.status}`;
        }
      } catch (e) {
        cloudError = e.message;
      }
    }

    return {
      success: true,
      cloudSynced,
      cloudError,
      lastSync: this.lastSync
    };
  }

  getStatus() {
    return {
      apiUrl: this.apiUrl,
      username: this.username || null,
      isLoggedIn: !!this.token,
      lastSync: this.lastSync || null,
      cachedExercisesCount: Object.keys(this.state?.exerciseLogs || {}).length,
      workoutPlanDays: Object.keys(this.state?.workoutPlan?.days || {}).length
    };
  }
}

module.exports = { FitAIClient, logDebug };
