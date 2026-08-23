// ==========================================================================
// CONFIGURATION & GLOBAL STATE
// ==========================================================================
// The Gemini key is NOT stored client-side anymore — all AI calls go through
// the backend proxy (/api/gemini, /api/chat) which holds GEMINI_API_KEY.
const DEFAULT_API_KEY = "";

let appState = {
  apiKey: DEFAULT_API_KEY,
  goals: {
    calories: 2000,
    protein: 130,
    carbs: 220,
    fat: 65
  },
  logs: {}, // Format: { "YYYY-MM-DD": [ { id, time, name, amount, calories, protein, carbs, fat }, ... ] }
  favorites: [],
  collapsedCats: {}
};

// Temporary store for AI scanning review
let tempDetectedItems = [];

// Currently viewed day in the dashboard/calendar.
// null = today. Otherwise a "YYYY-MM-DD" string for a past day the user
// navigated to via the calendar strip.
let selectedDate = null;
let currentPhotoBase64 = null;
let currentGeminiData = null; // Store full response from Gemini
let selectedOptionIndex = 0;  // Currently selected option index

window.combineModeActive = false;
window.combineSelectedIds = new Set();
window.activeActionItem = null;
window.copyMoveActionType = 'copy';

// ==========================================================================
// STORAGE FUNCTIONS
// ==========================================================================
function saveState(skipCloudSync = false) {
  localStorage.setItem('fitai_state', JSON.stringify(appState));
  if (!skipCloudSync) {
    const session = getSession();
    if (session) {
      clearTimeout(window._syncTimeout);
      window._syncTimeout = setTimeout(syncToCloud, 500);
    }
  }
}

function loadState() {
  const saved = localStorage.getItem('fitai_state');
  if (saved) {
    try {
      appState = JSON.parse(saved);
      // The Gemini key is an app-level secret tied to the current build, NOT user
      // data. Always force the bundled key so a stale key persisted from an older
      // build (or pulled from cloud) can never break AI analysis.
      appState.apiKey = DEFAULT_API_KEY;
      // Guarantee nested properties exist
      if (!appState.goals) {
        appState.goals = { calories: 2000, protein: 130, carbs: 220, fat: 65 };
      }
      if (!appState.logs) {
        appState.logs = {};
      }
      if (!appState.water) {
        appState.water = {};
      }
      if (appState.weight === undefined) {
        appState.weight = 75.6;
      }
      if (appState.weightTarget === undefined) {
        appState.weightTarget = 70.0;
      }
      if (!appState.weightLogs) {
        appState.weightLogs = [];
      }
      if (!appState.favorites) {
        appState.favorites = [];
      }
      if (!appState.collapsedCats) {
        appState.collapsedCats = {};
      }
      if (!Array.isArray(appState.coachHistory)) {
        appState.coachHistory = [];
      }
      if (!Array.isArray(appState.coachChats)) {
        appState.coachChats = [];
      }
      if (!Array.isArray(appState.coachMemories)) {
        appState.coachMemories = [];
      }
      if (appState.coachMemoryEnabled === undefined) {
        appState.coachMemoryEnabled = true;
      }
      ensurePlanState();
      migrateCoachChats();
    } catch (e) {
      console.error("Chyba při načítání stavu z localStorage, resetuji...", e);
      resetState();
    }
  } else {
    resetState();
  }
}

function resetState() {
  appState = {
    apiKey: DEFAULT_API_KEY,
    goals: {
      calories: 2000,
      protein: 130,
      carbs: 220,
      fat: 65
    },
    logs: {},
    water: {},
    weight: 75.6,
    weightTarget: 70.0,
    weightLogs: [],
    favorites: [],
    collapsedCats: {},
    coachHistory: [],
    coachChats: [],
    coachMemories: [],
    coachMemoryEnabled: true,
    profile: {},
    workoutPlan: null,
    mealPlan: null,
    workoutLogs: {},
    mealChecks: {},
    onboardingDone: false,
    onboardingChat: [],
    mealLocks: [],
    shoppingBought: [],
    exerciseLogs: {},
    miniApps: [],
    activeSession: null,
    sessionHistory: []
  };
  saveState();
}

// Guarantee the coach-plan properties exist on a state loaded from an older
// build (or pulled from the cloud before these features shipped).
function ensurePlanState() {
  if (!appState.profile || typeof appState.profile !== 'object') appState.profile = {};
  if (appState.workoutPlan === undefined) appState.workoutPlan = null;
  if (appState.mealPlan === undefined) appState.mealPlan = null;
  if (!appState.workoutLogs || typeof appState.workoutLogs !== 'object') appState.workoutLogs = {};
  if (!appState.mealChecks || typeof appState.mealChecks !== 'object') appState.mealChecks = {};
  if (appState.onboardingDone === undefined) appState.onboardingDone = false;
  if (!Array.isArray(appState.onboardingChat)) appState.onboardingChat = [];
  if (!Array.isArray(appState.mealLocks)) appState.mealLocks = [];
  if (!appState.exerciseLogs || typeof appState.exerciseLogs !== 'object') appState.exerciseLogs = {};
  if (!Array.isArray(appState.shoppingBought)) appState.shoppingBought = [];
  if (!Array.isArray(appState.miniApps)) appState.miniApps = [];
  if (appState.activeSession === undefined) appState.activeSession = null;
  if (!Array.isArray(appState.sessionHistory)) appState.sessionHistory = [];
}

// ==========================================================================
// UTILITY FUNCTIONS
// ==========================================================================
function getTodayDateString() {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function getDateString(d) {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// The day currently being viewed/edited. Defaults to today when no past
// day has been selected from the calendar.
function getActiveDateString() {
  return selectedDate || getTodayDateString();
}

function getFoodCategory(item) {
  if (item.category) return item.category;
  
  if (item.time) {
    const [hourStr] = item.time.split(':');
    const hour = parseInt(hourStr);
    if (!isNaN(hour)) {
      if (hour >= 5 && hour < 10) return 'Breakfast';
      if (hour >= 10 && hour < 11) return 'Morning snack';
      if (hour >= 11 && hour < 15) return 'Lunch';
      if (hour >= 15 && hour < 18) return 'Afternoon snack';
      if (hour >= 18 && hour < 22) return 'Dinner';
      return 'Second dinner';
    }
  }
  return 'Breakfast';
}

// Number of past days shown in the scrollable calendar strip (~5 weeks).
const CALENDAR_DAYS_BACK = 34;

function updateCalendarRow() {
  const calendarRow = document.querySelector('.calendar-row');
  if (!calendarRow) return;

  const today = new Date();
  const todayStr = getDateString(today);
  const activeStr = getActiveDateString();

  // getDay(): 0 = Sunday ... 6 = Saturday
  const dayLabels = ['Ne', 'Po', 'Út', 'St', 'Čt', 'Pá', 'So'];

  let html = '';

  // Render from oldest -> today so today sits at the right edge of the strip.
  for (let i = CALENDAR_DAYS_BACK; i >= 0; i--) {
    const dayDate = new Date(today);
    dayDate.setDate(today.getDate() - i);

    const dateStr = getDateString(dayDate);
    const dayNum = dayDate.getDate();
    const isToday = dateStr === todayStr;
    const isSelected = dateStr === activeStr;

    // Calories eaten that day
    const dayFood = appState.logs[dateStr] || [];
    let dayCal = 0;
    dayFood.forEach(item => dayCal += Number(item.calories || 0));

    const selectedClass = isSelected ? ' selected' : '';

    if (isToday) {
      const goalCal = appState.goals.calories || 2000;
      const percent = Math.min(100, Math.round((dayCal / goalCal) * 100));
      const strokeDashoffset = 100 - percent;

      html += `
        <div class="cal-day current${selectedClass}" data-date="${dateStr}">
          <span class="cal-current-label">Dnes</span>
          <div class="cal-circle current-day">
            <svg class="cal-arc" viewBox="0 0 36 36">
              <circle class="arc-bg" cx="18" cy="18" r="16"></circle>
              <circle class="arc-fill" cx="18" cy="18" r="16" stroke-dasharray="100" stroke-dashoffset="${strokeDashoffset}"></circle>
            </svg>
            <span class="cal-date">${dayNum}</span>
          </div>
        </div>`;
    } else {
      // Green when within the daily calorie limit, red when over it.
      const goalCal = appState.goals.calories || 2000;
      let circleClass = 'future';
      if (dayCal > 0) {
        circleClass = dayCal > goalCal ? 'over-limit' : 'under-limit';
      }
      html += `
        <div class="cal-day${selectedClass}" data-date="${dateStr}">
          <span>${dayLabels[dayDate.getDay()]}</span>
          <div class="cal-circle ${circleClass}">${dayNum}</div>
        </div>`;
    }
  }

  calendarRow.innerHTML = html;

  // Bind day-tap handling once (innerHTML swaps children, not the row itself).
  if (!calendarRow.dataset.bound) {
    calendarRow.dataset.bound = '1';
    calendarRow.addEventListener('click', (e) => {
      const dayEl = e.target.closest('.cal-day');
      if (!dayEl) return;
      const date = dayEl.getAttribute('data-date');
      if (!date) return;
      selectedDate = (date === getTodayDateString()) ? null : date;
      renderDashboard();
    });
  }

  // Center the selected day (or today) in the scroll viewport.
  const selectedEl = calendarRow.querySelector('.cal-day.selected') ||
                     calendarRow.querySelector('.cal-day.current');
  if (selectedEl) {
    const rowRect = calendarRow.getBoundingClientRect();
    const selRect = selectedEl.getBoundingClientRect();
    calendarRow.scrollLeft += (selRect.left - rowRect.left) - (rowRect.width - selRect.width) / 2;
  }

  // Show the "go back to today" button only when viewing a past day.
  const backBtn = document.getElementById('btn-back-to-today');
  if (backBtn) {
    const viewingPast = activeStr !== todayStr;
    backBtn.style.display = viewingPast ? 'flex' : 'none';
    const label = document.getElementById('viewing-day-label');
    if (label) {
      label.style.display = viewingPast ? 'block' : 'none';
      if (viewingPast) label.innerText = `Prohlížíš: ${formatCzechDate(activeStr)}`;
    }
  }
}

function showWizardStep(stepNum) {
  const step1 = document.getElementById('add-wizard-step-1');
  const step2 = document.getElementById('add-wizard-step-2');
  if (step1 && step2) {
    if (stepNum === 1) {
      step1.classList.add('active');
      step2.classList.remove('active');
      resetManualFoodForm();
    } else {
      step2.classList.add('active');
      step1.classList.remove('active');
      renderFavoritesList();
    }
  }
}

// ==========================================================================
// FAVORITES (scan menu)
// ==========================================================================
function guessMealCategoryByTime() {
  const hour = new Date().getHours();
  if (hour >= 5  && hour < 10) return 'Breakfast';
  if (hour >= 10 && hour < 11) return 'Morning snack';
  if (hour >= 11 && hour < 15) return 'Lunch';
  if (hour >= 15 && hour < 18) return 'Afternoon snack';
  if (hour >= 18 && hour < 22) return 'Dinner';
  return 'Second dinner';
}

// Renders the favorites list into a given container. `opts.category` is a
// function resolving the meal category to use when quick-adding; `opts.afterAdd`
// runs after a favorite is added (e.g. close the food-log sheet).
function buildFavoritesList(container, opts) {
  if (!container) return;
  opts = opts || {};

  const favorites = appState.favorites || [];
  container.innerHTML = '';

  if (favorites.length === 0) {
    container.innerHTML = `<div class="favorites-empty">Zatím nemáš žádné oblíbené potraviny.<br>Přidej je přes „•••" u jídla na přehledu.</div>`;
    return;
  }

  favorites.forEach((fav, index) => {
    const row = document.createElement('div');
    row.className = 'favorite-row';
    row.innerHTML = `
      <div class="favorite-info">
        <span class="favorite-name">${fav.name}</span>
        <span class="favorite-details">${fav.calories} kcal • B:${fav.protein}g S:${fav.carbs}g T:${fav.fat}g (${fav.amount || '100g'})</span>
      </div>
      <div class="favorite-actions">
        <button type="button" class="favorite-add-btn" title="Přidat" data-index="${index}">+</button>
        <button type="button" class="favorite-remove-btn" title="Odebrat z oblíbených" data-remove="${index}">×</button>
      </div>`;
    container.appendChild(row);
  });

  // Bind handlers once via delegation on the persistent container.
  if (!container.dataset.bound) {
    container.dataset.bound = '1';
    container.addEventListener('click', (e) => {
      const addBtn = e.target.closest('.favorite-add-btn');
      if (addBtn) {
        const idx = parseInt(addBtn.getAttribute('data-index'), 10);
        const fav = (appState.favorites || [])[idx];
        if (fav) {
          const category = opts.category ? opts.category() : null;
          addFavoriteToActiveLog(fav, category);
          if (opts.afterAdd) opts.afterAdd();
        }
        return;
      }
      const removeBtn = e.target.closest('.favorite-remove-btn');
      if (removeBtn) {
        const idx = parseInt(removeBtn.getAttribute('data-remove'), 10);
        if (!isNaN(idx) && appState.favorites[idx]) {
          const removed = appState.favorites.splice(idx, 1)[0];
          saveState();
          refreshAllFavorites();
          showToast(`Odebráno z oblíbených: ${removed.name}`);
        }
      }
    });
  }
}

// Favorites inside the add-wizard (screen-add, step 2)
function renderFavoritesList() {
  buildFavoritesList(document.getElementById('favorites-list'), {
    category: () => {
      const sel = document.getElementById('input-food-category');
      return sel && sel.value ? sel.value : guessMealCategoryByTime();
    }
  });
}

// Favorites inside the food-log bottom sheet (the FAB "Přidat jídlo" scan menu)
function renderFlsFavorites() {
  buildFavoritesList(document.getElementById('fls-favorites-list'), {
    // Use the meal the user tapped "+" on; fall back to a time-based guess.
    category: () => window.flsSheetCategory || guessMealCategoryByTime(),
    afterAdd: () => { if (window.closeFoodLogSheet) window.closeFoodLogSheet(); }
  });
}

function refreshAllFavorites() {
  renderFavoritesList();
  renderFlsFavorites();
}

function addFavoriteToActiveLog(fav, category) {
  const categoryStr = category || guessMealCategoryByTime();

  const dateStr = getActiveDateString();
  if (!appState.logs[dateStr]) appState.logs[dateStr] = [];

  const now = new Date();
  const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

  appState.logs[dateStr].push({
    id: Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
    time: timeStr,
    name: fav.name,
    amount: fav.amount || '100g',
    calories: Math.round(Number(fav.calories || 0)),
    protein: Math.round(Number(fav.protein || 0) * 10) / 10,
    carbs: Math.round(Number(fav.carbs || 0) * 10) / 10,
    fat: Math.round(Number(fav.fat || 0) * 10) / 10,
    category: categoryStr
  });

  saveState();
  renderDashboard();
  showToast(`Přidáno: ${fav.name} ⭐`);
}

function setWizardCategory(categoryId) {
  const categorySelect = document.getElementById('input-food-category');
  if (categorySelect) {
    categorySelect.value = categoryId;
  }
  
  const titleEl = document.getElementById('wizard-category-title');
  if (titleEl) {
    const categoryNames = {
      'Breakfast': 'Snídaně',
      'Morning snack': 'Dopolední svačina',
      'Lunch': 'Oběd',
      'Afternoon snack': 'Odpolední svačina',
      'Dinner': 'Večeře',
      'Second dinner': 'Druhá večeře'
    };
    titleEl.innerText = `Přidat do: ${categoryNames[categoryId] || categoryId}`;
  }
}

window.navigateToManualAddFood = function(categoryId) {
  // Otevři starý wizard (NE scan sheet) — používá se pro ruční/čárový kód
  if (window.switchAppScreen) {
    window.switchAppScreen('screen-add');
  }
  setWizardCategory(categoryId);
  showWizardStep(2);
};


function formatCzechDate(dateStr) {
  const [year, month, day] = dateStr.split('-');
  const dateObj = new Date(year, month - 1, day);
  
  const days = ['Neděle', 'Pondělí', 'Úterý', 'Středa', 'Čtvrtek', 'Pátek', 'Sobota'];
  const months = ['ledna', 'února', 'března', 'dubna', 'května', 'června', 'července', 'srpna', 'září', 'října', 'listopadu', 'prosince'];
  
  return `${days[dateObj.getDay()]}, ${dateObj.getDate()}. ${months[dateObj.getMonth()]}`;
}

function updateDateLabels() {
  const todayLabel = formatCzechDate(getTodayDateString());
  const dateEl = document.getElementById('today-date');
  if (dateEl) dateEl.innerText = todayLabel;
}

function showToast(message) {
  const toast = document.getElementById('toast-notification');
  toast.innerText = message;
  toast.classList.add('show');
  setTimeout(() => {
    toast.classList.remove('show');
  }, 2500);
}

// ==========================================================================
// UI RENDERING - DASHBOARD
// ==========================================================================
function renderDashboard() {
  updateCalendarRow();
  // Food list/totals follow the day selected in the calendar (defaults to today).
  // Water tracking stays on the real "today".
  const todayStr = getTodayDateString();
  const activeStr = getActiveDateString();
  const todayFood = appState.logs[activeStr] || [];
  
  // Calculate Totals
  let totalCal = 0;
  let totalP = 0;
  let totalC = 0;
  let totalF = 0;
  
  todayFood.forEach(item => {
    totalCal += Number(item.calories || 0);
    totalP += Number(item.protein || 0);
    totalC += Number(item.carbs || 0);
    totalF += Number(item.fat || 0);
  });
  
  totalP = Math.round(totalP * 10) / 10;
  totalC = Math.round(totalC * 10) / 10;
  totalF = Math.round(totalF * 10) / 10;
  
  const goalCal = appState.goals.calories || 2000;
  const goalP = appState.goals.protein;
  const goalC = appState.goals.carbs;
  const goalF = appState.goals.fat;
  
  // ── Update Main Dashboard Stats ──────────────────────────────────────────
  const percent = Math.min(100, Math.round((totalCal / goalCal) * 100));

  // Center ring display
  document.getElementById('dash-current').innerText = totalCal;
  document.getElementById('dash-target').innerText  = `z ${goalCal}`;

  // Legend items
  document.getElementById('dash-eaten').innerText      = `${totalCal} kcal`;
  document.getElementById('dash-activities').innerText = `0 kcal`;
  const protLegend = document.getElementById('dash-protein-legend');
  if (protLegend) protLegend.innerText = `${totalP}g`;

  // Macros % badge
  const pctDisplay = document.getElementById('dash-pct-display');
  if (pctDisplay) pctDisplay.innerText = `${percent} %`;

  // Hidden old percent el (JS may reference it)
  const oldPercent = document.getElementById('dash-percent');
  if (oldPercent) oldPercent.innerText = `${percent} %`;

  // ── TWO ACTIVITY RINGS ─────────────────────────────────────────────────
  // Outer: Calories (circ 515, r=82)
  const ringPath = document.getElementById('dash-circle-path');
  if (ringPath) {
    const calRatio  = Math.min(1, totalCal / goalCal);
    ringPath.style.strokeDashoffset = 515 - (515 * calRatio);
    ringPath.style.stroke = totalCal > goalCal
      ? 'var(--color-danger)'
      : 'url(#grad-kcal)';
  }

  // Inner: Protein (circ 364, r=58)
  const protPath = document.getElementById('ring-protein-path');
  if (protPath) {
    const pRatio = Math.min(1, totalP / (goalP || 1));
    protPath.style.strokeDashoffset = 364 - (364 * pRatio);
  }

  // ── MACROS — hidden SVG rings (backward compat) ───────────────────────────
  const pPct = Math.round((totalP / (goalP || 1)) * 100);
  const cPct = Math.round((totalC / (goalC || 1)) * 100);
  const fPct = Math.round((totalF / (goalF || 1)) * 100);

  document.getElementById('val-p-current').innerText = `${totalP} g`;
  document.getElementById('val-p-target').innerText  = `${goalP} g`;
  document.getElementById('val-p-pct').innerText     = `${Math.min(100, pPct)} %`;
  document.getElementById('bar-p-fill').style.strokeDashoffset = 100 - Math.min(100, pPct);

  document.getElementById('val-c-current').innerText = `${totalC} g`;
  document.getElementById('val-c-target').innerText  = `${goalC} g`;
  document.getElementById('val-c-pct').innerText     = `${Math.min(100, cPct)} %`;
  document.getElementById('bar-c-fill').style.strokeDashoffset = 100 - Math.min(100, cPct);

  document.getElementById('val-f-current').innerText = `${totalF} g`;
  document.getElementById('val-f-target').innerText  = `${goalF} g`;
  document.getElementById('val-f-pct').innerText     = `${Math.min(100, fPct)} %`;
  document.getElementById('bar-f-fill').style.strokeDashoffset = 100 - Math.min(100, fPct);

  // ── NEW Apple-style horizontal macro bars ─────────────────────────────────
  const pDisplay = document.getElementById('val-p-display');
  const cDisplay = document.getElementById('val-c-display');
  const fDisplay = document.getElementById('val-f-display');
  if (pDisplay) pDisplay.innerText = `${totalP} g`;
  if (cDisplay) cDisplay.innerText = `${totalC} g`;
  if (fDisplay) fDisplay.innerText = `${totalF} g`;

  const pGoalDisp = document.getElementById('val-p-goal-display');
  const cGoalDisp = document.getElementById('val-c-goal-display');
  const fGoalDisp = document.getElementById('val-f-goal-display');
  if (pGoalDisp) pGoalDisp.innerText = goalP;
  if (cGoalDisp) cGoalDisp.innerText = goalC;
  if (fGoalDisp) fGoalDisp.innerText = goalF;

  const barP = document.getElementById('bar-p-new');
  const barC = document.getElementById('bar-c-new');
  const barF = document.getElementById('bar-f-new');
  if (barP) barP.style.width = `${Math.min(100, pPct)}%`;
  if (barC) barC.style.width = `${Math.min(100, cPct)}%`;
  if (barF) barF.style.width = `${Math.min(100, fPct)}%`;
  
  // Render Food Timeline List
  const foodListContainer = document.getElementById('meals-list-container');
  foodListContainer.innerHTML = '';
  
  const categories = [
    { id: 'Breakfast', name: 'Snídaně', icon: '🥣' },
    { id: 'Morning snack', name: 'Dopolední svačina', icon: '🥪' },
    { id: 'Lunch', name: 'Oběd', icon: '🍛' },
    { id: 'Afternoon snack', name: 'Odpolední svačina', icon: '🥪' },
    { id: 'Dinner', name: 'Večeře', icon: '🍽️' },
    { id: 'Second dinner', name: 'Druhá večeře', icon: '🍽️' }
  ];
  
  categories.forEach(cat => {
    const catItems = todayFood.filter(item => getFoodCategory(item) === cat.id);
    
    // Calculate category totals
    let catCal = 0;
    let catP = 0;
    let catC = 0;
    let catF = 0;
    
    catItems.forEach(item => {
      catCal += Number(item.calories || 0);
      catP += Number(item.protein || 0);
      catC += Number(item.carbs || 0);
      catF += Number(item.fat || 0);
    });
    
    catCal = Math.round(catCal);
    catP = Math.round(catP * 10) / 10;
    catC = Math.round(catC * 10) / 10;
    catF = Math.round(catF * 10) / 10;
    
    // Macros string
    let macroStr = '';
    if (catItems.length > 0) {
      macroStr = `${catCal} kcal (B:${catP}g S:${catC}g T:${catF}g)`;
    }
    
    const isCollapsed = appState.collapsedCats && appState.collapsedCats[cat.id];
    const chevron = isCollapsed ? '▶' : '▼';
    
    const catWrapper = document.createElement('div');
    catWrapper.className = `meal-category-wrapper ${isCollapsed ? 'collapsed' : ''}`;
    catWrapper.setAttribute('data-category-id', cat.id);
    
    const catCard = document.createElement('div');
    catCard.className = 'meal-card category-header';
    catCard.style.cursor = 'pointer';
    
    const leftoverBtnHtml = catItems.length > 0
      ? `<button class="btn-leftover-cat" data-category="${cat.id}" title="Nedojedeno – zapsat zbytek">🥡</button>`
      : '';

    catCard.innerHTML = `
      <div class="meal-left">
        <div class="meal-icon">${cat.icon}</div>
        <div class="meal-details">
          <span class="meal-name">${cat.name} <span class="collapse-chevron" style="font-size:10px; color:var(--text-3); margin-left:4px;">${chevron}</span></span>
          <span class="meal-macros">${macroStr}</span>
        </div>
      </div>
      <div class="meal-actions">
        ${leftoverBtnHtml}
        <button class="btn-add-meal" onclick="window.openFoodLogSheet('${cat.id}')">+</button>
      </div>`;

    catCard.addEventListener('click', (e) => {
      if (e.target.closest('.btn-add-meal')) return;
      if (e.target.closest('.btn-leftover-cat')) {
        e.stopPropagation();
        window.startCategoryLeftoverCapture(getActiveDateString(), cat.id);
        return;
      }
      toggleCategoryCollapse(cat.id);
    });
    
    catWrapper.appendChild(catCard);
    
    const subItemsContainer = document.createElement('div');
    subItemsContainer.className = 'meal-sub-items-container';
    if (isCollapsed) {
      subItemsContainer.style.display = 'none';
    }
    
    if (catItems.length === 0) {
      const emptyDiv = document.createElement('div');
      emptyDiv.className = 'meal-sub-item empty-category-state';
      emptyDiv.style.color = 'var(--text-3)';
      emptyDiv.style.fontSize = '13px';
      emptyDiv.style.padding = '12px 16px';
      emptyDiv.style.borderTop = '0.5px solid var(--sep)';
      emptyDiv.innerText = 'Žádné jídlo';
      subItemsContainer.appendChild(emptyDiv);
    } else {
      catItems.forEach(item => {
        const subItem = document.createElement('div');
        subItem.className = 'meal-sub-item';
        
        const amountStr = item.amount ? ` • ${item.amount}` : '';
        
        if (window.combineModeActive) {
          const isChecked = window.combineSelectedIds && window.combineSelectedIds.has(item.id);
          const checkedClass = isChecked ? 'checked' : '';
          subItem.innerHTML = `
            <div class="combine-checkbox ${checkedClass}" data-id="${item.id}"></div>
            <div class="meal-sub-details" style="cursor: pointer; flex: 1;" data-id="${item.id}">
              <span class="meal-sub-name">${item.name}</span>
              <span class="meal-sub-macros">${item.calories} kcal${amountStr} (B:${item.protein}g S:${item.carbs}g T:${item.fat}g)</span>
            </div>`;
            
          subItem.addEventListener('click', () => {
            const checkbox = subItem.querySelector('.combine-checkbox');
            if (checkbox) {
              const isSel = checkbox.classList.toggle('checked');
              if (isSel) {
                window.combineSelectedIds.add(item.id);
              } else {
                window.combineSelectedIds.delete(item.id);
              }
              updateCombineFloatingBar();
            }
          });
        } else {
          const hasLeftovers = item.leftovers && item.leftovers.length > 0;
          let macrosHtml;
          if (hasLeftovers) {
            const orig = item.original || item;
            const left = sumLeftovers(item);
            macrosHtml = `
              <span class="meal-sub-macros"><span class="leftover-net-val">${item.calories} kcal</span>${amountStr} (B:${item.protein}g S:${item.carbs}g T:${item.fat}g)</span>
              <span class="meal-sub-leftover">Původně ${Math.round(orig.calories)} kcal · zbytek −${Math.round(left.calories)} kcal</span>`;
          } else {
            macrosHtml = `<span class="meal-sub-macros">${item.calories} kcal${amountStr} (B:${item.protein}g S:${item.carbs}g T:${item.fat}g)</span>`;
          }
          subItem.innerHTML = `
            <div class="meal-sub-details" style="cursor: pointer; flex: 1;" data-id="${item.id}" title="Klikni pro úpravu množství">
              <span class="meal-sub-name">${item.name}</span>
              ${macrosHtml}
            </div>
            <button class="btn-item-actions" data-id="${item.id}">›</button>`;
        }
        
        subItemsContainer.appendChild(subItem);
      });
    }
    
    catWrapper.appendChild(subItemsContainer);
    foodListContainer.appendChild(catWrapper);
  });
  
  // Clicks are handled via event delegation in initItemActionsHandlers()

  // Render Water Intake
  const todayWater = appState.water[todayStr] || 0;
  const targetWater = 3; // default target 3 liters
  const waterPct = Math.min(100, Math.round((todayWater / targetWater) * 100));
  
  const waterCurrentEl = document.querySelector('.water-current');
  const waterBarFillEl = document.querySelector('.water-bar-fill');
  if (waterCurrentEl) waterCurrentEl.innerText = `${todayWater.toFixed(2).replace('.', ',')} l`;
  if (waterBarFillEl) waterBarFillEl.style.width = `${waterPct}%`;

  // Render Weight
  const weightCurrentEl = document.querySelector('.weight-card .weight-current');
  const weightTargetEl = document.querySelector('.weight-card .weight-target');
  if (weightCurrentEl) weightCurrentEl.innerText = `${appState.weight.toString().replace('.', ',')} kg`;
  if (weightTargetEl) weightTargetEl.innerText = `cíl ${appState.weightTarget.toString().replace('.', ',')} kg`;

  // Today's workout + meal plan cards
  renderDashboardPlanCards();
  renderMiniAppCards();
}

// Fire/burn animace — spálí DOM element a po dokončení zavolá callback
function burnAndRemove(el, done) {
  if (!el || el.classList.contains('burning')) { if (done) done(); return; }
  el.classList.add('burning');

  const overlay = document.createElement('div');
  overlay.className = 'burn-overlay';

  // jazyky plamenů rovnoměrně po šířce
  const flameCount = 5;
  for (let i = 0; i < flameCount; i++) {
    const f = document.createElement('span');
    f.className = 'burn-flame';
    f.style.left = (10 + i * (80 / (flameCount - 1))) + '%';
    f.style.animationDelay = (i * 55) + 'ms';
    overlay.appendChild(f);
  }
  // odlétající jiskry
  for (let i = 0; i < 11; i++) {
    const e = document.createElement('span');
    e.className = 'burn-ember';
    e.style.left = (Math.random() * 100) + '%';
    e.style.animationDelay = (Math.random() * 380) + 'ms';
    e.style.setProperty('--dx', (Math.random() * 44 - 22).toFixed(0) + 'px');
    overlay.appendChild(e);
  }
  el.appendChild(overlay);

  setTimeout(() => { if (done) done(); }, 840);
}

function deleteFoodItem(id) {
  const todayStr = getActiveDateString();
  if (appState.logs[todayStr]) {
    const itemIndex = appState.logs[todayStr].findIndex(item => item.id === id);
    if (itemIndex !== -1) {
      const deletedName = appState.logs[todayStr][itemIndex].name;

      const finish = () => {
        appState.logs[todayStr].splice(itemIndex, 1);
        // Clean up empty day lists
        if (appState.logs[todayStr].length === 0) {
          delete appState.logs[todayStr];
        }
        saveState();
        renderDashboard();
        showToast(`🔥 Spáleno: ${deletedName}`);
      };

      // Najdi řádek jídla v DOMu a spal ho, pak teprve smaž data
      const ref = document.querySelector(`.meal-sub-item [data-id="${CSS.escape(String(id))}"]`);
      const row = ref ? ref.closest('.meal-sub-item') : null;
      if (row) {
        burnAndRemove(row, finish);
      } else {
        finish();
      }
    }
  }
}

// ==========================================================================
// LEFTOVERS ("Nedojedeno") — subtract the uneaten portion from a meal entry
// ==========================================================================
let pendingLeftoverMacros = null;
window.activeLeftover = null; // { date, categoryId }

function getCategoryName(catId) {
  const names = {
    'Breakfast': 'Snídaně',
    'Morning snack': 'Dopolední svačina',
    'Lunch': 'Oběd',
    'Afternoon snack': 'Odpolední svačina',
    'Dinner': 'Večeře',
    'Second dinner': 'Druhá večeře'
  };
  return names[catId] || catId;
}

function sumLeftovers(item) {
  const acc = { calories: 0, protein: 0, carbs: 0, fat: 0 };
  (item.leftovers || []).forEach(l => {
    acc.calories += Number(l.calories || 0);
    acc.protein  += Number(l.protein  || 0);
    acc.carbs    += Number(l.carbs    || 0);
    acc.fat      += Number(l.fat      || 0);
  });
  acc.calories = Math.round(acc.calories);
  acc.protein  = Math.round(acc.protein * 10) / 10;
  acc.carbs    = Math.round(acc.carbs   * 10) / 10;
  acc.fat      = Math.round(acc.fat     * 10) / 10;
  return acc;
}

// Recompute the live (net) macros = original − all leftovers, clamped at 0.
// Returns true if leftovers exceed the original (net was clamped).
function recomputeItemNet(item) {
  if (!item.original) return false;
  const left = sumLeftovers(item);
  const exceeded =
    (item.original.calories - left.calories) < 0 ||
    (item.original.protein  - left.protein)  < 0 ||
    (item.original.carbs    - left.carbs)    < 0 ||
    (item.original.fat      - left.fat)      < 0;
  item.calories = Math.max(0, Math.round(item.original.calories - left.calories));
  item.protein  = Math.max(0, Math.round((item.original.protein - left.protein) * 10) / 10);
  item.carbs    = Math.max(0, Math.round((item.original.carbs   - left.carbs)   * 10) / 10);
  item.fat      = Math.max(0, Math.round((item.original.fat     - left.fat)     * 10) / 10);
  return exceeded;
}

// Pull a single {calories,protein,carbs,fat} total out of a Gemini response.
function parseLeftoverMacros(geminiData) {
  let t = null;
  if (geminiData) {
    if (geminiData.total) {
      t = geminiData.total;
    } else if (Array.isArray(geminiData.items) && geminiData.items.length) {
      t = geminiData.items.reduce((s, x) => ({
        calories: s.calories + Number(x.calories || 0),
        protein:  s.protein  + Number(x.protein  || 0),
        carbs:    s.carbs    + Number(x.carbs    || 0),
        fat:      s.fat      + Number(x.fat      || 0)
      }), { calories: 0, protein: 0, carbs: 0, fat: 0 });
    } else if (Array.isArray(geminiData.choices) && geminiData.choices[0]) {
      t = geminiData.choices[0].total || null;
    }
  }
  if (!t) return null;
  return {
    calories: Math.round(Number(t.calories || 0)),
    protein:  Math.round(Number(t.protein  || 0) * 10) / 10,
    carbs:    Math.round(Number(t.carbs    || 0) * 10) / 10,
    fat:      Math.round(Number(t.fat      || 0) * 10) / 10
  };
}

function getCategoryItems(date, categoryId) {
  return (appState.logs[date] || []).filter(i => getFoodCategory(i) === categoryId);
}

// "Original" calories the category was logged with (pre-leftovers).
function categoryOriginalCalories(items) {
  return items.reduce((s, i) => s + (i.original ? Number(i.original.calories || 0) : Number(i.calories || 0)), 0);
}

// Current net calories of the category.
function categoryNetCalories(items) {
  return items.reduce((s, i) => s + Number(i.calories || 0), 0);
}

// Entry point from the category header "leftover" button.
window.startCategoryLeftoverCapture = function(date, categoryId) {
  const items = getCategoryItems(date, categoryId);
  if (items.length === 0) { showToast('V této kategorii není žádné jídlo.'); return; }
  window.activeLeftover = { date, categoryId };
  openLeftoverSourceSheet();
};

function openLeftoverSourceSheet() {
  const sheet = document.getElementById('leftover-source-sheet');
  if (sheet) sheet.classList.add('active');
}

function closeLeftoverSourceSheet() {
  const sheet = document.getElementById('leftover-source-sheet');
  if (sheet) sheet.classList.remove('active');
}

function showLeftoverStage(name) {
  const analyzing = document.getElementById('leftover-analyzing');
  const result = document.getElementById('leftover-result');
  if (analyzing) analyzing.style.display = name === 'analyzing' ? 'flex' : 'none';
  if (result) result.style.display = name === 'result' ? 'block' : 'none';
}

function openLeftoverModal() {
  const modal = document.getElementById('leftover-modal');
  if (modal) modal.classList.add('active');
}

function closeLeftoverModal() {
  const modal = document.getElementById('leftover-modal');
  if (modal) modal.classList.remove('active');
  pendingLeftoverMacros = null;
}

async function analyzeLeftover(base64) {
  if (!window.activeLeftover) return;
  const { date, categoryId } = window.activeLeftover;
  const items = getCategoryItems(date, categoryId);
  if (items.length === 0) return;

  openLeftoverModal();
  showLeftoverStage('analyzing');
  const nameEl = document.getElementById('leftover-meal-name');
  if (nameEl) nameEl.innerText = getCategoryName(categoryId);

  try {
    const data = await callGeminiAPI(null, base64, { leftover: true });
    const macros = parseLeftoverMacros(data);
    if (!macros || macros.calories <= 0) {
      throw new Error('Na fotce se nepodařilo rozpoznat žádný zbytek jídla.');
    }
    pendingLeftoverMacros = macros;
    renderLeftoverResult(items, macros);
    showLeftoverStage('result');
  } catch (err) {
    closeLeftoverModal();
    showToast('Analýza zbytku selhala: ' + err.message);
  }
}

function renderLeftoverResult(items, macros) {
  const valuesEl = document.getElementById('leftover-values');
  if (valuesEl) {
    valuesEl.innerHTML =
      `<div class="leftover-big">−${macros.calories} kcal</div>
       <div class="leftover-macros-line">B: ${macros.protein} g · S: ${macros.carbs} g · T: ${macros.fat} g</div>`;
  }
  // Warn if the leftover exceeds what's currently left in the category.
  const wouldExceed = macros.calories > categoryNetCalories(items);
  const warn = document.getElementById('leftover-warning');
  if (warn) warn.style.display = wouldExceed ? 'block' : 'none';
}

function confirmLeftover() {
  if (!window.activeLeftover || !pendingLeftoverMacros) { closeLeftoverModal(); return; }
  const { date, categoryId } = window.activeLeftover;
  const items = getCategoryItems(date, categoryId);
  if (items.length === 0) { closeLeftoverModal(); return; }

  const catOrigCal = categoryOriginalCalories(items);
  if (catOrigCal <= 0) { closeLeftoverModal(); return; }

  const now = new Date();
  const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  let exceeded = false;

  // Distribute the leftover across the category's items, proportional to each
  // item's original share of the meal.
  items.forEach(item => {
    const itemOrigCal = item.original ? Number(item.original.calories || 0) : Number(item.calories || 0);
    const frac = itemOrigCal / catOrigCal;
    if (frac <= 0) return;

    if (!item.original) {
      item.original = {
        calories: Math.round(Number(item.calories || 0)),
        protein:  Math.round(Number(item.protein  || 0) * 10) / 10,
        carbs:    Math.round(Number(item.carbs    || 0) * 10) / 10,
        fat:      Math.round(Number(item.fat      || 0) * 10) / 10
      };
    }
    if (!Array.isArray(item.leftovers)) item.leftovers = [];
    item.leftovers.push({
      calories: Math.round(pendingLeftoverMacros.calories * frac),
      protein:  Math.round(pendingLeftoverMacros.protein * frac * 10) / 10,
      carbs:    Math.round(pendingLeftoverMacros.carbs   * frac * 10) / 10,
      fat:      Math.round(pendingLeftoverMacros.fat     * frac * 10) / 10,
      time: timeStr
    });
    if (recomputeItemNet(item)) exceeded = true;
  });

  saveState();
  renderDashboard();
  closeLeftoverModal();

  const newCatCal = Math.round(categoryNetCalories(getCategoryItems(date, categoryId)));
  window.activeLeftover = null;

  if (exceeded) {
    showToast(`⚠️ Zbytek překročil porci — čistý příjem omezen`);
  } else {
    showToast(`Čistý příjem upraven: ${newCatCal} kcal`);
  }
}

function initLeftoverHandlers() {
  const inputCamera = document.getElementById('leftover-input-camera');
  const inputPhoto  = document.getElementById('leftover-input-photo');
  const inputFile   = document.getElementById('leftover-input-file');

  [inputCamera, inputPhoto, inputFile].forEach(input => {
    if (!input) return;
    input.addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file || !file.type.startsWith('image/')) return;
      const reader = new FileReader();
      reader.onload = ev => analyzeLeftover(ev.target.result);
      reader.readAsDataURL(file);
    });
  });

  // Source chooser (must click() the input within the same user gesture).
  const triggerInput = (input) => {
    closeLeftoverSourceSheet();
    if (input) { input.value = ''; input.click(); }
  };
  const btnCam = document.getElementById('btn-leftover-camera');
  const btnPhoto = document.getElementById('btn-leftover-photo');
  const btnFile = document.getElementById('btn-leftover-file');
  const btnSrcCancel = document.getElementById('btn-leftover-source-cancel');
  if (btnCam) btnCam.addEventListener('click', () => triggerInput(inputCamera));
  if (btnPhoto) btnPhoto.addEventListener('click', () => triggerInput(inputPhoto));
  if (btnFile) btnFile.addEventListener('click', () => triggerInput(inputFile));
  if (btnSrcCancel) btnSrcCancel.addEventListener('click', closeLeftoverSourceSheet);
  const srcSheet = document.getElementById('leftover-source-sheet');
  if (srcSheet) srcSheet.addEventListener('click', (e) => { if (e.target === srcSheet) closeLeftoverSourceSheet(); });

  const modal = document.getElementById('leftover-modal');
  const btnCancel = document.getElementById('leftover-cancel');
  const btnConfirm = document.getElementById('leftover-confirm');
  const btnClose = document.getElementById('leftover-close');
  if (btnCancel) btnCancel.addEventListener('click', closeLeftoverModal);
  if (btnClose) btnClose.addEventListener('click', closeLeftoverModal);
  if (btnConfirm) btnConfirm.addEventListener('click', confirmLeftover);
  if (modal) modal.addEventListener('click', (e) => { if (e.target === modal) closeLeftoverModal(); });
}

// ==========================================================================
// UI RENDERING - HISTORY
// ==========================================================================
function renderHistory() {
  const historyContainer = document.getElementById('history-container');
  if (historyContainer) {
    historyContainer.innerHTML = '';
    
    // Sort log dates descending
    const dates = Object.keys(appState.logs).sort().reverse();
    
    if (dates.length === 0) {
      historyContainer.innerHTML = `
        <div class="empty-state" style="padding: 20px 0;">
          <div class="empty-icon">📅</div>
          <p>Žádná historie. Zapiš si první jídlo dnes!</p>
        </div>`;
    } else {
      dates.forEach(dateStr => {
        const dailyItems = appState.logs[dateStr] || [];
        
        let totalCal = 0;
        let totalP = 0;
        let totalC = 0;
        let totalF = 0;
        
        dailyItems.forEach(item => {
          totalCal += Number(item.calories || 0);
          totalP += Number(item.protein || 0);
          totalC += Number(item.carbs || 0);
          totalF += Number(item.fat || 0);
        });
        
        totalP = Math.round(totalP * 10) / 10;
        totalC = Math.round(totalC * 10) / 10;
        totalF = Math.round(totalF * 10) / 10;
        
        const card = document.createElement('div');
        card.className = 'dark-card history-day-card';
        
        // Check if it is today
        const displayName = dateStr === getTodayDateString() ? 'Dnes' : formatCzechDate(dateStr);
        
        let foodListHtml = '';
        dailyItems.forEach(item => {
          const amountStr = item.amount ? ` (${item.amount})` : '';
          foodListHtml += `
            <div class="history-food-item">
              <span class="history-food-name">${item.name}${amountStr}</span>
              <span class="history-food-cal">${item.calories} kcal</span>
            </div>`;
        });
        
        card.innerHTML = `
          <div class="history-day-header">
            <div class="history-day-info">
              <div class="history-day-title">${displayName}</div>
              <div class="history-day-summary-row">
                <div class="history-day-macros">
                  <span>B: ${totalP}g</span>
                  <span>S: ${totalC}g</span>
                  <span>T: ${totalF}g</span>
                </div>
              </div>
            </div>
            <div style="display: flex; align-items: center; gap: 12px;">
              <span class="history-day-cal">${totalCal} kcal</span>
              <span class="history-day-arrow">▶</span>
            </div>
          </div>
          <div class="history-day-details">
            ${foodListHtml}
          </div>`;
        
        // Click toggle expand
        card.querySelector('.history-day-header').addEventListener('click', () => {
          card.classList.toggle('expanded');
        });
        
        historyContainer.appendChild(card);
      });
    }
  }

  // Render weight logs
  const weightContainer = document.getElementById('weight-history-list');
  if (weightContainer) {
    weightContainer.innerHTML = '';
    const weightLogs = appState.weightLogs || [];
    
    if (weightLogs.length === 0) {
      weightContainer.innerHTML = `
        <div class="empty-state" style="padding: 20px 0; text-align: center;">
          <div class="empty-icon">⚖️</div>
          <p style="color: var(--text-secondary); font-size: 14px; margin-top: 8px;">Zatím žádné záznamy o váze.</p>
        </div>`;
    } else {
      weightLogs.forEach((log, index) => {
        const item = document.createElement('div');
        item.className = 'weight-history-item';
        item.innerHTML = `
          <span class="weight-history-date">${formatCzechDate(log.date)}</span>
          <div style="display: flex; align-items: center; gap: 12px;">
            <span class="weight-history-val">${log.weight.toString().replace('.', ',')} kg</span>
            <button class="btn-delete-weight" data-index="${index}" style="background:none; border:none; color:var(--color-danger); cursor:pointer; font-size: 16px;">×</button>
          </div>
        `;
        
        item.querySelector('.btn-delete-weight').addEventListener('click', () => {
          if (confirm("Opravdu chceš smazat tento záznam o váze?")) {
            appState.weightLogs.splice(index, 1);
            if (index === 0) {
              appState.weight = appState.weightLogs.length > 0 ? appState.weightLogs[0].weight : 75.6;
            }
            saveState();
            renderDashboard();
            renderHistory();
            showToast("Záznam o váze smazán.");
          }
        });
        
        weightContainer.appendChild(item);
      });
    }
  }
}

// ==========================================================================
// UI RENDERING - SETTINGS
// ==========================================================================
function renderSettings() {
  const keyInput = document.getElementById('input-gemini-key');
  if (keyInput) {
    keyInput.value = appState.apiKey || '';
  }
  document.getElementById('input-goal-cal').value = appState.goals.calories || 2000;
  document.getElementById('input-goal-p').value = appState.goals.protein || 130;
  document.getElementById('input-goal-c').value = appState.goals.carbs || 220;
  document.getElementById('input-goal-f').value = appState.goals.fat || 65;
  if (typeof renderCoachMemorySettings === 'function') renderCoachMemorySettings();
  renderTelegramStatus();
}

// ==========================================================================
// TELEGRAM CONNECT
// ==========================================================================
function renderTelegramStatus(connected) {
  const connStatus = document.getElementById('tg-connected-status');
  const connectWrap = document.getElementById('tg-connect-wrap');
  const disconnectWrap = document.getElementById('tg-disconnect-wrap');
  const codeBox = document.getElementById('tg-code-box');
  if (!connStatus) return;
  if (connected === true) {
    connStatus.style.display = '';
    connectWrap.style.display = 'none';
    disconnectWrap.style.display = '';
    if (codeBox) codeBox.style.display = 'none';
  } else if (connected === false) {
    connStatus.style.display = 'none';
    connectWrap.style.display = '';
    disconnectWrap.style.display = 'none';
  }
  // If connected === undefined, leave as-is (initial state, check in progress)
}

async function checkTelegramStatus() {
  const session = getSession();
  if (!session) return;
  try {
    const resp = await fetch('/api/telegram-connect', {
      headers: { 'Authorization': `Bearer ${session.token}` }
    });
    const data = await resp.json();
    renderTelegramStatus(!!data.connected);
  } catch (e) { /* ignore */ }
}

async function connectTelegram() {
  const session = getSession();
  if (!session) return;
  const btn = document.getElementById('btn-tg-connect');
  if (btn) { btn.disabled = true; btn.textContent = 'Načítám...'; }
  try {
    const resp = await fetch('/api/telegram-connect', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${session.token}` }
    });
    const data = await resp.json();
    if (!resp.ok || !data.code) throw new Error(data.error || 'Chyba');

    const codeBox = document.getElementById('tg-code-box');
    const codeDisplay = document.getElementById('tg-code-display');
    const botLink = document.getElementById('tg-bot-link');
    if (codeBox) codeBox.style.display = '';
    if (codeDisplay) codeDisplay.textContent = data.code;
    if (botLink && data.botUsername) {
      botLink.href = `https://t.me/${data.botUsername}?start=${data.code}`;
    }
    const connectWrap = document.getElementById('tg-connect-wrap');
    if (connectWrap) connectWrap.style.display = 'none';
  } catch (e) {
    showToast('Chyba: ' + e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Pripojit Telegram'; }
  }
}

async function verifyTelegram() {
  const session = getSession();
  if (!session) return;
  const btn = document.getElementById('btn-tg-verify');
  if (btn) { btn.disabled = true; btn.textContent = 'Ověřuji...'; }
  try {
    const resp = await fetch('/api/telegram-connect', {
      headers: { 'Authorization': `Bearer ${session.token}` }
    });
    const data = await resp.json();
    if (data.connected) {
      renderTelegramStatus(true);
      showToast('Telegram propojen!');
    } else {
      showToast('Ještě nepropojeno — otevři bota a tap Start');
    }
  } catch (e) {
    showToast('Chyba při ověřování');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Overit spojeni'; }
  }
}

async function disconnectTelegram() {
  const session = getSession();
  if (!session) return;
  try {
    await fetch('/api/telegram-connect', {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${session.token}` }
    });
    renderTelegramStatus(false);
    showToast('Telegram odpojen');
  } catch (e) {
    showToast('Chyba při odpojování');
  }
}

function saveSettingsFromUI() {
  const keyInput = document.getElementById('input-gemini-key');
  const apiKey = keyInput ? keyInput.value.trim() : (appState.apiKey || DEFAULT_API_KEY);
  const cTarget = parseInt(document.getElementById('input-goal-cal').value) || 2000;
  const pTarget = parseInt(document.getElementById('input-goal-p').value) || 130;
  const cTargetMac = parseInt(document.getElementById('input-goal-c').value) || 220;
  const fTarget = parseInt(document.getElementById('input-goal-f').value) || 65;
  
  appState.apiKey = apiKey;
  appState.goals = {
    calories: cTarget,
    protein: pTarget,
    carbs: cTargetMac,
    fat: fTarget
  };
  
  saveState();
  renderDashboard();
  showToast("Nastavení uloženo!");
}

// ==========================================================================
// FOOD LOG BOTTOM SHEET
// ==========================================================================
function initFoodLogSheet() {
  const scrim   = document.getElementById('fls-scrim');
  const sheet   = document.getElementById('fls-sheet');
  const btnClose = document.getElementById('fls-close');

  const stageCapture   = document.getElementById('fls-stage-capture');
  const stageAnalyzing = document.getElementById('fls-stage-analyzing');
  const stageChoices   = document.getElementById('fls-stage-choices');
  const stageDetected  = document.getElementById('fls-stage-detected');

  const shutter     = document.getElementById('fls-shutter');
  const btnGallery  = document.getElementById('fls-btn-gallery');
  const btnBarcode  = document.getElementById('fls-btn-barcode');
  const camInput    = document.getElementById('fls-camera-input');
  const galInput    = document.getElementById('fls-gallery-input');

  const capturePreview = document.getElementById('fls-capture-preview');
  const vfPlaceholder  = document.getElementById('fls-vf-placeholder');
  const analyzeImg     = document.getElementById('fls-analyze-img');

  const choicesList    = document.getElementById('fls-choices-list');
  const choicesThumb   = document.getElementById('fls-choices-thumb');
  const choicesRetake  = document.getElementById('fls-choices-retake');
  const refineInput  = document.getElementById('fls-refine-input');
  const refineBtn    = document.getElementById('fls-refine-btn');
  const mealPicker     = document.getElementById('fls-meal-picker');
  const mealPickerWrap = document.getElementById('fls-meal-picker-wrap');

  const MEALS = [
    { id: 'Breakfast',       name: 'Snídaně',     icon: '🥣' },
    { id: 'Morning snack',   name: 'Dop. svačina', icon: '🥪' },
    { id: 'Lunch',           name: 'Oběd',        icon: '🍛' },
    { id: 'Afternoon snack', name: 'Odp. svačina', icon: '🍎' },
    { id: 'Dinner',          name: 'Večeře',      icon: '🍽️' },
    { id: 'Second dinner',   name: 'Druhá večeře', icon: '🌙' }
  ];

  function guessCategoryByTime() {
    const hour = new Date().getHours();
    if (hour >= 5  && hour < 10) return 'Breakfast';
    if (hour >= 10 && hour < 11) return 'Morning snack';
    if (hour >= 11 && hour < 15) return 'Lunch';
    if (hour >= 15 && hour < 18) return 'Afternoon snack';
    if (hour >= 18 && hour < 22) return 'Dinner';
    return 'Second dinner';
  }

  let flsPhotoBase64 = null;
  let flsItems = [];
  let flsChoices = [];
  let flsPresetCategory = null;  // přednastavená kategorie (z tlačítka u konkrétního jídla)
  let flsPickedCategory = null;  // kategorie vybraná uživatelem po skenu
  let flsPhotoTimer = null;      // timer pro časný analyzing stav (iOS photo delay)

  function openSheet(presetCategory) {
    flsPresetCategory = (typeof presetCategory === 'string' && MEALS.some(m => m.id === presetCategory))
      ? presetCategory : null;
    // Expose for the favorites quick-add so it logs to the tapped meal.
    window.flsSheetCategory = flsPresetCategory;
    scrim.classList.add('open');
    sheet.classList.add('open');
    showStage('capture');
    flsPhotoBase64 = null;
    flsItems = [];
    flsChoices = [];
    flsPickedCategory = null;
    capturePreview.style.display = 'none';
    vfPlaceholder.style.display = '';
    renderFlsFavorites();
  }

  function renderMealPicker() {
    // Když je kategorie přednastavená (sken z konkrétního jídla), výběr neukazuj
    if (flsPresetCategory) {
      mealPickerWrap.style.display = 'none';
      return;
    }
    mealPickerWrap.style.display = 'block';
    if (!flsPickedCategory) flsPickedCategory = guessCategoryByTime();
    mealPicker.innerHTML = '';
    MEALS.forEach(m => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'fls-meal-chip' + (m.id === flsPickedCategory ? ' active' : '');
      chip.innerHTML = `<span>${m.icon}</span> ${m.name}`;
      chip.addEventListener('click', () => {
        flsPickedCategory = m.id;
        mealPicker.querySelectorAll('.fls-meal-chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
      });
      mealPicker.appendChild(chip);
    });
  }

  function closeSheet() {
    clearTimeout(flsPhotoTimer);
    scrim.classList.remove('open');
    sheet.classList.remove('open');
    camInput.value = '';
    galInput.value = '';
    if (refineInput) refineInput.value = '';
  }

  function showStage(name) {
    stageCapture.style.display   = name === 'capture'   ? 'flex' : 'none';
    stageAnalyzing.style.display = name === 'analyzing' ? 'flex' : 'none';
    stageChoices.style.display   = name === 'choices'   ? 'flex' : 'none';
    stageDetected.style.display  = name === 'detected'  ? 'flex' : 'none';
  }

  function handlePhoto(dataUrl) {
    flsPhotoBase64 = dataUrl;
    capturePreview.src = dataUrl;
    capturePreview.style.display = 'block';
    vfPlaceholder.style.display = 'none';
    analyzeImg.src = dataUrl;
    showStage('analyzing');
    runAI();
  }

  async function runAI() {
    try {
      const geminiData = await callGeminiAPI(null, flsPhotoBase64);
      if (geminiData.type === 'image_choices' && geminiData.choices && geminiData.choices.length > 0) {
        // Vždy ukázat 3 možnosti, ze kterých si uživatel vybere tu správnou
        flsChoices = geminiData.choices;
        renderChoices();
        showStage('choices');
      } else {
        // Textový výsledek nebo fallback — rovnou na detail
        const items = geminiData.items || [];
        flsItems = attachBaseValues(JSON.parse(JSON.stringify(items)));
        renderDetectedStage();
        showStage('detected');
      }
    } catch (err) {
      closeSheet();
      showToast('AI analýza selhala: ' + err.message);
    }
  }

  function renderChoices() {
    if (flsPhotoBase64) {
      choicesThumb.style.backgroundImage = `url(${flsPhotoBase64})`;
      choicesThumb.style.backgroundSize = 'cover';
      choicesThumb.style.backgroundPosition = 'center';
    }
    choicesList.innerHTML = '';
    flsChoices.forEach((choice, i) => {
      const count = (choice.items || []).length;
      const word = count === 1 ? 'položka' : (count < 5 ? 'položky' : 'položek');
      const kcal = choice.total && choice.total.calories != null
        ? choice.total.calories
        : (choice.items || []).reduce((s, x) => s + Number(x.calories || 0), 0);
      const card = document.createElement('div');
      card.className = 'fls-choice-card';
      card.style.animationDelay = `${i * 80}ms`;
      card.innerHTML = `
        <div class="fls-choice-info">
          <span class="fls-choice-name">${choice.option_name || 'Varianta ' + (i + 1)}</span>
          <span class="fls-choice-sub">${count} ${word}</span>
        </div>
        <div class="fls-choice-right">
          <span class="fls-choice-kcal">${Math.round(kcal)} <span>kcal</span></span>
          <svg class="fls-choice-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
        </div>`;
      card.addEventListener('click', () => selectChoice(i));
      choicesList.appendChild(card);
    });
  }

  function selectChoice(index) {
    const choice = flsChoices[index];
    flsItems = attachBaseValues(JSON.parse(JSON.stringify(choice.items || [])));
    if (refineInput) refineInput.value = '';
    renderDetectedStage();
    showStage('detected');
  }

  async function refineWithAI() {
    const request = refineInput.value.trim();
    if (!request) { refineInput.focus(); return; }
    if (flsItems.length === 0) { showToast('Není co upravovat.'); return; }

    setRefineLoading(true);
    try {
      const cleanItems = flsItems.map(it => ({
        name: it.name, amount: it.amount,
        calories: it.calories, protein: it.protein, carbs: it.carbs, fat: it.fat
      }));
      const prompt = `Aktuální rozpoznané položky jídla (JSON): ${JSON.stringify(cleanItems)}. `
        + `Uživatel požaduje tuto úpravu: "${request}". `
        + `Aplikuj změnu, přepočítej hmotnosti i nutriční hodnoty a vrať CELÝ aktualizovaný seznam jako type "text_result".`;
      const data = await callGeminiAPI(prompt, null);
      const newItems = data.items || [];
      if (newItems.length === 0) {
        showToast('AI nevrátila žádné položky.');
      } else {
        flsItems = attachBaseValues(JSON.parse(JSON.stringify(newItems)));
        refineInput.value = '';
        renderDetectedStage();
      }
    } catch (err) {
      showToast('Úprava selhala: ' + err.message);
    } finally {
      setRefineLoading(false);
    }
  }

  function setRefineLoading(on) {
    refineBtn.disabled = on;
    refineInput.disabled = on;
    refineBtn.innerHTML = on
      ? '<span class="fls-refine-spin"></span>'
      : '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>';
  }

  function renderDetectedStage() {
    const header = document.getElementById('fls-detected-header');
    const list   = document.getElementById('fls-detected-list');
    const total  = document.getElementById('fls-total-card');

    const count = flsItems.length;
    const wordMap = [,'položka','položky','položky','položky'];
    const word = wordMap[count] || 'položek';

    const presetMeal = flsPresetCategory ? MEALS.find(m => m.id === flsPresetCategory) : null;
    const headerSub = presetMeal
      ? `${presetMeal.icon} ${presetMeal.name} · uprav porce dole ↓`
      : 'Uprav porce textem dole ↓';
    header.innerHTML = `
      <div class="fls-detected-header-thumb" id="fls-detected-thumb"></div>
      <div style="flex:1;">
        <div style="font-size:13px; font-weight:700; color:#34D399; display:flex; align-items:center; gap:5px;">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#34D399" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
          Rozpoznáno ${count} ${word}
        </div>
        <div style="font-size:13px; font-weight:500; color:rgba(255,255,255,0.5); margin-top:2px;">${headerSub}</div>
      </div>`;
    if (flsPhotoBase64) {
      const thumb = document.getElementById('fls-detected-thumb');
      if (thumb) {
        thumb.style.backgroundImage = `url(${flsPhotoBase64})`;
        thumb.style.backgroundSize = 'cover';
        thumb.style.backgroundPosition = 'center';
      }
    }

    list.innerHTML = '';
    flsItems.forEach((item, i) => {
      const div = document.createElement('div');
      div.className = 'fls-detected-item';
      div.style.animationDelay = `${i * 90}ms`;
      div.innerHTML = `
        <div class="fls-detected-item-info">
          <span class="fls-detected-item-name">${item.name}</span>
          <span class="fls-detected-item-macros">${item.amount} · B ${Math.round(item.protein)} · S ${Math.round(item.carbs)} · T ${Math.round(item.fat)}</span>
        </div>
        <span class="fls-detected-item-kcal">${Math.round(item.calories)} <span>kcal</span></span>
        <button class="fls-btn-remove" data-i="${i}" type="button">×</button>`;
      list.appendChild(div);
    });

    list.querySelectorAll('.fls-btn-remove').forEach(btn => {
      btn.addEventListener('click', e => {
        const i = parseInt(e.currentTarget.getAttribute('data-i'));
        const row = e.currentTarget.closest('.fls-detected-item');
        burnAndRemove(row, () => {
          flsItems.splice(i, 1);
          renderDetectedStage();
        });
      });
    });

    const totKcal = flsItems.reduce((s, x) => s + Number(x.calories || 0), 0);
    const totP    = flsItems.reduce((s, x) => s + Number(x.protein  || 0), 0);
    const totC    = flsItems.reduce((s, x) => s + Number(x.carbs    || 0), 0);
    const totF    = flsItems.reduce((s, x) => s + Number(x.fat      || 0), 0);
    total.innerHTML = `
      <span class="fls-total-label">Celkem</span>
      <div class="fls-total-right">
        <span class="fls-total-macros">B ${Math.round(totP)} · S ${Math.round(totC)} · T ${Math.round(totF)}</span>
        <span class="fls-total-kcal">${Math.round(totKcal)} <span>kcal</span></span>
      </div>`;

    renderMealPicker();
  }

  function saveItems() {
    if (flsItems.length === 0) { closeSheet(); return; }
    const todayStr = getActiveDateString();
    if (!appState.logs[todayStr]) appState.logs[todayStr] = [];
    const now = new Date();
    const timeStr = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
    // Kategorie: přednastavená (sken z konkrétního jídla) → vybraná uživatelem → podle času
    const cat = flsPresetCategory || flsPickedCategory || guessCategoryByTime();

    flsItems.forEach(item => {
      appState.logs[todayStr].push({
        id: Date.now() + Math.random().toString(36).substr(2,5),
        time: timeStr,
        name: item.name,
        amount: item.amount || '',
        calories: Math.round(Number(item.calories || 0)),
        protein:  Math.round(Number(item.protein  || 0) * 10) / 10,
        carbs:    Math.round(Number(item.carbs    || 0) * 10) / 10,
        fat:      Math.round(Number(item.fat      || 0) * 10) / 10,
        category: cat
      });
    });

    const count = flsItems.length;
    const totKcal = Math.round(flsItems.reduce((s,x) => s + Number(x.calories||0), 0));
    const mealName = (MEALS.find(m => m.id === cat) || {}).name || '';
    saveState();
    renderDashboard();
    closeSheet();
    const word = count === 1 ? 'položka' : (count < 5 ? 'položky' : 'položek');
    showToast(`✅ ${mealName}: ${count} ${word} · ${totKcal} kcal`);
  }

  function scheduleEarlyAnalyzing(delayMs) {
    clearTimeout(flsPhotoTimer);
    // Show analyzing stage early — covers iOS photo-processing delay so user
    // sees feedback immediately instead of staring at the frozen capture screen.
    flsPhotoTimer = setTimeout(() => {
      if (stageCapture.style.display !== 'none') showStage('analyzing');
    }, delayMs);
  }

  function handleFile(file) {
    clearTimeout(flsPhotoTimer);
    if (!file || !file.type.startsWith('image/')) {
      // User cancelled or picked non-image — go back to capture stage.
      showStage('capture');
      return;
    }
    const reader = new FileReader();
    reader.onload = e => handlePhoto(e.target.result);
    reader.readAsDataURL(file);
  }

  scrim.addEventListener('click', closeSheet);
  btnClose.addEventListener('click', closeSheet);
  shutter.addEventListener('click', () => { camInput.click(); scheduleEarlyAnalyzing(400); });
  btnGallery.addEventListener('click', () => { galInput.click(); scheduleEarlyAnalyzing(1200); });
  btnBarcode.addEventListener('click', () => {
    closeSheet();
    document.getElementById('btn-wizard-scan-barcode')?.click();
  });
  camInput.addEventListener('change', e => handleFile(e.target.files[0]));
  galInput.addEventListener('change', e => handleFile(e.target.files[0]));
  document.getElementById('fls-btn-save').addEventListener('click', saveItems);

  choicesRetake.addEventListener('click', () => {
    flsPhotoBase64 = null;
    flsChoices = [];
    capturePreview.style.display = 'none';
    vfPlaceholder.style.display = '';
    showStage('capture');
  });

  refineBtn.addEventListener('click', refineWithAI);
  refineInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); refineWithAI(); }
  });

  window.openFoodLogSheet = openSheet;
  window.closeFoodLogSheet = closeSheet;
}

// ==========================================================================
// TAB NAVIGATION & SCREEN SWITCHER
// ==========================================================================
function initNavigation() {
  const tabs = document.querySelectorAll('.nav-item');
  const screens = document.querySelectorAll('.app-screen');
  const fab = document.querySelector('.nav-fab');
  
  // History screen inner tabs
  const tabHistoryMeals = document.getElementById('tab-history-meals');
  const tabHistoryProgress = document.getElementById('tab-history-progress');
  const viewHistoryMeals = document.getElementById('history-meals-view');
  const viewHistoryProgress = document.getElementById('history-progress-view');
  const historyTitle = document.getElementById('history-screen-title');

  function showHistoryTab(tabType) {
    if (!tabHistoryMeals || !tabHistoryProgress) return;
    if (tabType === 'meals') {
      tabHistoryMeals.classList.add('active');
      tabHistoryProgress.classList.remove('active');
      if (viewHistoryMeals) {
        viewHistoryMeals.classList.add('active');
        viewHistoryMeals.style.display = 'block';
      }
      if (viewHistoryProgress) {
        viewHistoryProgress.classList.remove('active');
        viewHistoryProgress.style.display = 'none';
      }
      if (historyTitle) historyTitle.innerText = "Moje historie";
    } else {
      tabHistoryProgress.classList.add('active');
      tabHistoryMeals.classList.remove('active');
      if (viewHistoryProgress) {
        viewHistoryProgress.classList.add('active');
        viewHistoryProgress.style.display = 'block';
      }
      if (viewHistoryMeals) {
        viewHistoryMeals.classList.remove('active');
        viewHistoryMeals.style.display = 'none';
      }
      if (historyTitle) historyTitle.innerText = "Vývoj váhy";
    }
  }

  if (tabHistoryMeals && tabHistoryProgress) {
    tabHistoryMeals.addEventListener('click', () => showHistoryTab('meals'));
    tabHistoryProgress.addEventListener('click', () => showHistoryTab('progress'));
  }
  
  function switchScreen(targetScreenId, tabType) {
    // Update Tab active states
    tabs.forEach(t => t.classList.remove('active'));
    
    // Find the corresponding tab and activate it, if any
    let matchingTab;
    if (targetScreenId === 'screen-history') {
      matchingTab = document.getElementById(tabType === 'progress' ? 'nav-progres' : 'nav-jidla');
    } else {
      matchingTab = document.querySelector(`.nav-item[data-screen="${targetScreenId.replace('screen-', '')}"]`);
    }
    if (matchingTab) matchingTab.classList.add('active');
    
    // Update Screen active states
    screens.forEach(screen => {
      if (screen.id === targetScreenId) {
        screen.classList.add('active');
        // Perform screen-specific refresh
        if (targetScreenId === 'screen-dashboard') {
          renderDashboard();
        } else if (targetScreenId === 'screen-plan') {
          renderPlanScreen();
        } else if (targetScreenId === 'screen-history') {
          showHistoryTab(tabType || 'meals');
          renderHistory();
        } else if (targetScreenId === 'screen-settings') {
          renderSettings();
          checkTelegramStatus();
        } else if (targetScreenId === 'screen-add') {
          showWizardStep(1);
        }
      } else {
        screen.classList.remove('active');
      }
    });
  }

  // Vystav pro ostatní moduly (čárový kód, ruční přidání)
  window.switchAppScreen = switchScreen;

  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const screenAttr = tab.getAttribute('data-screen');
      if (screenAttr) {
        const tabType = tab.id === 'nav-progres' ? 'progress' : 'meals';
        switchScreen(`screen-${screenAttr}`, tabType);
      }
    });
  });
  
  // Floating Action Button — opens the new food log sheet
  if (fab) {
    fab.addEventListener('click', () => {
      if (window.openFoodLogSheet) {
        window.openFoodLogSheet();
      } else {
        switchScreen('screen-add');
      }
    });
  }
  
  // Dashboard Quick Action Links
  const qaAdd = document.getElementById('qa-add');
  const qaCamera = document.getElementById('qa-camera');
  const qaMic = document.getElementById('qa-mic');
  
  if (qaAdd) qaAdd.addEventListener('click', () => {
    const now = new Date();
    const hour = now.getHours();
    let categoryId = 'Breakfast';
    if (hour >= 5 && hour < 10) categoryId = 'Breakfast';
    else if (hour >= 10 && hour < 12) categoryId = 'Morning snack';
    else if (hour >= 12 && hour < 15) categoryId = 'Lunch';
    else if (hour >= 15 && hour < 18) categoryId = 'Afternoon snack';
    else if (hour >= 18 && hour < 22) categoryId = 'Dinner';
    else categoryId = 'Second dinner';
    
    switchScreen('screen-add');
    setWizardCategory(categoryId);
    showWizardStep(2);
  });
  
  if (qaCamera) qaCamera.addEventListener('click', () => {
    const now = new Date();
    const hour = now.getHours();
    let categoryId = 'Breakfast';
    if (hour >= 5 && hour < 10) categoryId = 'Breakfast';
    else if (hour >= 10 && hour < 12) categoryId = 'Morning snack';
    else if (hour >= 12 && hour < 15) categoryId = 'Lunch';
    else if (hour >= 15 && hour < 18) categoryId = 'Afternoon snack';
    else if (hour >= 18 && hour < 22) categoryId = 'Dinner';
    else categoryId = 'Second dinner';
    
    switchScreen('screen-add');
    setWizardCategory(categoryId);
    showWizardStep(2);
    
    startCustomCamera();
  });
  
  const qaHistory = document.getElementById('qa-history');
  if (qaHistory) qaHistory.addEventListener('click', () => switchScreen('screen-history', 'meals'));

  if (qaMic) qaMic.addEventListener('click', () => {
    const now = new Date();
    const hour = now.getHours();
    let categoryId = 'Breakfast';
    if (hour >= 5 && hour < 10) categoryId = 'Breakfast';
    else if (hour >= 10 && hour < 12) categoryId = 'Morning snack';
    else if (hour >= 12 && hour < 15) categoryId = 'Lunch';
    else if (hour >= 15 && hour < 18) categoryId = 'Afternoon snack';
    else if (hour >= 18 && hour < 22) categoryId = 'Dinner';
    else categoryId = 'Second dinner';
    
    switchScreen('screen-add');
    setWizardCategory(categoryId);
    showWizardStep(2);
    
    const textInput = document.getElementById('ai-text-input');
    if (textInput) textInput.focus();
  });
  
  // Settings view Toggle Gemini key visibility
  const btnToggleKey = document.getElementById('btn-toggle-key');
  const inputKey = document.getElementById('input-gemini-key');
  if (btnToggleKey && inputKey) {
    btnToggleKey.addEventListener('click', () => {
      if (inputKey.type === 'password') {
        inputKey.type = 'text';
        btnToggleKey.innerText = 'Skrýt';
      } else {
        inputKey.type = 'password';
        btnToggleKey.innerText = 'Zobrazit';
      }
    });
  }
}

// ==========================================================================
// CAMERA & PHOTO UPLOAD LOGIC
// ==========================================================================
let cameraStream = null;

async function startCustomCamera() {
  const modal = document.getElementById('custom-camera-modal');
  const video = document.getElementById('camera-video');
  if (modal) modal.classList.add('active');
  
  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: "environment",
        width: { ideal: 1280 },
        height: { ideal: 960 }
      },
      audio: false
    });
    if (video) {
      video.srcObject = cameraStream;
      video.setAttribute('playsinline', true); // Critical for iOS Safari
      video.play();
    }
  } catch (err) {
    console.error("Camera access error:", err);
    alert("Nepodařilo se spustit fotoaparát. Ujisti se, že jsi povolil(a) přístup ke kameře.");
    stopCustomCamera();
  }
}

function stopCustomCamera() {
  const modal = document.getElementById('custom-camera-modal');
  if (modal) modal.classList.remove('active');
  const video = document.getElementById('camera-video');
  if (video) video.srcObject = null;
  if (cameraStream) {
    cameraStream.getTracks().forEach(track => track.stop());
    cameraStream = null;
  }
}

function captureCustomCameraPhoto() {
  const video = document.getElementById('camera-video');
  if (!video || !cameraStream) return;
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth || 640;
  canvas.height = video.videoHeight || 480;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
  currentPhotoBase64 = dataUrl;
  
  const previewArea = document.getElementById('photo-preview-area');
  const previewImg = document.getElementById('photo-preview-img');
  const photoTrigger = document.getElementById('btn-photo-trigger');
  const galleryContainer = document.getElementById('gallery-trigger-container');
  
  if (previewImg) previewImg.src = currentPhotoBase64;
  if (previewArea) previewArea.style.display = 'block';
  if (photoTrigger) photoTrigger.style.display = 'none';
  if (galleryContainer) galleryContainer.style.display = 'none';
  
  stopCustomCamera();
  showToast("Fotka zachycena! 📸");
}

function initPhotoHandlers() {
  const photoTrigger = document.getElementById('btn-photo-trigger');
  const galleryTrigger = document.getElementById('btn-gallery-trigger');
  const galleryContainer = document.getElementById('gallery-trigger-container');
  const cameraInput = document.getElementById('camera-input');
  const galleryInput = document.getElementById('gallery-input');
  
  const previewArea = document.getElementById('photo-preview-area');
  const previewImg = document.getElementById('photo-preview-img');
  const clearPhotoBtn = document.getElementById('btn-clear-photo');
  
  // Custom camera listeners
  const btnCloseCustomCamera = document.getElementById('btn-close-custom-camera');
  if (btnCloseCustomCamera) {
    btnCloseCustomCamera.addEventListener('click', stopCustomCamera);
  }
  
  const btnCameraCapture = document.getElementById('btn-camera-capture');
  if (btnCameraCapture) {
    btnCameraCapture.addEventListener('click', captureCustomCameraPhoto);
  }

  // Clicking the main trigger opens custom camera directly
  if (photoTrigger) {
    photoTrigger.addEventListener('click', () => {
      startCustomCamera();
    });
  }
  
  // Clicking the gallery link opens gallery picker
  if (galleryTrigger) {
    galleryTrigger.addEventListener('click', () => {
      galleryInput.click();
    });
  }
  
  // Handle image files selection
  function handleImageFile(file) {
    if (!file) return;
    
    if (!file.type.startsWith('image/')) {
      alert('Zvol prosím soubor obrázku.');
      return;
    }
    
    const reader = new FileReader();
    reader.onload = function(event) {
      currentPhotoBase64 = event.target.result;
      
      // Update UI Preview
      previewImg.src = currentPhotoBase64;
      previewArea.style.display = 'block';
      photoTrigger.style.display = 'none';
      if (galleryContainer) galleryContainer.style.display = 'none';
    };
    reader.readAsDataURL(file);
  }
  
  cameraInput.addEventListener('change', (e) => handleImageFile(e.target.files[0]));
  galleryInput.addEventListener('change', (e) => handleImageFile(e.target.files[0]));
  
  // Clear preview photo
  clearPhotoBtn.addEventListener('click', () => {
    currentPhotoBase64 = null;
    previewImg.src = '';
    previewArea.style.display = 'none';
    photoTrigger.style.display = 'flex';
    if (galleryContainer) galleryContainer.style.display = 'block';
    cameraInput.value = '';
    galleryInput.value = '';
  });
}

// ==========================================================================
// GEMINI AI SERVICE INTEGRATION
// ==========================================================================

// Downscale a data-URL image to at most maxDim on its longest side and
// re-encode as JPEG. Keeps the request small enough for the serverless proxy
// and speeds up analysis without hurting recognition quality.
function downscaleImage(dataUrl, maxDim = 1024, quality = 0.8) {
  return new Promise((resolve) => {
    try {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width > maxDim || height > maxDim) {
          if (width >= height) {
            height = Math.round(height * (maxDim / width));
            width = maxDim;
          } else {
            width = Math.round(width * (maxDim / height));
            height = maxDim;
          }
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.onerror = () => resolve(dataUrl); // fall back to original on error
      img.src = dataUrl;
    } catch (e) {
      resolve(dataUrl);
    }
  });
}

// Match AI-detected foods against foods the user already knows — both
// favorites AND anything previously logged — and swap in the saved values, so
// a known item like "Proteinové kafe" uses the numbers the user already
// entered instead of a fresh AI estimate.
function normalizeFoodName(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // strip diacritics
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Collect known foods: favorites first (curated → priority), then previously
// logged entries (most recent first), deduped by normalized name. For logged
// items with leftovers, use the original (full-portion) values.
function getKnownFoods(limit = 100) {
  const map = new Map();
  const add = (f) => {
    if (!f || !f.name) return;
    const key = normalizeFoodName(f.name);
    if (!key || map.has(key)) return;
    const src = f.original || f; // prefer the as-logged original portion
    map.set(key, {
      name: f.name,
      amount: f.amount || src.amount || '100g',
      calories: Number(src.calories) || 0,
      protein: Number(src.protein) || 0,
      carbs: Number(src.carbs) || 0,
      fat: Number(src.fat) || 0
    });
  };
  (appState.favorites || []).forEach(add);
  const dates = Object.keys(appState.logs || {}).sort((a, b) => b.localeCompare(a));
  for (const d of dates) {
    const items = appState.logs[d] || [];
    for (let i = items.length - 1; i >= 0; i--) {
      add(items[i]);
      if (map.size >= limit) break;
    }
    if (map.size >= limit) break;
  }
  return Array.from(map.values());
}

function matchKnownFood(name, known) {
  const n = normalizeFoodName(name);
  if (!n) return null;
  // 1) exact normalized match
  let hit = known.find((f) => normalizeFoodName(f.name) === n);
  if (hit) return hit;
  // 2) one name contained in the other (only for sufficiently specific names)
  hit = known.find((f) => {
    const fn = normalizeFoodName(f.name);
    if (fn.length < 5) return false;
    return fn.includes(n) || n.includes(fn);
  });
  return hit || null;
}

function applyKnownFoodToItem(item, known) {
  if (!item || !item.name) return item;
  const fav = matchKnownFood(item.name, known);
  if (!fav) return item;
  item.name = fav.name; // canonical saved name
  item.amount = fav.amount || item.amount;
  item.calories = Number(fav.calories) || 0;
  item.protein = Number(fav.protein) || 0;
  item.carbs = Number(fav.carbs) || 0;
  item.fat = Number(fav.fat) || 0;
  item.fromFavorite = true;
  return item;
}

function sumItemsTotal(items) {
  return (items || []).reduce((t, x) => ({
    calories: Math.round(t.calories + (Number(x.calories) || 0)),
    protein: Math.round((t.protein + (Number(x.protein) || 0)) * 10) / 10,
    carbs: Math.round((t.carbs + (Number(x.carbs) || 0)) * 10) / 10,
    fat: Math.round((t.fat + (Number(x.fat) || 0)) * 10) / 10
  }), { calories: 0, protein: 0, carbs: 0, fat: 0 });
}

// Walk a Gemini result (choices or items) and substitute known foods.
function applyKnownFoods(geminiData) {
  if (!geminiData) return geminiData;
  const known = getKnownFoods();
  if (known.length === 0) return geminiData;
  if (Array.isArray(geminiData.choices)) {
    geminiData.choices.forEach((ch) => {
      if (Array.isArray(ch.items)) {
        ch.items.forEach((it) => applyKnownFoodToItem(it, known));
        ch.total = sumItemsTotal(ch.items);
      }
    });
  }
  if (Array.isArray(geminiData.items)) {
    geminiData.items.forEach((it) => applyKnownFoodToItem(it, known));
    geminiData.total = sumItemsTotal(geminiData.items);
  }
  return geminiData;
}

async function callGeminiAPI(textPrompt, imageBase64, options = {}) {
  const isLeftover = options.leftover === true;

  // Shrink the photo before sending it through the backend proxy. Smaller =
  // faster for the model to process (less likely to time out when Gemini is
  // busy); 768px is still plenty for food recognition.
  if (imageBase64) {
    imageBase64 = await downscaleImage(imageBase64, 768, 0.72);
  }

  let systemInstructionText = `Jsi PROFESIONÁLNÍ NUTRIČNÍ SPECIALISTA a přesný měřič kalorií s mnohaletou praxí v odhadu velikosti porcí z fotografií. Tvým úkolem je analyzovat vstup uživatele a vrátit přesná, realistická data o jídlech a jejich nutričních hodnotách v JSON formátu.

KLÍČOVÁ PRAVIDLA PRO ODHAD HMOTNOSTI (nejdůležitější!):
- NIKDY nepoužívej 100 g jako automatickou výchozí hodnotu. 100 g je špatný "kulatý" odhad — vždy spočítej skutečnou hmotnost podle počtu kusů nebo vizuální velikosti.
- POČÍTEJ KUSY: pokud je potravina kusová/plátková (plátky šunky, sýra, krajíce chleba, vejce, sušenky), urči POČET kusů a vynásob ho hmotností jednoho kusu. Příklad: "2 plátky šunky" = 2 × 20 g = 40 g (NE 100 g!).
- Referenční hmotnost JEDNOHO kusu:
  • plátek šunky/salámu (na chleba) ~15–25 g, prosciutto/tenký plátek ~10–15 g
  • plátek taveného/eidamu ~20–30 g, plátek toustového chleba ~25 g
  • krajíc chleba (běžný) ~40–50 g, rohlík ~43 g, houska ~50 g
  • vejce M ~55–60 g, lžíce (oleje/medu) ~10–15 g, lžička ~5 g
  • plátek rajčete ~15 g, kolečko okurky ~5 g, sušenka ~8–12 g, čtverečka čokolády ~5 g
- Referenční velikost PORCE (na váhu): kuřecí prso 120–180 g, příloha rýže/těstovin 150–250 g (vařené), brambory 200–300 g, příloha zeleniny 80–150 g, jogurt 150 g, kopeček zmrzliny ~50 g.
- Referenční velikost ČESKÝCH JÍDEL: smažený řízek domácí 80–150 g (1 kus, tenký), smažený řízek restaurační 150–250 g; bramborová kaše 150–200 g jako příloha; svíčková omáčka 100–150 ml; guláš 200–250 g; knedlík houskový 1 kus ~60–70 g (2 knedlíky = 120–140 g).
- KALORICKÁ HUSTOTA smažených jídel: smažený vepřový/kuřecí řízek ~230–270 kcal/100 g (ne 400+!); bramborová kaše ~90–110 kcal/100 g; hranolky ~280–320 kcal/100 g.
- POZOR: AI má tendenci NADHODNOCOVAT VELIKOST PORCÍ. Domácí porce jsou typicky MENŠÍ než restaurační. Polévková miska je malá (~400–500 ml), talíř ~26 cm. Pokud jídlo vypadá jako domácí nebo malá porce — odhadni hmotnost NIŽŠÍ ze svého rozsahu.
- Vždy zohledni REALISTICKOU velikost na fotce (referenční objekty: talíř ~26 cm, příbor, ruka). Při pochybnostech raději odhadni MENŠÍ, realističtější hmotnost než nadhodnotit.
- Nutriční hodnoty (calories, protein, carbs, fat) MUSÍ matematicky odpovídat uvedené hmotnosti "amount". Nejdřív urči hmotnost, pak z ní spočítej makra a kalorie.
- Kalorie ověř vztahem: calories ≈ protein*4 + carbs*4 + fat*9 (s tolerancí ±10 %). Hodnoty musí být vnitřně konzistentní.
- Pole "amount" uváděj vždy v gramech ve formátu "40g" (u tekutin "250ml"). U kusových potravin můžeš uvést i počet kusů, ale gramáž musí sedět (např. "2 plátky (40g)").

Pravidla pro výstup:
1. Musíš vrátit pouze validní JSON objekt. Žádný doprovodný text, žádné markdown obaly (nepoužívej \`\`\`json ... \`\`\`).
2. Pokud uživatel zadal POUZE TEXT, odhadni nutriční hodnoty a uveď seznam jídel v poli "items" (formát type "text_result"):
{
  "type": "text_result",
  "items": [
    {
      "name": "český název jídla/suroviny",
      "amount": "100g",
      "calories": 120,
      "protein": 5.5,
      "carbs": 12.0,
      "fat": 3.2
    }
  ],
  "total": {
    "calories": 120,
    "protein": 5.5,
    "carbs": 12.0,
    "fat": 3.2
  }
}

3. Pokud uživatel nahrál OBRÁZEK, postupuj v tomto pořadí:
   a) Identifikuj VŠECHNY viditelné složky jídla — základ/podklad (talíř, miska, chléb, cereálie, rýže…), hlavní ingredience, přílohy, omáčky, nápoje. Nepřehlédni nic!
   b) Navrhni přesně 3 NEJPRAVDĚPODOBNĚJŠÍ varianty celého jídla. KAŽDÁ varianta MUSÍ zahrnovat VŠECHNY viditelné složky — varianty se liší jen v těch prvcích, kde si nejsi jistý (např. druh cereálií, druh ovoce, způsob přípravy masa). Složky, které jsou jasně viditelné, zahrň do KAŽDÉ varianty bez výjimky.
   c) U každé varianty odhadni hmotnost každé složky co nejpřesněji.
   Vrať JSON v tomto formátu (formát type "image_choices"):
{
  "type": "image_choices",
  "choices": [
    {
      "option_name": "Název 1. varianty (např. Grilované kuřecí prso s rýží a salátem)",
      "items": [
        { "name": "Kuřecí prsa grilovaná", "amount": "150g", "calories": 165, "protein": 31.0, "carbs": 0.0, "fat": 3.6 }
      ],
      "total": { "calories": 165, "protein": 31.0, "carbs": 0.0, "fat": 3.6 }
    },
    {
      "option_name": "Název 2. varianty (např. Smažený kuřecí řízek s bramborovou kaší)",
      "items": [ ... ],
      "total": { ... }
    },
    {
      "option_name": "Název 3. varianty (např. Kuřecí na kari se smetanou a rýží)",
      "items": [ ... ],
      "total": { ... }
    }
  ]
}

4. Pokud uživatel chce UPRAVIT už rozpoznané jídlo (pošle aktuální seznam položek a popis změny, např. "kuřecí dej na 200g" nebo "přidej lžíci oleje"), aplikuj požadovanou změnu, přepočítej hmotnosti a nutriční hodnoty a vrať CELÝ aktualizovaný seznam ve formátu type "text_result". Zachovej položky, kterých se změna netýká.

Pokud nelze jídlo vůbec identifikovat nebo je vstup nesmyslný, vrať prázdný text_result s nulovými hodnotami.`;

  if (isLeftover) {
    systemInstructionText += `

REŽIM ZBYTKY (DŮLEŽITÉ): Tato fotka ukazuje ZBYTEK porce jídla, který NEBYL snězen — tedy to, co po jídle ZBYLO na talíři. NEPŘEDPOKLÁDEJ, že jde o nové, celé jídlo. Odhadni kalorie a makra POUZE toho, co je viditelné na fotce (nedojedený zbytek). Vrať VŽDY JSON typu "text_result" s jednou nebo více položkami a polem "total" (součet zbytku). Nevracej "image_choices" ani 3 varianty.`;
  } else {
    // Tell the model about the user's known foods (favorites + previously
    // logged) so it labels a recognised item with the exact saved name — we
    // then swap in the saved values.
    const knownNames = getKnownFoods().map((f) => f.name).filter(Boolean).slice(0, 80);
    if (knownNames.length) {
      systemInstructionText += `

ZNÁMÁ JÍDLA UŽIVATELE (jeho oblíbená a dříve zadaná jídla):
${knownNames.map((n) => `- ${n}`).join('\n')}
Pokud rozpoznané jídlo odpovídá některému z těchto známých jídel uživatele, POUŽIJ PŘESNĚ jeho název (stejný zápis) jako "name" alespoň v jedné z variant. Tím se spáruje s jeho uloženými nutričními hodnotami.`;
    }
  }

  // Assemble Gemini Parts
  const parts = [];
  
  if (textPrompt) {
    parts.push({ text: `Uživatelův popis jídla: ${textPrompt}` });
  } else if (!imageBase64) {
    throw new Error("Musíš zadat buď textový popis jídla, vyfotit jídlo, nebo obojí.");
  }
  
  if (imageBase64) {
    // Extract base64 format metadata
    const mimeMatch = imageBase64.match(/^data:(image\/[a-zA-Z+]+);base64,/);
    if (!mimeMatch) {
      throw new Error("Neplatný formát obrázku.");
    }
    const mimeType = mimeMatch[1];
    const rawData = imageBase64.split(',')[1];
    
    parts.push({
      inlineData: {
        mimeType: mimeType,
        data: rawData
      }
    });
    
    if (isLeftover) {
      parts.push({ text: "Tato fotka ukazuje ZBYTEK (nedojedenou část) jídla. Odhadni kalorie a makra POUZE toho, co je na fotce vidět, a vrať jeden výsledek typu text_result s polem total." });
    } else {
      parts.push({ text: "Identifikuj VŠECHNY viditelné složky jídla (základ, hlavní ingredience, přílohy, omáčky). Pak navrhni 3 nejpravděpodobnější varianty — každá musí obsahovat VŠECHNY viditelné složky, liší se jen tam, kde si nejsi jistý. Rozepiš je podle pravidel." });
    }
  }

  const payload = {
    systemInstruction: {
      parts: [
        { text: systemInstructionText }
      ]
    },
    contents: [
      {
        parts: parts
      }
    ],
    generationConfig: {
      response_mime_type: "application/json"
    }
  };

  // Route through the backend proxy so the API key stays server-side.
  const session = getSession();
  const response = await fetch('/api/gemini', {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${session ? session.token : ''}`
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errData = await response.json().catch(() => ({}));
    const message = errData.error?.message || `Chyba API: ${response.status}`;
    throw new Error(message);
  }

  const resData = await response.json();
  let resultText = resData.candidates?.[0]?.content?.parts?.[0]?.text;
  
  if (!resultText) {
    throw new Error("Od Gemini API se nepodařilo získat žádný text.");
  }

  // Sanitize Markdown JSON wrapping if any
  resultText = resultText.trim();
  if (resultText.startsWith('```json')) {
    resultText = resultText.substring(7);
  }
  if (resultText.startsWith('```')) {
    resultText = resultText.substring(3);
  }
  if (resultText.endsWith('```')) {
    resultText = resultText.substring(0, resultText.length - 3);
  }

  try {
    const parsed = JSON.parse(resultText.trim());
    // Swap in saved values for foods the user already knows (not in leftover mode).
    return isLeftover ? parsed : applyKnownFoods(parsed);
  } catch (e) {
    console.error("Neplatná JSON odpověď od Gemini: ", resultText);
    throw new Error("AI odpověď se nepodařilo zpracovat jako JSON.");
  }
}

// ==========================================================================
// AI REVIEW MODAL CONTROLS
// ==========================================================================
function attachBaseValues(items) {
  items.forEach(item => {
    if (!item._baseAmountUnit) {
      const parsed = parseQuantity(item.amount || '100g');
      item._baseAmountVal = parsed.value || 1; // prevent div by zero
      item._baseAmountUnit = parsed.unit;
      
      item._baseCal = (Number(item.calories) || 0) / item._baseAmountVal;
      item._baseP = (Number(item.protein) || 0) / item._baseAmountVal;
      item._baseC = (Number(item.carbs) || 0) / item._baseAmountVal;
      item._baseF = (Number(item.fat) || 0) / item._baseAmountVal;
    }
  });
  return items;
}

function openReviewModal(geminiData) {
  currentGeminiData = geminiData;
  selectedOptionIndex = 0;
  
  const optionsContainer = document.getElementById('ai-options-container');
  const modalSubtitle = document.getElementById('ai-modal-subtitle');
  
  if (geminiData.type === 'image_choices' && geminiData.choices && geminiData.choices.length > 0) {
    optionsContainer.style.display = 'flex';
    optionsContainer.innerHTML = '';
    
    // Set subtitle text
    modalSubtitle.innerText = "Vyber si jednu ze 3 variant odhadu AI a zkontroluj ji:";
    
    // Initialize with first choice's items (deep clone)
    tempDetectedItems = attachBaseValues(JSON.parse(JSON.stringify(geminiData.choices[0].items)));
    
    // Render options list cards
    geminiData.choices.forEach((choice, index) => {
      const card = document.createElement('div');
      card.className = `option-card${index === 0 ? ' active' : ''}`;
      card.setAttribute('data-index', index);
      
      const itemWord = choice.items.length === 1 ? 'položka' : (choice.items.length < 5 ? 'položky' : 'položek');
      
      card.innerHTML = `
        <div class="option-card-left">
          <span class="option-card-title">${choice.option_name}</span>
          <span class="option-card-subtitle">${choice.items.length} ${itemWord}</span>
        </div>
        <span class="option-card-cal">${choice.total.calories} kcal</span>
      `;
      
      card.addEventListener('click', () => {
        selectedOptionIndex = index;
        
        // Toggle active class on cards
        optionsContainer.querySelectorAll('.option-card').forEach((c, idx) => {
          c.classList.toggle('active', idx === index);
        });
        
        // Load items of chosen option
        tempDetectedItems = attachBaseValues(JSON.parse(JSON.stringify(geminiData.choices[index].items)));
        
        // Re-render items
        renderReviewModal();
      });
      
      optionsContainer.appendChild(card);
    });
  } else {
    // Hide option selector if it is a text-only scan
    optionsContainer.style.display = 'none';
    modalSubtitle.innerText = "Prověř a uprav položky, které Gemini AI rozpoznala:";
    
    // Use simple items array
    tempDetectedItems = attachBaseValues(JSON.parse(JSON.stringify(geminiData.items || [])));
  }
  
  renderReviewModal();
  document.getElementById('ai-review-modal').classList.add('active');
}

function updateAiModalTotals() {
  let totalCal = 0;
  let totalP = 0;
  let totalC = 0;
  let totalF = 0;
  
  tempDetectedItems.forEach(item => {
    totalCal += Number(item.calories || 0);
    totalP += Number(item.protein || 0);
    totalC += Number(item.carbs || 0);
    totalF += Number(item.fat || 0);
  });
  
  document.getElementById('modal-summary-cal').innerText = `${totalCal} kcal`;
  document.getElementById('modal-summary-p').innerText = Math.round(totalP * 10) / 10;
  document.getElementById('modal-summary-c').innerText = Math.round(totalC * 10) / 10;
  document.getElementById('modal-summary-f').innerText = Math.round(totalF * 10) / 10;
}

function renderReviewModal() {
  const listContainer = document.getElementById('ai-detected-list');
  listContainer.innerHTML = '';

  if (tempDetectedItems.length === 0) {
    listContainer.innerHTML = `<p class="empty-state">AI nerozpoznala žádná jídla. Zkus jiný popis/fotku.</p>`;
  } else {
    tempDetectedItems.forEach((item, index) => {
      const div = document.createElement('div');
      div.className = 'detected-item';
      div.innerHTML = `
        <div class="detected-item-left">
          <span class="detected-item-name">${item.name}</span>
          <input type="text" class="detected-item-amount-input" data-index="${index}" value="${item.amount || '100g'}" style="background: rgba(255,255,255,0.06); border: 1px solid var(--border-glass); color: #fff; border-radius: 6px; padding: 4px 8px; font-size: 13px; width: 80px; margin-top: 4px; margin-bottom: 4px;">
          <span class="detected-item-macros" id="ai-macro-${index}">B: ${item.protein}g • S: ${item.carbs}g • T: ${item.fat}g</span>
        </div>
        <div class="detected-item-right">
          <span class="detected-item-cal" id="ai-cal-${index}">${item.calories} kcal</span>
          <button class="btn-remove-detected" data-index="${index}">×</button>
        </div>`;
      
      listContainer.appendChild(div);
    });

    listContainer.querySelectorAll('.btn-remove-detected').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const index = parseInt(e.target.getAttribute('data-index'));
        tempDetectedItems.splice(index, 1);
        renderReviewModal();
      });
    });

    listContainer.querySelectorAll('.detected-item-amount-input').forEach(input => {
      input.addEventListener('input', (e) => {
        const idx = parseInt(e.target.getAttribute('data-index'));
        const item = tempDetectedItems[idx];
        const newVal = e.target.value;
        item.amount = newVal;
        
        const parsed = parseQuantity(newVal, item._baseAmountUnit);
        
        item.calories = Math.round(item._baseCal * parsed.value);
        item.protein = Math.round(item._baseP * parsed.value * 10) / 10;
        item.carbs = Math.round(item._baseC * parsed.value * 10) / 10;
        item.fat = Math.round(item._baseF * parsed.value * 10) / 10;
        
        document.getElementById(`ai-cal-${idx}`).innerText = `${item.calories} kcal`;
        document.getElementById(`ai-macro-${idx}`).innerText = `B: ${item.protein}g • S: ${item.carbs}g • T: ${item.fat}g`;
        
        updateAiModalTotals();
      });
    });
  }

  // Update totals in Modal
  updateAiModalTotals();
}

function saveReviewedItemsToLog() {
  if (tempDetectedItems.length === 0) {
    showToast("Žádná jídla k uložení.");
    closeModal();
    return;
  }
  
  const todayStr = getActiveDateString();
  if (!appState.logs[todayStr]) {
    appState.logs[todayStr] = [];
  }

  const now = new Date();
  const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

  const categorySelect = document.getElementById('input-food-category');
  const categoryStr = categorySelect ? categorySelect.value : 'Breakfast';

  tempDetectedItems.forEach(item => {
    appState.logs[todayStr].push({
      id: Date.now() + Math.random().toString(36).substr(2, 5),
      time: timeStr,
      name: item.name,
      amount: item.amount || '',
      calories: Math.round(Number(item.calories || 0)),
      protein: Math.round(Number(item.protein || 0) * 10) / 10,
      carbs: Math.round(Number(item.carbs || 0) * 10) / 10,
      fat: Math.round(Number(item.fat || 0) * 10) / 10,
      category: categoryStr
    });
  });
  
  const numAdded = tempDetectedItems.length;
  
  saveState();
  closeModal();
  
  // Reset fields in scanner view
  document.getElementById('ai-text-input').value = '';
  document.getElementById('btn-clear-photo').click();
  
  // Go to Dashboard
  const dashTab = document.querySelector('.nav-item[data-screen="dashboard"]');
  if (dashTab) dashTab.click();
  
  showToast(`${numAdded} jídel přidáno!`);
}

function closeModal() {
  document.getElementById('ai-review-modal').classList.remove('active');
  tempDetectedItems = [];
}

// ==========================================================================
// SUBMIT FORMS & USER ACTIONS
// ==========================================================================
function initFormHandlers() {
  const manualForm = document.getElementById('manual-food-form');
  const settingsSaveBtn = document.getElementById('btn-save-settings');
  const dataResetBtn = document.getElementById('btn-reset-data');
  const aiAnalyzeBtn = document.getElementById('btn-ai-analyze');
  
  // Modal buttons
  document.getElementById('btn-close-modal').addEventListener('click', closeModal);
  document.getElementById('btn-modal-cancel').addEventListener('click', closeModal);
  document.getElementById('btn-modal-confirm').addEventListener('click', saveReviewedItemsToLog);
  
  // Amount change input listener for auto-recalculation
  const inputFoodAmount = document.getElementById('input-food-amount');
  if (inputFoodAmount) {
    inputFoodAmount.addEventListener('input', () => {
      if (!currentFormBaseValues) return;
      
      const amountVal = inputFoodAmount.value.trim();
      const multiplier = getQuantityMultiplier(amountVal, currentFormBaseValues.baseUnit);
      
      if (!isNaN(multiplier) && multiplier > 0) {
        document.getElementById('input-food-cal').value = Math.round(currentFormBaseValues.calories * multiplier);
        document.getElementById('input-food-p').value = Math.round(currentFormBaseValues.protein * multiplier * 10) / 10;
        document.getElementById('input-food-c').value = Math.round(currentFormBaseValues.carbs * multiplier * 10) / 10;
        document.getElementById('input-food-f').value = Math.round(currentFormBaseValues.fat * multiplier * 10) / 10;
      }
    });
  }
  
  // Unlock Form Fields Button
  const btnUnlockForm = document.getElementById('btn-unlock-form');
  if (btnUnlockForm) {
    btnUnlockForm.addEventListener('click', () => {
      lockManualFormFields(false);
      btnUnlockForm.style.display = 'none';
    });
  }
  
  const saveManualFormItem = (redirectToDashboard = true) => {
    const name = document.getElementById('input-food-name').value.trim();
    if (!name) return;
    
    const calories = parseInt(document.getElementById('input-food-cal').value) || 0;
    const category = document.getElementById('input-food-category').value;
    const amount = document.getElementById('input-food-amount').value.trim() || '';
    const protein = parseFloat(document.getElementById('input-food-p').value) || 0;
    const carbs = parseFloat(document.getElementById('input-food-c').value) || 0;
    const fat = parseFloat(document.getElementById('input-food-f').value) || 0;
    
    const todayStr = getActiveDateString();
    if (!appState.logs[todayStr]) {
      appState.logs[todayStr] = [];
    }

    const now = new Date();
    const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

    appState.logs[todayStr].push({
      id: Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
      time: timeStr,
      name,
      amount,
      calories,
      protein,
      carbs,
      fat,
      category
    });
    
    saveState();
    resetManualFoodForm();
    
    showToast(`Přidáno: ${name} ➕`);
    
    if (redirectToDashboard) {
      const dashTab = document.querySelector('.nav-item[data-screen="dashboard"]');
      if (dashTab) dashTab.click();
    }
  };

  // Handle Manual Log Submission
  manualForm.addEventListener('submit', (e) => {
    e.preventDefault();
    saveManualFormItem(true);
  });
  
  // Handle Add and Write Next Button Click
  const btnSubmitAndNext = document.getElementById('btn-submit-and-next');
  if (btnSubmitAndNext) {
    btnSubmitAndNext.addEventListener('click', () => {
      if (manualForm.reportValidity()) {
        saveManualFormItem(false);
      }
    });
  }
  
  // Save Settings Click
  settingsSaveBtn.addEventListener('click', saveSettingsFromUI);
  
  // Reset Data Click
  dataResetBtn.addEventListener('click', () => {
    if (confirm("Opravdu chceš smazat všechna data v aplikaci? Tuto akci nelze vrátit.")) {
      resetState();
      renderDashboard();
      renderSettings();
      showToast("Data aplikace byla vymazána.");
      
      // Navigate to dashboard
      const dashTab = document.querySelector('.nav-item[data-screen="dashboard"]');
      if (dashTab) dashTab.click();
    }
  });

  // AI Scan Trigger
  aiAnalyzeBtn.addEventListener('click', async () => {
    const textPrompt = document.getElementById('ai-text-input').value.trim();
    const imageBase64 = currentPhotoBase64;
    
    if (!textPrompt && !imageBase64) {
      alert("Napiš co jsi jedl(a) nebo přidej fotku jídla.");
      return;
    }
    
    // Set loading state
    aiAnalyzeBtn.disabled = true;
    const btnText = aiAnalyzeBtn.querySelector('.btn-text');
    const spinner = aiAnalyzeBtn.querySelector('.spinner');
    
    btnText.innerText = "Analyzuji pomocí Gemini AI...";
    spinner.style.display = 'inline-block';
    
    try {
      const responseJSON = await callGeminiAPI(textPrompt, imageBase64);
      openReviewModal(responseJSON);
    } catch (err) {
      console.error(err);
      alert(`Nepodařilo se analyzovat jídlo:\n${err.message}`);
    } finally {
      // Restore button state
      aiAnalyzeBtn.disabled = false;
      btnText.innerText = "Analyzovat s Gemini AI";
      spinner.style.display = 'none';
    }
  });
}

// ==========================================================================
// AUTHENTICATION & CLOUD SYNC
// ==========================================================================
let authMode = 'login'; // 'login' or 'register'

function getSession() {
  const username = localStorage.getItem('fitai_username');
  const token = localStorage.getItem('fitai_token');
  if (username && token) return { username, token };
  return null;
}

function setSession(username, token) {
  localStorage.setItem('fitai_username', username);
  localStorage.setItem('fitai_token', token);
}

function clearSession() {
  localStorage.removeItem('fitai_username');
  localStorage.removeItem('fitai_token');
}

function showAuthError(msg) {
  const el = document.getElementById('auth-error');
  el.innerText = msg;
  el.style.display = 'block';
}

function hideAuthError() {
  document.getElementById('auth-error').style.display = 'none';
}

function initAuthHandlers() {
  const tabLogin = document.getElementById('tab-login');
  const tabRegister = document.getElementById('tab-register');
  const submitBtn = document.getElementById('btn-auth-submit');
  const btnText = document.getElementById('auth-btn-text');

  tabLogin.addEventListener('click', () => {
    authMode = 'login';
    tabLogin.classList.add('active');
    tabRegister.classList.remove('active');
    btnText.innerText = 'Přihlásit se';
    hideAuthError();
  });

  tabRegister.addEventListener('click', () => {
    authMode = 'register';
    tabRegister.classList.add('active');
    tabLogin.classList.remove('active');
    btnText.innerText = 'Zaregistrovat se';
    hideAuthError();
  });

  submitBtn.addEventListener('click', async () => {
    const username = document.getElementById('auth-username').value.trim();
    const password = document.getElementById('auth-password').value;
    const spinner = document.getElementById('auth-spinner');
    const btnTextEl = document.getElementById('auth-btn-text');

    hideAuthError();

    if (!username || !password) {
      showAuthError('Vyplň uživatelské jméno a heslo');
      return;
    }

    submitBtn.disabled = true;
    btnTextEl.innerText = authMode === 'login' ? 'Přihlašuji...' : 'Registruji...';
    spinner.style.display = 'inline-block';

    try {
      // Localhost dev bypass — skip real API
      if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
        setSession(username, 'dev-token');
        showAppAfterLogin();
        showToast(`Vítej, ${username}! 👋`);
        return;
      }

      const endpoint = authMode === 'login' ? '/api/login' : '/api/register';
      const resp = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });

      const data = await resp.json();

      if (!resp.ok) {
        showAuthError(data.error || 'Něco se pokazilo');
        return;
      }

      // Success! Save session
      setSession(data.username, data.token);

      // If login returned cloud data, merge it
      if (data.appData) {
        // Cloud data takes priority — merge logs
        const cloudState = data.appData;
        if (cloudState.goals) appState.goals = cloudState.goals;
        // Never pull apiKey from cloud — it's a build secret (see loadState).
        if (cloudState.logs) {
          // Merge: keep all dates, cloud wins on conflicts
          Object.keys(cloudState.logs).forEach(dateKey => {
            appState.logs[dateKey] = cloudState.logs[dateKey];
          });
        }
        if (cloudState.water) {
          Object.keys(cloudState.water).forEach(dateKey => {
            appState.water[dateKey] = cloudState.water[dateKey];
          });
        }
        if (cloudState.weight !== undefined) appState.weight = cloudState.weight;
        if (cloudState.weightTarget !== undefined) appState.weightTarget = cloudState.weightTarget;
        if (cloudState.weightLogs) appState.weightLogs = cloudState.weightLogs;
        saveState(true);
      }

      // Switch to dashboard
      showAppAfterLogin();
      showToast(`Vítej, ${data.username}! 👋`);

    } catch (err) {
      console.error('Auth error:', err);
      showAuthError('Chyba připojení k serveru');
    } finally {
      submitBtn.disabled = false;
      btnTextEl.innerText = authMode === 'login' ? 'Přihlásit se' : 'Zaregistrovat se';
      spinner.style.display = 'none';
    }
  });

  // Allow Enter key to submit
  document.getElementById('auth-password').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitBtn.click();
  });
}

function isLocalDev() {
  return location.hostname === 'localhost' || location.hostname === '127.0.0.1';
}

async function syncToCloud() {
  const session = getSession();
  if (!session) return;
  if (isLocalDev()) return; // localhost nemá API — jen lokální stav

  try {
    const dataToSync = {
      goals: appState.goals,
      logs: appState.logs,
      water: appState.water,
      weight: appState.weight,
      weightTarget: appState.weightTarget,
      weightLogs: appState.weightLogs,
      favorites: appState.favorites,
      coachChats: appState.coachChats,
      coachMemories: appState.coachMemories,
      coachMemoryEnabled: appState.coachMemoryEnabled
    };

    await fetch('/api/sync', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.token}`
      },
      body: JSON.stringify(dataToSync)
    });
  } catch (err) {
    console.error('Cloud sync error:', err);
  }
}

async function syncFromCloud() {
  const session = getSession();
  if (!session) return;
  if (isLocalDev()) return; // localhost nemá API — jen lokální stav

  try {
    const resp = await fetch('/api/sync', {
      headers: { 'Authorization': `Bearer ${session.token}` }
    });
    const data = await resp.json();

    if (data.success && data.appData) {
      const cloudState = data.appData;
      if (cloudState.goals) appState.goals = cloudState.goals;
      // Never pull apiKey from cloud — it's a build secret (see loadState).
      if (cloudState.logs) {
        Object.keys(cloudState.logs).forEach(dateKey => {
          appState.logs[dateKey] = cloudState.logs[dateKey];
        });
      }
      if (cloudState.water) {
        Object.keys(cloudState.water).forEach(dateKey => {
          appState.water[dateKey] = cloudState.water[dateKey];
        });
      }
      if (cloudState.weight !== undefined) appState.weight = cloudState.weight;
      if (cloudState.weightTarget !== undefined) appState.weightTarget = cloudState.weightTarget;
      if (cloudState.weightLogs) appState.weightLogs = cloudState.weightLogs;
      if (Array.isArray(cloudState.favorites)) appState.favorites = cloudState.favorites;
      if (Array.isArray(cloudState.coachHistory)) appState.coachHistory = cloudState.coachHistory;
      if (Array.isArray(cloudState.coachChats)) appState.coachChats = cloudState.coachChats;
      if (Array.isArray(cloudState.coachMemories)) appState.coachMemories = cloudState.coachMemories;
      if (cloudState.coachMemoryEnabled !== undefined) appState.coachMemoryEnabled = cloudState.coachMemoryEnabled;
      migrateCoachChats();

      saveState(true);
      renderDashboard();
      refreshAllFavorites();
      // If the coach is open, re-point the active chat to the synced copy and
      // refresh the list (the array objects were just replaced).
      const coachModal = document.getElementById('coach-modal');
      if (coachModal && coachModal.classList.contains('active')) {
        if (activeCoachChat) {
          const synced = getCoachChats().find((c) => c.id === activeCoachChat.id);
          if (synced) { activeCoachChat = synced; renderActiveCoachChat(); }
        }
        renderCoachChatList();
      }
      // Refresh the memory settings panel if it's on screen.
      if (typeof renderCoachMemorySettings === 'function') renderCoachMemorySettings();
      showToast('☁️ Data synchronizována z cloudu');
    }
  } catch (err) {
    console.error('Cloud load error:', err);
  }
}

function doLogout() {
  clearSession();
  resetState(); // Vyčistí lokální stav a localStorage, cloud sync se nespustí kvůli clearSession
  // Show login, hide everything else
  document.querySelectorAll('.app-screen').forEach(s => s.classList.remove('active'));
  document.getElementById('screen-login').classList.add('active');
  document.querySelector('.bottom-nav').style.display = 'none';
  document.getElementById('auth-username').value = '';
  document.getElementById('auth-password').value = '';
}

function showAppAfterLogin() {
  const session = getSession();

  // Update username display
  const usernameDisplay = document.getElementById('display-username');
  if (usernameDisplay && session) {
    usernameDisplay.innerText = session.username;
  }

  // Switch screens
  document.querySelectorAll('.app-screen').forEach(s => s.classList.remove('active'));
  document.getElementById('screen-dashboard').classList.add('active');
  document.querySelector('.bottom-nav').style.display = 'flex';

  // Reset nav active state
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  const dashNav = document.querySelector('.nav-item[data-screen="dashboard"]');
  if (dashNav) dashNav.classList.add('active');

  renderDashboard();

  // A workout left running survives a reload — pick it back up.
  if (hasActiveSession()) setTimeout(resumeSessionIfAny, 400);

  // First run: let the coach do the setup conversation instead of a form.
  if (onboardingNeeded()) {
    setTimeout(() => startOnboarding(false), 600);
  }
}

// ==========================================================================
// SCREEN WAKE LOCK — udrží displej rozsvícený, dokud je aplikace otevřená
// ==========================================================================
let wakeLock = null;

async function requestWakeLock() {
  if (!('wakeLock' in navigator)) return; // nepodporováno (starší prohlížeč)
  if (document.visibilityState !== 'visible') return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch (err) {
    // Např. nízká baterie nebo zamítnuto systémem — tiše ignoruj.
    wakeLock = null;
  }
}

function initWakeLock() {
  if (!('wakeLock' in navigator)) return;
  requestWakeLock();
  // Wake lock se uvolní, když se stránka skryje — po návratu ho obnov.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && wakeLock === null) {
      requestWakeLock();
    }
  });
}

// ==========================================================================
// APPLICATION INITIALIZATION
// ==========================================================================
function init() {
  loadState();
  updateDateLabels();
  initFoodLogSheet();
  initNavigation();
  initPhotoHandlers();
  initFormHandlers();
  initAuthHandlers();
  initBarcodeAndSearch();
  initWizard();
  initItemActionsHandlers();
  initLeftoverHandlers();
  initWakeLock();

  // Calendar "go back to today" button
  const backToTodayBtn = document.getElementById('btn-back-to-today');
  if (backToTodayBtn) {
    backToTodayBtn.addEventListener('click', () => {
      selectedDate = null;
      renderDashboard();
    });
  }

  // Logout button
  const logoutBtn = document.getElementById('btn-logout');
  if (logoutBtn) logoutBtn.addEventListener('click', doLogout);

  // Manual sync button
  const syncBtn = document.getElementById('btn-sync-cloud');
  if (syncBtn) syncBtn.addEventListener('click', syncFromCloud);

  // Telegram connect buttons
  const btnTgConnect = document.getElementById('btn-tg-connect');
  if (btnTgConnect) btnTgConnect.addEventListener('click', connectTelegram);
  const btnTgVerify = document.getElementById('btn-tg-verify');
  if (btnTgVerify) btnTgVerify.addEventListener('click', verifyTelegram);
  const btnTgDisconnect = document.getElementById('btn-tg-disconnect');
  if (btnTgDisconnect) btnTgDisconnect.addEventListener('click', disconnectTelegram);

  // Water Intake add button
  const waterAddBtn = document.querySelector('.water-add');
  if (waterAddBtn) {
    waterAddBtn.addEventListener('click', () => {
      const todayStr = getTodayDateString();
      if (!appState.water[todayStr]) {
        appState.water[todayStr] = 0;
      }
      appState.water[todayStr] += 0.25;
      saveState();
      renderDashboard();
      showToast("Voda přidána (+250 ml) 💧");
    });
  }

  // Weight edit button
  const weightEditBtn = document.querySelector('.weight-card .btn-edit-extra');
  const weightModal = document.getElementById('weight-update-modal');
  const btnCloseWeight = document.getElementById('btn-close-weight');
  const inputCurrentWeight = document.getElementById('input-current-weight');
  const btnSaveWeight = document.getElementById('btn-save-weight');

  if (weightEditBtn && weightModal) {
    weightEditBtn.addEventListener('click', () => {
      inputCurrentWeight.value = appState.weight;
      weightModal.classList.add('active');
    });

    const closeWeightModal = () => weightModal.classList.remove('active');
    if (btnCloseWeight) btnCloseWeight.addEventListener('click', closeWeightModal);

    if (btnSaveWeight) btnSaveWeight.addEventListener('click', () => {
      const parsedCurrent = parseFloat(inputCurrentWeight.value);
      if (!isNaN(parsedCurrent) && parsedCurrent > 0) {
        appState.weight = parsedCurrent;

        const todayStr = getTodayDateString();
        appState.weightLogs = appState.weightLogs.filter(log => log.date !== todayStr);
        appState.weightLogs.push({ date: todayStr, weight: parsedCurrent });
        appState.weightLogs.sort((a, b) => b.date.localeCompare(a.date));

        saveState();
        renderDashboard();
        showToast("Váha aktualizována! ⚖️");
        closeWeightModal();
      } else {
        alert("Zadejte platnou váhu.");
      }
    });
  }


  // AI Coach chat
  initCoachHandlers();
  initOnboardingHandlers();
  initPlanHandlers();
  initMealCheckHandlers();
  initShoppingHandlers();
  initExerciseDetailHandlers();
  initMealChatHandlers();
  initMiniAppHandlers();
  initSessionHandlers();

  // Check if already logged in
  const session = getSession();
  if (session) {
    showAppAfterLogin();
    // Background cloud sync
    syncFromCloud();
  } else {
    // Show login screen, hide nav
    document.querySelector('.bottom-nav').style.display = 'none';
  }


  // Start Service Worker registration
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js')
        .then((reg) => console.log('PWA Service Worker úspěšně registrován!', reg.scope))
        .catch((err) => console.error('Registrace Service Workeru selhala:', err));
    });
  }
}

// ==========================================================================
// OPEN FOOD FACTS API INTEGRATION
// ==========================================================================
let currentFormBaseValues = null;

function isLiquidProduct(p) {
  if (!p) return false;
  const name = (p.product_name_cs || p.product_name || "").toLowerCase();
  const quantity = (p.quantity || "").toLowerCase();
  const categories = (p.categories || "").toLowerCase();
  const categoryTags = p.categories_tags || [];
  
  if (quantity.includes('ml') || quantity.includes('cl') || quantity.includes('dl') || quantity.includes(' l') || quantity.endsWith('l')) {
    return true;
  }
  
  if (categoryTags.some(t => t.includes('beverage') || t.includes('drink') || t.includes('napoje') || t.includes('juice') || t.includes('milk'))) {
    return true;
  }
  
  const liquidKeywords = ['ml', 'napoj', 'nápoj', 'džus', 'dzus', 'pivo', 'víno', 'vino', 'voda', 'limonáda', 'limonada', 'cola', 'kefír', 'kefir', 'mléko', 'mleko', 'syrovátka', 'caj', 'čaj', 'sirup', 'smoothie', 'šťáva', 'stava'];
  if (liquidKeywords.some(kw => name.includes(kw) || categories.includes(kw))) {
    const dryKeywords = ['sušené', 'susene', 'prášek', 'prasek', 'zrnková', 'zrnkova', 'mletá', 'mleta', 'koncentrát', 'koncentrat'];
    if (dryKeywords.some(dkw => name.includes(dkw))) {
      return false;
    }
    return true;
  }
  
  return false;
}

// Native prompt() is blocked on iOS PWA standalone mode. Use this instead.
function showAmountDialog(label, defaultValue, onConfirm) {
  const dialog = document.getElementById('amount-edit-dialog');
  const labelEl = document.getElementById('amount-edit-label');
  const input = document.getElementById('amount-edit-input');
  const cancelBtn = document.getElementById('amount-edit-cancel');
  const confirmBtn = document.getElementById('amount-edit-confirm');
  if (!dialog) { onConfirm(defaultValue); return; }

  labelEl.textContent = label;
  input.value = defaultValue || '';
  dialog.style.display = 'flex';
  setTimeout(() => { input.focus(); input.select(); }, 80);

  const close = () => { dialog.style.display = 'none'; cleanup(); };
  const submit = () => {
    const v = input.value.trim();
    close();
    if (v) onConfirm(v);
  };

  const onKey = (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } };
  input.addEventListener('keydown', onKey);
  cancelBtn.onclick = close;
  confirmBtn.onclick = submit;
  dialog.onclick = (e) => { if (e.target === dialog) close(); };

  function cleanup() {
    input.removeEventListener('keydown', onKey);
    cancelBtn.onclick = null;
    confirmBtn.onclick = null;
    dialog.onclick = null;
  }
}

function parseQuantity(quantityStr, defaultUnit = 'g') {
  if (!quantityStr) return { value: 100, unit: defaultUnit };
  
  const cleaned = quantityStr.replace(',', '.').trim();
  const match = cleaned.match(/^([\d.]+)\s*([a-zA-Z]*)/);
  if (!match) return { value: 100, unit: defaultUnit };
  
  let value = parseFloat(match[1]);
  if (isNaN(value)) value = 100;
  let unit = match[2].toLowerCase();
  
  if (!unit) {
    unit = defaultUnit;
  }
  
  // Normalize units to base grams (g) or milliliters (ml)
  if (unit === 'kg') {
    value *= 1000;
    unit = 'g';
  } else if (unit === 'l') {
    value *= 1000;
    unit = 'ml';
  } else if (unit === 'dl' || unit === 'dcl') {
    value *= 100;
    unit = 'ml';
  } else if (unit === 'cl') {
    value *= 10;
    unit = 'ml';
  }
  
  return { value, unit };
}

function getQuantityMultiplier(quantityStr, baseUnit = 'g') {
  const parsed = parseQuantity(quantityStr, baseUnit);
  return parsed.value / 100;
}

function lockManualFormFields(shouldLock) {
  // Pozn.: 'input-food-amount' (množství/hmotnost) ZÁMĚRNĚ NENÍ uzamčeno —
  // jde o krok, kde uživatel zadává snědené množství; změna spustí přepočet
  // kalorií a maker (viz listener na 'input' u #input-food-amount).
  const fields = ['input-food-name', 'input-food-cal', 'input-food-p', 'input-food-c', 'input-food-f'];
  fields.forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.readOnly = shouldLock;
      if (shouldLock) {
        el.classList.add('readonly-field');
      } else {
        el.classList.remove('readonly-field');
      }
    }
  });
}

function resetManualFoodForm() {
  const form = document.getElementById('manual-food-form');
  if (form) {
    form.reset();
  }
  currentFormBaseValues = null;
  lockManualFormFields(false);
  const unlockBtn = document.getElementById('btn-unlock-form');
  if (unlockBtn) {
    unlockBtn.style.display = 'none';
  }
}

async function fetchProductByBarcode(barcode) {
  const url = `/api/barcode?code=${barcode}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Chyba sítě při dotazu do databáze (${response.status})`);
  }
  const data = await response.json();
  if (data.status !== 1 || !data.product) {
    throw new Error("Produkt nebyl v databázi nalezen.");
  }
  
  const p = data.product;
  const name = p.product_name_cs || p.product_name || "Neznámý produkt";
  const brand = p.brands ? ` (${p.brands})` : "";
  
  const isLiquid = isLiquidProduct(p);
  const baseUnit = isLiquid ? 'ml' : 'g';
  const amount = `100${baseUnit}`;
  
  // Nutrients per 100g (or 100ml)
  const calories = Math.round(Number(
    p.nutriments?.['energy-kcal_100g'] || 
    p.nutriments?.['energy-kcal_100ml'] || 
    p.nutriments?.['energy-kcal_value'] || 0
  ));
  const protein = Math.round(Number(p.nutriments?.proteins_100g || p.nutriments?.proteins_100ml || 0) * 10) / 10;
  const carbs = Math.round(Number(p.nutriments?.carbohydrates_100g || p.nutriments?.carbohydrates_100ml || 0) * 10) / 10;
  const fat = Math.round(Number(p.nutriments?.fat_100g || p.nutriments?.fat_100ml || 0) * 10) / 10;
  
  return {
    name: name + brand,
    calories,
    protein,
    carbs,
    fat,
    amount,
    baseUnit
  };
}

async function searchFoodDatabase(query, signal) {
  const url = `/api/search?q=${encodeURIComponent(query)}`;
  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new Error("Chyba vyhledávání v databázi.");
  }
  const data = await response.json();
  if (!data.products || data.products.length === 0) {
    return [];
  }
  
  return data.products.map(p => {
    const name = p.product_name_cs || p.product_name || "Neznámý produkt";
    const brand = p.brands ? ` (${p.brands})` : "";
    
    const isLiquid = isLiquidProduct(p);
    const baseUnit = isLiquid ? 'ml' : 'g';
    const amount = `100${baseUnit}`;
    
    const calories = Math.round(Number(
      p.nutriments?.['energy-kcal_100g'] || 
      p.nutriments?.['energy-kcal_100ml'] || 
      p.nutriments?.['energy-kcal_value'] || 0
    ));
    const protein = Math.round(Number(p.nutriments?.proteins_100g || p.nutriments?.proteins_100ml || 0) * 10) / 10;
    const carbs = Math.round(Number(p.nutriments?.carbohydrates_100g || p.nutriments?.carbohydrates_100ml || 0) * 10) / 10;
    const fat = Math.round(Number(p.nutriments?.fat_100g || p.nutriments?.fat_100ml || 0) * 10) / 10;
    
    return {
      name: name + brand,
      calories,
      protein,
      carbs,
      fat,
      amount,
      baseUnit
    };
  });
}

// ==========================================================================
// BARCODE SCANNER WORKFLOW
// ==========================================================================
let html5QrScanner = null;
// Guard proti opakovanému vyvolání success callbacku. Knihovna html5-qrcode
// volá callback pro KAŽDÝ snímek (cca 10×/s), dokud se kamera fyzicky nezastaví.
// Bez tohoto zámku se barcode zpracoval vícekrát: každé volání znovu načetlo
// produkt a znovu předvyplnilo formulář, čímž přepsalo hmotnost, kterou si
// uživatel právě zadal, zpět na výchozích 100 g (= "krok s hmotností přeskočen").
let barcodeScanHandled = false;

function startBarcodeScanner() {
  const modal = document.getElementById('barcode-scanner-modal');
  if (modal) {
    modal.classList.add('active');
  }

  const errorEl = document.getElementById('barcode-error');
  if (errorEl) errorEl.style.display = 'none';

  const manualInput = document.getElementById('input-manual-barcode');
  if (manualInput) manualInput.value = '';

  // Povolit zpracování prvního naskenovaného kódu v této relaci skeneru
  barcodeScanHandled = false;

  // Clear any existing scanner — clear() vyhodí výjimku, pokud sken stále běží,
  // proto obalíme do try/catch, ať nezablokujeme nový start.
  if (html5QrScanner) {
    try {
      html5QrScanner.clear();
    } catch (err) {
      console.warn("Could not clear previous scanner", err);
    }
  }

  html5QrScanner = new Html5Qrcode("reader");
  
  const config = {
    fps: 10,
    qrbox: function(width, height) {
      // Return a horizontal rectangle optimized for barcodes
      return { width: Math.round(width * 0.7), height: Math.round(height * 0.4) };
    }
  };
  
  html5QrScanner.start(
    { facingMode: "environment" },
    config,
    async (decodedText, decodedResult) => {
      // Barcode detected! Zpracuj POUZE první úspěšný sken — další snímky ignoruj.
      if (barcodeScanHandled) return;
      barcodeScanHandled = true;

      // Počkej, až se kamera skutečně zastaví, než budeme pokračovat
      await stopBarcodeScanner();

      showToast("Kód naskenován: " + decodedText + " 🔍");

      try {
        const product = await fetchProductByBarcode(decodedText);
        prefillManualFoodForm(product, true);
      } catch (err) {
        console.error(err);
        alert(`Produkt se čárovým kódem ${decodedText} nebyl nalezen nebo došlo k chybě připojení.\nMůžeš ho zapsat ručně.`);
        // Při chybě povol opětovné skenování
        barcodeScanHandled = false;
      }
    },
    (errorMessage) => {
      // Quiet fail for scan frame failures
    }
  ).catch(err => {
    console.error("Camera start error", err);
    const errorEl = document.getElementById('barcode-error');
    if (errorEl) {
      errorEl.innerText = "Chyba přístupu ke kameře. Zadej kód ručně.";
      errorEl.style.display = 'block';
    }
  });
}

async function stopBarcodeScanner() {
  const modal = document.getElementById('barcode-scanner-modal');
  if (modal) {
    modal.classList.remove('active');
  }

  if (html5QrScanner) {
    try {
      // Vrácený Promise je nutné awaitnout, jinak kamera dál běží a stále
      // generuje další úspěšné callbacky (zdroj race condition / duplicit).
      await html5QrScanner.stop();
      console.log("Scanner stopped.");
    } catch (err) {
      console.warn("Error stopping scanner", err);
    }
  }
}

function prefillManualFoodForm(product, askAmount = false) {
  // Preserve category
  const categorySelect = document.getElementById('input-food-category');
  const currentCat = categorySelect ? categorySelect.value : 'Breakfast';

  // Switch to Add Screen (step 2)
  if (window.navigateToManualAddFood) {
    window.navigateToManualAddFood(currentCat);
  } else {
    const fab = document.querySelector('.nav-fab');
    if (fab) fab.click();
    showWizardStep(2);
  }
  
  // Set values (s ochranou proti chybějícím elementům, aby případný null
  // nepřerušil předvyplnění uprostřed a nezanechal formulář v půlstavu)
  const setFieldValue = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.value = value;
  };
  setFieldValue('input-food-name', product.name);
  setFieldValue('input-food-cal', product.calories);
  setFieldValue('input-food-amount', product.amount);
  setFieldValue('input-food-p', product.protein);
  setFieldValue('input-food-c', product.carbs);
  setFieldValue('input-food-f', product.fat);

  currentFormBaseValues = {
    calories: product.calories,
    protein: product.protein,
    carbs: product.carbs,
    fat: product.fat,
    baseUnit: product.baseUnit || (String(product.amount).endsWith('ml') ? 'ml' : 'g')
  };
  
  lockManualFormFields(true);
  
  const unlockBtn = document.getElementById('btn-unlock-form');
  if (unlockBtn) {
    unlockBtn.style.display = 'inline-block';
  }

  // KROK S HMOTNOSTÍ: po naskenování/načtení čárového kódu se uživatele výslovně
  // zeptáme na snědené množství a podle něj přepočítáme kalorie i makra. Bez
  // tohoto kroku se jídlo logovalo ve výchozích 100 g (= "krok s hmotností přeskočen").
  if (askAmount) {
    promptForScannedAmount(product.baseUnit || 'g');
  }

  // Pro jistotu zaměříme pole množství, ať je krok vždy na očích.
  const amountEl = document.getElementById('input-food-amount');
  if (amountEl) {
    try { amountEl.focus({ preventScroll: false }); amountEl.select(); } catch (e) {}
  }

  showToast("Zadej snědené množství a ulož. ⚖️");
}

// Zeptá se uživatele na snědené množství a přepočítá pole formuláře podle
// základních hodnot (na 100 g/ml), které drží currentFormBaseValues.
function promptForScannedAmount(baseUnit) {
  if (!currentFormBaseValues) return;
  const unit = baseUnit || currentFormBaseValues.baseUnit || 'g';
  const label = `Kolik ${unit === 'ml' ? 'mililitrů (ml)' : 'gramů (g)'} jsi snědl/a?`;
  showAmountDialog(label, `100${unit}`, (answer) => {
    const trimmed = String(answer).trim();
    if (!trimmed) return;
    const multiplier = getQuantityMultiplier(trimmed, unit);
    if (isNaN(multiplier) || multiplier <= 0) {
      showToast('Neplatné množství – ponechávám 100' + unit);
      return;
    }
    const parsed = parseQuantity(trimmed, unit);
    const setVal = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
    setVal('input-food-amount', `${parsed.value}${parsed.unit}`);
    setVal('input-food-cal', Math.round(currentFormBaseValues.calories * multiplier));
    setVal('input-food-p', Math.round(currentFormBaseValues.protein * multiplier * 10) / 10);
    setVal('input-food-c', Math.round(currentFormBaseValues.carbs * multiplier * 10) / 10);
    setVal('input-food-f', Math.round(currentFormBaseValues.fat * multiplier * 10) / 10);
  });
}

function initBarcodeAndSearch() {
  // Barcode quick action trigger
  const qaBarcode = document.getElementById('qa-barcode');
  if (qaBarcode) {
    qaBarcode.addEventListener('click', () => {
      const now = new Date();
      const hour = now.getHours();
      let categoryId = 'Breakfast';
      if (hour >= 5 && hour < 10) categoryId = 'Breakfast';
      else if (hour >= 10 && hour < 12) categoryId = 'Morning snack';
      else if (hour >= 12 && hour < 15) categoryId = 'Lunch';
      else if (hour >= 15 && hour < 18) categoryId = 'Afternoon snack';
      else if (hour >= 18 && hour < 22) categoryId = 'Dinner';
      else categoryId = 'Second dinner';
      
      setWizardCategory(categoryId);
      startBarcodeScanner();
    });
  }
  
  // Scanner Modal close buttons
  const btnCloseScanner = document.getElementById('btn-close-scanner');
  if (btnCloseScanner) {
    btnCloseScanner.addEventListener('click', stopBarcodeScanner);
  }
  
  // Manual EAN search inside scanner modal
  const btnSearchBarcode = document.getElementById('btn-search-barcode');
  const inputManualBarcode = document.getElementById('input-manual-barcode');
  const errorEl = document.getElementById('barcode-error');
  
  if (btnSearchBarcode && inputManualBarcode) {
    const handleBarcodeSearch = async () => {
      const barcode = inputManualBarcode.value.trim();
      if (!barcode) {
        alert("Zadej čárový kód.");
        return;
      }
      
      console.log('Vyhledávám čárový kód:', barcode);
      if (errorEl) errorEl.style.display = 'none';
      btnSearchBarcode.disabled = true;
      btnSearchBarcode.innerText = "Hledám...";
      
      try {
        const product = await fetchProductByBarcode(barcode);
        console.log('Produkt nalezen:', product);
        await stopBarcodeScanner();
        prefillManualFoodForm(product, true);
      } catch (err) {
        console.error('Chyba vyhledávání čárového kódu:', err);
        alert("Chyba vyhledávání čárového kódu: " + err.message);
        if (errorEl) {
          errorEl.innerText = err.message || "Chyba při vyhledávání.";
          errorEl.style.display = 'block';
        }
      } finally {
        btnSearchBarcode.disabled = false;
        btnSearchBarcode.innerText = "Hledat";
      }
    };
    
    btnSearchBarcode.addEventListener('click', handleBarcodeSearch);
    inputManualBarcode.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleBarcodeSearch();
      }
    });
  }
  
  // Database search inside manual form
  const inputDbSearch = document.getElementById('input-db-search');
  const btnDbSearch = document.getElementById('btn-db-search');
  const dbResultsContainer = document.getElementById('db-search-results');
  
  const LOCAL_COMMON_FOODS = [
    // --- Ovoce ---
    { name: "Jablko (čerstvé)", calories: 52, protein: 0.3, carbs: 14, fat: 0.2, amount: "100g", baseUnit: "g" },
    { name: "Banán (čerstvý)", calories: 89, protein: 1.1, carbs: 23, fat: 0.3, amount: "100g", baseUnit: "g" },
    { name: "Pomeranč (čerstvý)", calories: 47, protein: 0.9, carbs: 12, fat: 0.1, amount: "100g", baseUnit: "g" },
    { name: "Mandarinka (čerstvá)", calories: 53, protein: 0.8, carbs: 13.3, fat: 0.3, amount: "100g", baseUnit: "g" },
    { name: "Jahody (čerstvé)", calories: 32, protein: 0.7, carbs: 7.7, fat: 0.3, amount: "100g", baseUnit: "g" },
    { name: "Borůvky (čerstvé)", calories: 57, protein: 0.7, carbs: 14, fat: 0.3, amount: "100g", baseUnit: "g" },
    { name: "Maliny (čerstvé)", calories: 52, protein: 1.2, carbs: 12, fat: 0.7, amount: "100g", baseUnit: "g" },
    { name: "Hroznové víno", calories: 69, protein: 0.7, carbs: 18, fat: 0.2, amount: "100g", baseUnit: "g" },
    { name: "Broskev (čerstvá)", calories: 39, protein: 0.9, carbs: 10, fat: 0.3, amount: "100g", baseUnit: "g" },
    { name: "Meruňka (čerstvá)", calories: 48, protein: 1.4, carbs: 11, fat: 0.4, amount: "100g", baseUnit: "g" },
    { name: "Švestka (čerstvá)", calories: 46, protein: 0.7, carbs: 11.4, fat: 0.3, amount: "100g", baseUnit: "g" },
    { name: "Citron (čerstvý)", calories: 29, protein: 1.1, carbs: 9, fat: 0.3, amount: "100g", baseUnit: "g" },
    { name: "Avokádo (čerstvé)", calories: 160, protein: 2, carbs: 8.5, fat: 14.7, amount: "100g", baseUnit: "g" },
    { name: "Hruška (čerstvá)", calories: 57, protein: 0.4, carbs: 15, fat: 0.1, amount: "100g", baseUnit: "g" },
    { name: "Kiwi (čerstvé)", calories: 61, protein: 1.1, carbs: 15, fat: 0.5, amount: "100g", baseUnit: "g" },
    { name: "Meloun vodní", calories: 30, protein: 0.6, carbs: 8, fat: 0.2, amount: "100g", baseUnit: "g" },
    { name: "Grapefruit", calories: 42, protein: 0.8, carbs: 11, fat: 0.1, amount: "100g", baseUnit: "g" },
    { name: "Ananas (čerstvý)", calories: 50, protein: 0.5, carbs: 13, fat: 0.1, amount: "100g", baseUnit: "g" },

    // --- Zelenina ---
    { name: "Okurka hadová (čerstvá)", calories: 15, protein: 0.7, carbs: 2.6, fat: 0.1, amount: "100g", baseUnit: "g" },
    { name: "Rajče (čerstvé)", calories: 18, protein: 0.9, carbs: 3.9, fat: 0.2, amount: "100g", baseUnit: "g" },
    { name: "Paprika červená (čerstvá)", calories: 31, protein: 1, carbs: 6, fat: 0.3, amount: "100g", baseUnit: "g" },
    { name: "Paprika zelená (čerstvá)", calories: 20, protein: 0.9, carbs: 4.6, fat: 0.2, amount: "100g", baseUnit: "g" },
    { name: "Paprika žlutá (čerstvá)", calories: 27, protein: 1, carbs: 6.3, fat: 0.2, amount: "100g", baseUnit: "g" },
    { name: "Ledový salát", calories: 14, protein: 0.9, carbs: 3, fat: 0.1, amount: "100g", baseUnit: "g" },
    { name: "Špenát čerstvý", calories: 23, protein: 2.9, carbs: 3.6, fat: 0.4, amount: "100g", baseUnit: "g" },
    { name: "Mrkev (čerstvá)", calories: 41, protein: 0.9, carbs: 9.6, fat: 0.2, amount: "100g", baseUnit: "g" },
    { name: "Brokolice (syrová)", calories: 34, protein: 2.8, carbs: 7, fat: 0.4, amount: "100g", baseUnit: "g" },
    { name: "Květák (syrový)", calories: 25, protein: 1.9, carbs: 5, fat: 0.3, amount: "100g", baseUnit: "g" },
    { name: "Cibule (čerstvá)", calories: 40, protein: 1.1, carbs: 9.3, fat: 0.1, amount: "100g", baseUnit: "g" },
    { name: "Česnek", calories: 149, protein: 6.4, carbs: 33, fat: 0.5, amount: "100g", baseUnit: "g" },
    { name: "Cuketa (čerstvá)", calories: 17, protein: 1.2, carbs: 3.1, fat: 0.3, amount: "100g", baseUnit: "g" },
    { name: "Lilek (čerstvý)", calories: 25, protein: 1, carbs: 6, fat: 0.2, amount: "100g", baseUnit: "g" },
    { name: "Celer řapíkatý", calories: 16, protein: 0.7, carbs: 3, fat: 0.2, amount: "100g", baseUnit: "g" },
    { name: "Celer kořenový", calories: 42, protein: 1.5, carbs: 9, fat: 0.3, amount: "100g", baseUnit: "g" },
    { name: "Hrášek (zelený, čerstvý/mražený)", calories: 81, protein: 5.4, carbs: 14.5, fat: 0.4, amount: "100g", baseUnit: "g" },
    { name: "Kukuřice sladká (konzerva)", calories: 86, protein: 3.2, carbs: 19, fat: 1.2, amount: "100g", baseUnit: "g" },
    { name: "Ředkvičky", calories: 16, protein: 0.7, carbs: 3.4, fat: 0.1, amount: "100g", baseUnit: "g" },
    { name: "Zelí hlávkové bílé", calories: 25, protein: 1.3, carbs: 5.8, fat: 0.1, amount: "100g", baseUnit: "g" },
    { name: "Zelí kysané (bez nálevu)", calories: 19, protein: 0.9, carbs: 4.3, fat: 0.1, amount: "100g", baseUnit: "g" },
    { name: "Žampiony čerstvé", calories: 22, protein: 3.1, carbs: 3.3, fat: 0.3, amount: "100g", baseUnit: "g" },

    // --- Maso a Drůbež ---
    { name: "Kuřecí prsa (syrová)", calories: 120, protein: 22.5, carbs: 0, fat: 2.6, amount: "100g", baseUnit: "g" },
    { name: "Kuřecí prsa (vařená/pečená)", calories: 165, protein: 31, carbs: 0, fat: 3.6, amount: "100g", baseUnit: "g" },
    { name: "Kuřecí stehno bez kůže (pečené)", calories: 184, protein: 24, carbs: 0, fat: 9, amount: "100g", baseUnit: "g" },
    { name: "Kuřecí stehno s kůží (pečené)", calories: 232, protein: 23, carbs: 0, fat: 15, amount: "100g", baseUnit: "g" },
    { name: "Hovězí maso zadní (syrové)", calories: 134, protein: 21, carbs: 0, fat: 5.5, amount: "100g", baseUnit: "g" },
    { name: "Hovězí maso mleté (10% tuku, syrové)", calories: 176, protein: 20, carbs: 0, fat: 10, amount: "100g", baseUnit: "g" },
    { name: "Hovězí maso mleté (20% tuku, syrové)", calories: 254, protein: 17, carbs: 0, fat: 20, amount: "100g", baseUnit: "g" },
    { name: "Hovězí svíčková (syrová)", calories: 143, protein: 21.5, carbs: 0, fat: 6, amount: "100g", baseUnit: "g" },
    { name: "Vepřová panenka (syrová)", calories: 120, protein: 21, carbs: 0, fat: 4, amount: "100g", baseUnit: "g" },
    { name: "Vepřová kýta (syrová)", calories: 125, protein: 21, carbs: 0, fat: 4.5, amount: "100g", baseUnit: "g" },
    { name: "Vepřová krkovice (syrová)", calories: 196, protein: 18.5, carbs: 0, fat: 13.5, amount: "100g", baseUnit: "g" },
    { name: "Krůtí prsa (syrová)", calories: 110, protein: 24, carbs: 0, fat: 1.5, amount: "100g", baseUnit: "g" },
    { name: "Krůtí prsa (pečená)", calories: 135, protein: 30, carbs: 0, fat: 1.8, amount: "100g", baseUnit: "g" },
    { name: "Kachní prsa bez kůže (syrová)", calories: 125, protein: 20, carbs: 0, fat: 5, amount: "100g", baseUnit: "g" },

    // --- Ryby a Mořské plody ---
    { name: "Losos filet (čerstvý, syrový)", calories: 208, protein: 20, carbs: 0, fat: 13, amount: "100g", baseUnit: "g" },
    { name: "Tuňák ve vlastní šťávě (konzerva)", calories: 116, protein: 26, carbs: 0, fat: 1, amount: "100g", baseUnit: "g" },
    { name: "Tuňák v oleji (konzerva)", calories: 198, protein: 24, carbs: 0, fat: 11, amount: "100g", baseUnit: "g" },
    { name: "Treska obecná filet (syrová)", calories: 82, protein: 18, carbs: 0, fat: 0.7, amount: "100g", baseUnit: "g" },
    { name: "Pstruh duhový filet (syrový)", calories: 141, protein: 20, carbs: 0, fat: 6.2, amount: "100g", baseUnit: "g" },
    { name: "Makrela uzená", calories: 262, protein: 20.5, carbs: 0, fat: 20, amount: "100g", baseUnit: "g" },
    { name: "Krevety (vařené)", calories: 99, protein: 24, carbs: 0.2, fat: 0.3, amount: "100g", baseUnit: "g" },

    // --- Šunky a Uzeniny ---
    { name: "Šunka nejvyšší jakosti (vepřová)", calories: 110, protein: 19, carbs: 1, fat: 3, amount: "100g", baseUnit: "g" },
    { name: "Šunka výběrová (vepřová)", calories: 115, protein: 18, carbs: 1, fat: 4.5, amount: "100g", baseUnit: "g" },
    { name: "Šunka nejvyšší jakosti (kuřecí/krůtí)", calories: 98, protein: 19, carbs: 1, fat: 2, amount: "100g", baseUnit: "g" },
    { name: "Párek kuřecí standardní", calories: 230, protein: 11, carbs: 3, fat: 19, amount: "100g", baseUnit: "g" },
    { name: "Vepřový párek výběrový", calories: 280, protein: 13, carbs: 1.5, fat: 25, amount: "100g", baseUnit: "g" },
    { name: "Slanina (anglická slanina)", calories: 320, protein: 16, carbs: 1, fat: 28, amount: "100g", baseUnit: "g" },

    // --- Vejce ---
    { name: "Vejce (slepičí, vařené)", calories: 155, protein: 13, carbs: 1.1, fat: 11, amount: "100g", baseUnit: "g" },
    { name: "Vejce (slepičí, 1 kus ~ 50g)", calories: 78, protein: 6.5, carbs: 0.6, fat: 5.5, amount: "50g", baseUnit: "g" },
    { name: "Vaječný bílek (100g)", calories: 52, protein: 11, carbs: 0.7, fat: 0.2, amount: "100g", baseUnit: "g" },
    { name: "Vaječný bílek (1 kus ~ 33g)", calories: 17, protein: 3.6, carbs: 0.2, fat: 0.1, amount: "33g", baseUnit: "g" },
    { name: "Vaječný žloutek (100g)", calories: 322, protein: 16, carbs: 3.6, fat: 27, amount: "100g", baseUnit: "g" },

    // --- Mléčné výrobky ---
    { name: "Máslo (82% tuku)", calories: 717, protein: 0.8, carbs: 0.1, fat: 81, amount: "100g", baseUnit: "g" },
    { name: "Polotučné mléko (1.5% tuku)", calories: 47, protein: 3.3, carbs: 4.8, fat: 1.5, amount: "100ml", baseUnit: "ml" },
    { name: "Plnotučné mléko (3.5% tuku)", calories: 64, protein: 3.2, carbs: 4.7, fat: 3.5, amount: "100ml", baseUnit: "ml" },
    { name: "Odtučněné mléko (0.5% tuku)", calories: 35, protein: 3.4, carbs: 4.9, fat: 0.5, amount: "100ml", baseUnit: "ml" },
    { name: "Smetana na šlehání (31% tuku)", calories: 292, protein: 2.2, carbs: 3.2, fat: 31, amount: "100ml", baseUnit: "ml" },
    { name: "Smetana na vaření (12% tuku)", calories: 136, protein: 2.8, carbs: 4, fat: 12, amount: "100ml", baseUnit: "ml" },
    { name: "Tvaroh polotučný (ve vaničce)", calories: 104, protein: 11, carbs: 4, fat: 3.5, amount: "100g", baseUnit: "g" },
    { name: "Tvaroh odtučněný (ve vaničce)", calories: 68, protein: 12, carbs: 4, fat: 0.1, amount: "100g", baseUnit: "g" },
    { name: "Tvaroh tučný (ve vaničce)", calories: 141, protein: 9.5, carbs: 3.5, fat: 9, amount: "100g", baseUnit: "g" },
    { name: "Tvaroh měkký odtučněný (v alobalu)", calories: 68, protein: 12, carbs: 4, fat: 0.1, amount: "100g", baseUnit: "g" },
    { name: "Bílý jogurt Klasik (2.7% tuku)", calories: 62, protein: 4.2, carbs: 5.2, fat: 2.7, amount: "100g", baseUnit: "g" },
    { name: "Řecký jogurt 0% tuku", calories: 57, protein: 10, carbs: 3.6, fat: 0, amount: "100g", baseUnit: "g" },
    { name: "Řecký jogurt 5% tuku", calories: 95, protein: 9, carbs: 3.5, fat: 5, amount: "100g", baseUnit: "g" },
    { name: "Skyr bílý neochucený", calories: 60, protein: 11, carbs: 3.5, fat: 0.2, amount: "100g", baseUnit: "g" },
    { name: "Cottage sýr (bílý, ve smetaně)", calories: 98, protein: 11, carbs: 3, fat: 4.5, amount: "100g", baseUnit: "g" },
    { name: "Kefírové mléko nízkotučné", calories: 38, protein: 3.2, carbs: 4.4, fat: 0.8, amount: "100ml", baseUnit: "ml" },
    { name: "Kysaná smetana (15% tuku)", calories: 158, protein: 2.6, carbs: 3.8, fat: 15, amount: "100g", baseUnit: "g" },

    // --- Sýry ---
    { name: "Eidamský sýr 30% t.v.s.", calories: 270, protein: 30, carbs: 1.5, fat: 15, amount: "100g", baseUnit: "g" },
    { name: "Eidamský sýr 45% t.v.s.", calories: 340, protein: 26, carbs: 1.5, fat: 25, amount: "100g", baseUnit: "g" },
    { name: "Sýr Gouda 48% t.v.s.", calories: 356, protein: 23, carbs: 0, fat: 29, amount: "100g", baseUnit: "g" },
    { name: "Mozzarella (125g standard)", calories: 247, protein: 18, carbs: 1, fat: 19, amount: "125g", baseUnit: "g" },
    { name: "Mozzarella light (125g)", calories: 165, protein: 20, carbs: 1, fat: 9, amount: "125g", baseUnit: "g" },
    { name: "Hermelín standard (100g)", calories: 320, protein: 19, carbs: 1, fat: 27, amount: "100g", baseUnit: "g" },
    { name: "Olomoucké tvarůžky", calories: 127, protein: 28, carbs: 1, fat: 0.5, amount: "100g", baseUnit: "g" },
    { name: "Lučina (čerstvý sýr)", calories: 280, protein: 6, carbs: 2.5, fat: 27, amount: "100g", baseUnit: "g" },
    { name: "Žervé Klasik", calories: 230, protein: 8, carbs: 3, fat: 20, amount: "100g", baseUnit: "g" },
    { name: "Parmazán (Grana Padano)", calories: 398, protein: 33, carbs: 0, fat: 29, amount: "100g", baseUnit: "g" },

    // --- Přílohy, Obiloviny a Pečivo ---
    { name: "Rýže basmati (vařená)", calories: 130, protein: 2.7, carbs: 28, fat: 0.3, amount: "100g", baseUnit: "g" },
    { name: "Rýže basmati (suchý stav)", calories: 350, protein: 7.5, carbs: 77, fat: 1, amount: "100g", baseUnit: "g" },
    { name: "Rýže jasmínová (vařená)", calories: 128, protein: 2.5, carbs: 28, fat: 0.2, amount: "100g", baseUnit: "g" },
    { name: "Brambory (vařené bez slupky)", calories: 87, protein: 1.9, carbs: 20, fat: 0.1, amount: "100g", baseUnit: "g" },
    { name: "Brambory (pečené s olejem)", calories: 140, protein: 2.2, carbs: 21, fat: 5, amount: "100g", baseUnit: "g" },
    { name: "Batáty (sladké brambory, vařené)", calories: 86, protein: 1.6, carbs: 20, fat: 0.1, amount: "100g", baseUnit: "g" },
    { name: "Těstoviny pšeničné standard (suchý stav)", calories: 360, protein: 12.5, carbs: 72, fat: 1.5, amount: "100g", baseUnit: "g" },
    { name: "Těstoviny pšeničné standard (vařené)", calories: 158, protein: 5.8, carbs: 31, fat: 0.9, amount: "100g", baseUnit: "g" },
    { name: "Těstoviny celozrnné (suchý stav)", calories: 345, protein: 13, carbs: 67, fat: 2.2, amount: "100g", baseUnit: "g" },
    { name: "Ovesné vločky jemné", calories: 372, protein: 13, carbs: 59, fat: 7, amount: "100g", baseUnit: "g" },
    { name: "Rohlík bílý standardní (1 ks ~ 43g)", calories: 135, protein: 4, carbs: 25.5, fat: 1.5, amount: "43g", baseUnit: "g" },
    { name: "Rohlík celozrnný (1 ks ~ 50g)", calories: 145, protein: 5.2, carbs: 26, fat: 1.8, amount: "50g", baseUnit: "g" },
    { name: "Chléb Šumava pšenično-žitný", calories: 247, protein: 7.2, carbs: 50, fat: 1.2, amount: "100g", baseUnit: "g" },
    { name: "Chléb celozrnný tmavý žitný", calories: 218, protein: 6.5, carbs: 41, fat: 1.5, amount: "100g", baseUnit: "g" },
    { name: "Toustový chléb světlý", calories: 260, protein: 8, carbs: 50, fat: 2.5, amount: "100g", baseUnit: "g" },
    { name: "Toustový chléb máslový", calories: 275, protein: 8, carbs: 49, fat: 4.8, amount: "100g", baseUnit: "g" },
    { name: "Kuskus (suchý stav)", calories: 356, protein: 12.8, carbs: 72, fat: 1.1, amount: "100g", baseUnit: "g" },
    { name: "Kuskus (vařený)", calories: 112, protein: 3.8, carbs: 23, fat: 0.2, amount: "100g", baseUnit: "g" },
    { name: "Bulgur (suchý stav)", calories: 342, protein: 12, carbs: 63, fat: 1.3, amount: "100g", baseUnit: "g" },
    { name: "Quinoa (suchý stav)", calories: 368, protein: 14, carbs: 64, fat: 6, amount: "100g", baseUnit: "g" },
    { name: "Pohanka loupaná (suchý stav)", calories: 343, protein: 12, carbs: 70, fat: 3.4, amount: "100g", baseUnit: "g" },
    { name: "Rýžové chlebíčky racio natural", calories: 380, protein: 8, carbs: 80, fat: 3, amount: "100g", baseUnit: "g" },
    { name: "Knäckebrot žitný", calories: 330, protein: 10, carbs: 62, fat: 1.5, amount: "100g", baseUnit: "g" },

    // --- Luštěniny ---
    { name: "Čočka hnědá (suchý stav)", calories: 343, protein: 24, carbs: 54, fat: 1.5, amount: "100g", baseUnit: "g" },
    { name: "Čočka červená loupaná (suchý stav)", calories: 350, protein: 25, carbs: 53, fat: 1.2, amount: "100g", baseUnit: "g" },
    { name: "Cizrna (suchý stav)", calories: 364, protein: 19, carbs: 57, fat: 6, amount: "100g", baseUnit: "g" },
    { name: "Fazole bílé (konzerva)", calories: 95, protein: 6, carbs: 15, fat: 0.5, amount: "100g", baseUnit: "g" },

    // --- Ořechy, Semínka a Oleje ---
    { name: "Mandle (přírodní)", calories: 579, protein: 21, carbs: 22, fat: 49, amount: "100g", baseUnit: "g" },
    { name: "Vlašské ořechy", calories: 654, protein: 15, carbs: 14, fat: 65, amount: "100g", baseUnit: "g" },
    { name: "Kešu ořechy (nepražené)", calories: 553, protein: 18, carbs: 30, fat: 44, amount: "100g", baseUnit: "g" },
    { name: "Arašídy (pražené, nesolené)", calories: 567, protein: 25.8, carbs: 16, fat: 49, amount: "100g", baseUnit: "g" },
    { name: "Chia semínka", calories: 486, protein: 16.5, carbs: 30.7, fat: 30.7, amount: "100g", baseUnit: "g" },
    { name: "Lněná semínka", calories: 534, protein: 18.3, carbs: 29, fat: 42, amount: "100g", baseUnit: "g" },
    { name: "Slunečnicová semínka loupaná", calories: 584, protein: 20.8, carbs: 20, fat: 51, amount: "100g", baseUnit: "g" },
    { name: "Dýňová semínka loupaná", calories: 559, protein: 30, carbs: 10.7, fat: 49, amount: "100g", baseUnit: "g" },
    { name: "Arašídové máslo (100% arašídy)", calories: 588, protein: 25, carbs: 13, fat: 50, amount: "100g", baseUnit: "g" },
    { name: "Olivový olej extra panenský", calories: 884, protein: 0, carbs: 0, fat: 100, amount: "100g", baseUnit: "g" },
    { name: "Olej řepkový", calories: 884, protein: 0, carbs: 0, fat: 100, amount: "100g", baseUnit: "g" },
    { name: "Olej slunečnicový", calories: 884, protein: 0, carbs: 0, fat: 100, amount: "100g", baseUnit: "g" },
    { name: "Kokosový olej", calories: 862, protein: 0, carbs: 0, fat: 100, amount: "100g", baseUnit: "g" },
    { name: "Vepřové sádlo", calories: 900, protein: 0, carbs: 0, fat: 100, amount: "100g", baseUnit: "g" },

    // --- Sladidla, Dochucovadla a Ostatní ---
    { name: "Med včelí", calories: 304, protein: 0.3, carbs: 82, fat: 0, amount: "100g", baseUnit: "g" },
    { name: "Med včelí (1 čajová lžička ~ 9g)", calories: 27, protein: 0, carbs: 7.4, fat: 0, amount: "9g", baseUnit: "g" },
    { name: "Cukr bílý krupice", calories: 400, protein: 0, carbs: 100, fat: 0, amount: "100g", baseUnit: "g" },
    { name: "Džem ovocný jahoda", calories: 250, protein: 0.5, carbs: 60, fat: 0.1, amount: "100g", baseUnit: "g" },
    { name: "Javorový sirup", calories: 260, protein: 0, carbs: 67, fat: 0.1, amount: "100g", baseUnit: "g" },
    { name: "Whey Protein 80% (syrovátkový protein)", calories: 390, protein: 80, carbs: 6, fat: 5, amount: "100g", baseUnit: "g" },
    { name: "Kečup sladký", calories: 102, protein: 1.5, carbs: 23, fat: 0.1, amount: "100g", baseUnit: "g" },
    { name: "Hořčice plnotučná", calories: 95, protein: 4.6, carbs: 6, fat: 5.5, amount: "100g", baseUnit: "g" },
    { name: "Majonéza standard (70% tuku)", calories: 680, protein: 1, carbs: 3, fat: 74, amount: "100g", baseUnit: "g" },
    { name: "Tatarská omáčka", calories: 460, protein: 1, carbs: 5, fat: 49, amount: "100g", baseUnit: "g" },
    { name: "Sójová omáčka", calories: 60, protein: 9, carbs: 6, fat: 0.1, amount: "100g", baseUnit: "g" },
    { name: "Droždí sušené", calories: 325, protein: 40, carbs: 35, fat: 5, amount: "100g", baseUnit: "g" },

    // --- Nápoje ---
    { name: "Voda kohoutková/balená", calories: 0, protein: 0, carbs: 0, fat: 0, amount: "100ml", baseUnit: "ml" },
    { name: "Káva černá (bez mléka a cukru)", calories: 2, protein: 0.1, carbs: 0, fat: 0, amount: "100ml", baseUnit: "ml" },
    { name: "Čaj ovocný / zelený / černý (neslazený)", calories: 1, protein: 0, carbs: 0.2, fat: 0, amount: "100ml", baseUnit: "ml" },
    { name: "Coca-Cola / Pepsi standard", calories: 42, protein: 0, carbs: 10.6, fat: 0, amount: "100ml", baseUnit: "ml" },
    { name: "Coca-Cola Zero / Pepsi Max", calories: 0.3, protein: 0, carbs: 0, fat: 0, amount: "100ml", baseUnit: "ml" },
    { name: "Pivo světlé výčepní (10°)", calories: 37, protein: 0.3, carbs: 3.1, fat: 0, amount: "100ml", baseUnit: "ml" },
    { name: "Pivo světlý ležák (12°)", calories: 44, protein: 0.4, carbs: 3.8, fat: 0, amount: "100ml", baseUnit: "ml" },
    { name: "Birell nealkoholické pivo světlé", calories: 21, protein: 0.2, carbs: 4.7, fat: 0, amount: "100ml", baseUnit: "ml" },
    { name: "Víno bílé suché", calories: 73, protein: 0.1, carbs: 2, fat: 0, amount: "100ml", baseUnit: "ml" },
    { name: "Víno červené suché", calories: 79, protein: 0.1, carbs: 2.6, fat: 0, amount: "100ml", baseUnit: "ml" }
  ];

  if (btnDbSearch && inputDbSearch && dbResultsContainer) {
    let activeSearchController = null;
    let currentLocalMatches = [];

    const debounce = (func, wait) => {
      let timeout;
      return (...args) => {
        clearTimeout(timeout);
        timeout = setTimeout(() => func(...args), wait);
      };
    };

    const removeDiacritics = (str) => {
      return str.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
    };

    const addFoodItemDirectly = (product) => {
      const categorySelect = document.getElementById('input-food-category');
      const categoryStr = categorySelect ? categorySelect.value : 'Breakfast';
      
      const todayStr = getActiveDateString();
      if (!appState.logs[todayStr]) {
        appState.logs[todayStr] = [];
      }

      const now = new Date();
      const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

      appState.logs[todayStr].push({
        id: Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
        time: timeStr,
        name: product.name,
        amount: product.amount || '100g',
        calories: Math.round(Number(product.calories || 0)),
        protein: Math.round(Number(product.protein || 0) * 10) / 10,
        carbs: Math.round(Number(product.carbs || 0) * 10) / 10,
        fat: Math.round(Number(product.fat || 0) * 10) / 10,
        category: categoryStr
      });
      
      saveState();
      showToast(`Přidáno: ${product.name} (${product.amount || '100g'}) ➕`);
    };

    const renderSearchResults = (localItems, apiItems, showApiError = false) => {
      dbResultsContainer.innerHTML = '';
      
      if (localItems.length === 0 && apiItems.length === 0) {
        if (showApiError) {
          dbResultsContainer.innerHTML = `<div style="padding:16px; text-align:center; color:var(--color-danger); font-size:14px;">Chyba při komunikaci s online databází.</div>`;
        } else {
          dbResultsContainer.innerHTML = `<div style="padding:16px; text-align:center; color:var(--text-secondary); font-size:14px;">Nebyly nalezeny žádné potraviny.</div>`;
        }
        return;
      }
      
      // Render local items
      if (localItems.length > 0) {
        localItems.forEach(p => {
          const item = document.createElement('div');
          item.className = 'search-result-item';
          item.style.borderLeft = '3px solid var(--color-primary)';
          item.innerHTML = `
            <div class="search-result-info">
              <span class="search-result-title" style="font-weight:700;">⭐ ${p.name}</span>
              <span class="search-result-details">${p.calories} kcal • B:${p.protein}g S:${p.carbs}g T:${p.fat}g (na ${p.amount || '100g'})</span>
            </div>
            <button type="button" class="btn-quick-add-food" title="Rychlé přidání">+</button>
          `;
          item.addEventListener('click', () => {
            prefillManualFoodForm(p);
            dbResultsContainer.style.display = 'none';
            inputDbSearch.value = '';
          });
          const quickAddBtn = item.querySelector('.btn-quick-add-food');
          if (quickAddBtn) {
            quickAddBtn.addEventListener('click', (e) => {
              e.stopPropagation();
              addFoodItemDirectly(p);
            });
          }
          dbResultsContainer.appendChild(item);
        });
      }
      
      // Render API items
      if (apiItems.length > 0) {
        const localNames = new Set(localItems.map(l => removeDiacritics(l.name)));
        const uniqueApi = apiItems.filter(a => !localNames.has(removeDiacritics(a.name)));
        
        if (uniqueApi.length > 0) {
          if (localItems.length > 0) {
            const divider = document.createElement('div');
            divider.style.padding = '8px 16px 4px';
            divider.style.fontSize = '11px';
            divider.style.fontWeight = '700';
            divider.style.color = 'var(--text-muted)';
            divider.style.textTransform = 'uppercase';
            divider.style.letterSpacing = '0.5px';
            divider.innerText = "Další výsledky z databáze";
            dbResultsContainer.appendChild(divider);
          }
          
          uniqueApi.forEach(p => {
            const item = document.createElement('div');
            item.className = 'search-result-item';
            item.innerHTML = `
              <div class="search-result-info">
                <span class="search-result-title">${p.name}</span>
                <span class="search-result-details">${p.calories} kcal • B:${p.protein}g S:${p.carbs}g T:${p.fat}g (na ${p.amount || '100g'})</span>
              </div>
              <button type="button" class="btn-quick-add-food" title="Rychlé přidání">+</button>
            `;
            item.addEventListener('click', () => {
              prefillManualFoodForm(p);
              dbResultsContainer.style.display = 'none';
              inputDbSearch.value = '';
            });
            const quickAddBtn = item.querySelector('.btn-quick-add-food');
            if (quickAddBtn) {
              quickAddBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                addFoodItemDirectly(p);
              });
            }
            dbResultsContainer.appendChild(item);
          });
        }
      }
    };

    const performSearch = async (query, forceImmediate = false) => {
      const trimmed = query.trim();
      if (!trimmed) {
        dbResultsContainer.style.display = 'none';
        dbResultsContainer.innerHTML = '';
        currentLocalMatches = [];
        return;
      }
      
      const normQuery = removeDiacritics(trimmed);
      currentLocalMatches = LOCAL_COMMON_FOODS.filter(item => 
        removeDiacritics(item.name).includes(normQuery)
      );
      
      // Instantly show local results
      renderSearchResults(currentLocalMatches, []);
      dbResultsContainer.style.display = 'block';
      
      if (trimmed.length < 2) {
        return;
      }
      
      // Abort active fetch if any
      if (activeSearchController) {
        activeSearchController.abort();
      }
      activeSearchController = new AbortController();
      const { signal } = activeSearchController;
      
      if (!forceImmediate) {
        btnDbSearch.innerText = "Hledám...";
      } else {
        btnDbSearch.disabled = true;
        btnDbSearch.innerText = "Hledám...";
      }
      
      try {
        const products = await searchFoodDatabase(trimmed, signal);
        renderSearchResults(currentLocalMatches, products, false);
      } catch (err) {
        if (err.name === 'AbortError') return;
        console.error('API Error:', err);
        // Only show error if we have ZERO local matches
        renderSearchResults(currentLocalMatches, [], currentLocalMatches.length === 0);
      } finally {
        btnDbSearch.disabled = false;
        btnDbSearch.innerText = "Hledat";
      }
    };

    const debouncedSearch = debounce((q) => performSearch(q, false), 300);

    inputDbSearch.addEventListener('input', (e) => {
      const q = e.target.value;
      debouncedSearch(q);
    });

    const showFavorites = () => {
      const q = inputDbSearch.value.trim();
      if (q) return;

      dbResultsContainer.innerHTML = '';
      const favorites = appState.favorites || [];
      if (favorites.length === 0) {
        dbResultsContainer.innerHTML = `<div style="padding:16px; text-align:center; color:var(--text-3); font-size:13px;">Zatím nemáš žádné oblíbené potraviny. Přidej je pomocí "•••" u jídla na přehledu.</div>`;
      } else {
        favorites.forEach(p => {
          const item = document.createElement('div');
          item.className = 'search-result-item';
          item.style.borderLeft = '3px solid var(--ios-orange)';
          item.innerHTML = `
            <div class="search-result-info">
              <span class="search-result-title" style="font-weight:700;">⭐ ${p.name}</span>
              <span class="search-result-details">${p.calories} kcal • B:${p.protein}g S:${p.carbs}g T:${p.fat}g (na ${p.amount || '100g'})</span>
            </div>
            <button type="button" class="btn-quick-add-food" title="Rychlé přidání">+</button>
          `;
          item.addEventListener('click', () => {
            prefillManualFoodForm(p);
            dbResultsContainer.style.display = 'none';
            inputDbSearch.value = '';
          });
          const quickAddBtn = item.querySelector('.btn-quick-add-food');
          if (quickAddBtn) {
            quickAddBtn.addEventListener('click', (e) => {
              e.stopPropagation();
              addFoodItemDirectly(p);
            });
          }
          dbResultsContainer.appendChild(item);
        });
      }
      dbResultsContainer.style.display = 'block';
    };

    inputDbSearch.addEventListener('focus', showFavorites);
    inputDbSearch.addEventListener('click', showFavorites);

    const handleImmediateSearch = () => {
      const q = inputDbSearch.value;
      performSearch(q, true);
    };

    btnDbSearch.addEventListener('click', handleImmediateSearch);
    inputDbSearch.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleImmediateSearch();
      }
    });
    
    // Hide results when clicking outside
    document.addEventListener('click', (e) => {
      if (!e.target.closest('#input-db-search') && !e.target.closest('#btn-db-search') && !e.target.closest('#db-search-results')) {
        dbResultsContainer.style.display = 'none';
      }
    });
  }
}

function initWizard() {
  // Category Wizard Buttons
  const categoryWizardBtns = document.querySelectorAll('.category-wizard-btn');
  categoryWizardBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const categoryId = btn.getAttribute('data-category');
      setWizardCategory(categoryId);
      showWizardStep(2);
    });
  });

  // Wizard Back Button
  const btnWizardBack = document.getElementById('btn-wizard-back');
  if (btnWizardBack) {
    btnWizardBack.addEventListener('click', () => {
      showWizardStep(1);
    });
  }

  // Wizard Barcode Scanner Button
  const btnWizardScanBarcode = document.getElementById('btn-wizard-scan-barcode');
  if (btnWizardScanBarcode) {
    btnWizardScanBarcode.addEventListener('click', () => {
      startBarcodeScanner();
    });
  }
}

// ==========================================================================
// FOOD ACTIONS & COLLAPSE HELPERS
// ==========================================================================

function toggleCategoryCollapse(categoryId) {
  if (!appState.collapsedCats) {
    appState.collapsedCats = {};
  }
  appState.collapsedCats[categoryId] = !appState.collapsedCats[categoryId];
  saveState();
  renderDashboard();
}

function openItemActionsSheet(item) {
  window.activeActionItem = item;
  
  const titleEl = document.getElementById('action-sheet-title');
  if (titleEl) {
    titleEl.innerText = `${item.name} (${item.amount || '100g'})`;
  }
  
  const sheet = document.getElementById('item-actions-sheet');
  if (sheet) {
    sheet.classList.add('active');
  }
}

function closeItemActionsSheet() {
  const sheet = document.getElementById('item-actions-sheet');
  if (sheet) {
    sheet.classList.remove('active');
  }
  window.activeActionItem = null;
}

function updateCombineFloatingBar() {
  const bar = document.getElementById('combine-floating-bar');
  const countSpan = document.getElementById('combine-count');
  if (bar && countSpan) {
    const count = window.combineSelectedIds ? window.combineSelectedIds.size : 0;
    countSpan.innerText = count;
    if (window.combineModeActive) {
      bar.style.display = 'flex';
    } else {
      bar.style.display = 'none';
    }
  }
}

function initItemActionsHandlers() {
  const sheet = document.getElementById('item-actions-sheet');
  const btnActCombine = document.getElementById('btn-act-combine');
  const btnActCopy = document.getElementById('btn-act-copy');
  const btnActMove = document.getElementById('btn-act-move');
  const btnActFavorite = document.getElementById('btn-act-favorite');
  const btnActDelete = document.getElementById('btn-act-delete');
  const btnActCancel = document.getElementById('btn-act-cancel');
  
  const copyMoveModal = document.getElementById('copy-move-modal');
  const btnCloseCopyMove = document.getElementById('btn-close-copy-move');
  const btnSaveCopyMove = document.getElementById('btn-save-copy-move');
  const copyMoveDate = document.getElementById('copy-move-date');
  const copyMoveCategory = document.getElementById('copy-move-category');
  
  const btnCombineCancel = document.getElementById('btn-combine-cancel');
  const btnCombineSubmit = document.getElementById('btn-combine-submit');

  // Event delegation for all food list interactions
  const foodListContainer = document.getElementById('meals-list-container');
  if (foodListContainer) {
    foodListContainer.addEventListener('click', (e) => {
      // 1. Actions button click (circle / chevron)
      const actionBtn = e.target.closest('.btn-item-actions');
      if (actionBtn) {
        e.stopPropagation();
        const foodId = actionBtn.getAttribute('data-id');
        const todayStr = getActiveDateString();
        const logs = appState.logs[todayStr] || [];
        const item = logs.find(i => i.id === foodId);
        if (item) {
          openItemActionsSheet(item);
        }
        return;
      }
      
      // 2. Combine checkmark click or item click in combine mode
      if (window.combineModeActive) {
        const subItem = e.target.closest('.meal-sub-item');
        if (subItem) {
          const checkbox = subItem.querySelector('.combine-checkbox');
          if (checkbox) {
            const foodId = checkbox.getAttribute('data-id');
            const isSel = checkbox.classList.toggle('checked');
            if (isSel) {
              window.combineSelectedIds.add(foodId);
            } else {
              window.combineSelectedIds.delete(foodId);
            }
            updateCombineFloatingBar();
          }
        }
        return;
      }
      
      // 3. Edit amount click (meal sub details)
      const subDetails = e.target.closest('.meal-sub-details');
      if (subDetails) {
        const foodId = subDetails.getAttribute('data-id');
        const todayStr = getActiveDateString();
        const logs = appState.logs[todayStr] || [];
        const item = logs.find(i => i.id === foodId);
        if (!item) return;
        
        showAmountDialog(`Upravit množství: ${item.name}`, item.amount || '100g', (newAmountStr) => {
          const oldParsed = parseQuantity(item.amount || '100g');
          const newParsed = parseQuantity(newAmountStr, oldParsed.unit);
          if (oldParsed.value > 0 && newParsed.value >= 0) {
            const ratio = newParsed.value / oldParsed.value;
            item.amount = newAmountStr.trim();
            if (item.original && item.leftovers && item.leftovers.length) {
              const scale = (m) => {
                m.calories = Math.round(m.calories * ratio);
                m.protein = Math.round(m.protein * ratio * 10) / 10;
                m.carbs = Math.round(m.carbs * ratio * 10) / 10;
                m.fat = Math.round(m.fat * ratio * 10) / 10;
              };
              scale(item.original);
              item.leftovers.forEach(scale);
              recomputeItemNet(item);
            } else {
              item.calories = Math.round(item.calories * ratio);
              item.protein = Math.round(item.protein * ratio * 10) / 10;
              item.carbs = Math.round(item.carbs * ratio * 10) / 10;
              item.fat = Math.round(item.fat * ratio * 10) / 10;
            }
            saveState();
            renderDashboard();
            showToast('Množství upraveno ✏️');
          } else {
            showToast('Neplatné množství');
          }
        });
        return;
      }
    });
  }

  // Cancel action sheet
  if (btnActCancel) {
    btnActCancel.addEventListener('click', closeItemActionsSheet);
  }
  
  // Close action sheet when clicking on overlay background
  if (sheet) {
    sheet.addEventListener('click', (e) => {
      if (e.target === sheet) {
        closeItemActionsSheet();
      }
    });
  }

  // Delete item from action sheet
  if (btnActDelete) {
    btnActDelete.addEventListener('click', () => {
      if (window.activeActionItem) {
        deleteFoodItem(window.activeActionItem.id);
        closeItemActionsSheet();
      }
    });
  }

  // Favorite item from action sheet
  if (btnActFavorite) {
    btnActFavorite.addEventListener('click', () => {
      const item = window.activeActionItem;
      if (!item) return;
      
      if (!appState.favorites) {
        appState.favorites = [];
      }
      
      const exists = appState.favorites.some(f => f.name.toLowerCase() === item.name.toLowerCase());
      if (exists) {
        showToast(`"${item.name}" již je v oblíbených! ⭐`);
        closeItemActionsSheet();
        return;
      }
      
      appState.favorites.push({
        name: item.name,
        calories: item.calories,
        protein: item.protein,
        carbs: item.carbs,
        fat: item.fat,
        amount: item.amount || '100g'
      });
      
      saveState();
      showToast(`Přidáno do oblíbených! ⭐`);
      closeItemActionsSheet();
    });
  }

  // Copy item from action sheet
  if (btnActCopy) {
    btnActCopy.addEventListener('click', () => {
      const item = window.activeActionItem;
      if (!item) return;
      window.copyMoveActionType = 'copy';
      window.copyMoveItem = item; // preserve before the sheet clears activeActionItem
      closeItemActionsSheet();

      // Open copy/move modal
      if (copyMoveModal) {
        const titleEl = document.getElementById('copy-move-modal-title');
        if (titleEl) titleEl.innerText = 'Zkopírovat jídlo';

        // Prefill date/category
        if (copyMoveDate) copyMoveDate.value = getActiveDateString();
        if (copyMoveCategory) copyMoveCategory.value = getFoodCategory(item) || 'Breakfast';

        copyMoveModal.classList.add('active');
      }
    });
  }

  // Move item from action sheet
  if (btnActMove) {
    btnActMove.addEventListener('click', () => {
      const item = window.activeActionItem;
      if (!item) return;
      window.copyMoveActionType = 'move';
      window.copyMoveItem = item; // preserve before the sheet clears activeActionItem
      closeItemActionsSheet();

      // Open copy/move modal
      if (copyMoveModal) {
        const titleEl = document.getElementById('copy-move-modal-title');
        if (titleEl) titleEl.innerText = 'Přemístit na jiný den';

        // Prefill date/category
        if (copyMoveDate) copyMoveDate.value = getActiveDateString();
        if (copyMoveCategory) copyMoveCategory.value = getFoodCategory(item) || 'Breakfast';

        copyMoveModal.classList.add('active');
      }
    });
  }

  // Close copy/move modal
  if (btnCloseCopyMove) {
    btnCloseCopyMove.addEventListener('click', () => {
      if (copyMoveModal) copyMoveModal.classList.remove('active');
    });
  }
  
  if (copyMoveModal) {
    copyMoveModal.addEventListener('click', (e) => {
      if (e.target === copyMoveModal) {
        copyMoveModal.classList.remove('active');
      }
    });
  }

  // Confirm copy/move
  if (btnSaveCopyMove) {
    btnSaveCopyMove.addEventListener('click', () => {
      const item = window.copyMoveItem;
      if (!item) return;

      const targetDate = copyMoveDate.value;
      const targetCategory = copyMoveCategory.value;
      
      if (!targetDate) {
        alert("Zadej datum.");
        return;
      }
      
      if (window.copyMoveActionType === 'copy') {
        // Clone item
        const newItem = {
          ...item,
          id: Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
          category: targetCategory
        };
        
        if (!appState.logs[targetDate]) {
          appState.logs[targetDate] = [];
        }
        appState.logs[targetDate].push(newItem);
        
        saveState();
        showToast("Jídlo zkopírováno! 📋");
      } else if (window.copyMoveActionType === 'move') {
        // Find and remove original item from logs
        let originalDate = null;
        for (const dStr in appState.logs) {
          const idx = appState.logs[dStr].findIndex(i => i.id === item.id);
          if (idx !== -1) {
            originalDate = dStr;
            appState.logs[dStr].splice(idx, 1);
            break;
          }
        }
        
        // Update item category and push to target date logs
        item.category = targetCategory;
        if (!appState.logs[targetDate]) {
          appState.logs[targetDate] = [];
        }
        appState.logs[targetDate].push(item);
        
        saveState();
        showToast("Jídlo přemístěno! ➡️");
      }
      
      if (copyMoveModal) copyMoveModal.classList.remove('active');
      renderDashboard();
    });
  }

  // Combine food trigger from action sheet
  if (btnActCombine) {
    btnActCombine.addEventListener('click', () => {
      const item = window.activeActionItem;
      if (!item) return;
      
      closeItemActionsSheet();
      
      window.combineModeActive = true;
      window.combineSelectedIds = new Set();
      window.combineSelectedIds.add(item.id);
      
      renderDashboard();
      updateCombineFloatingBar();
    });
  }

  // Combine floating bar - Cancel
  if (btnCombineCancel) {
    btnCombineCancel.addEventListener('click', () => {
      window.combineModeActive = false;
      window.combineSelectedIds.clear();
      renderDashboard();
      updateCombineFloatingBar();
    });
  }

  // Combine floating bar - Submit
  if (btnCombineSubmit) {
    btnCombineSubmit.addEventListener('click', () => {
      const selectedIds = window.combineSelectedIds;
      if (!selectedIds || selectedIds.size < 2) {
        alert("Vyber alespoň 2 položky pro sloučení.");
        return;
      }
      
      const todayStr = getActiveDateString();
      const todayFood = appState.logs[todayStr] || [];
      const selectedFoods = todayFood.filter(f => selectedIds.has(f.id));
      
      if (selectedFoods.length === 0) return;
      
      // Prompt for name
      const defaultName = selectedFoods.map(f => f.name).join(" + ");
      let combinedName = prompt("Zadej název pro sloučené jídlo:", defaultName);
      if (combinedName === null) return; // cancelled
      combinedName = combinedName.trim() || "Sloučené jídlo";
      
      // Sum nutrients
      let totalCal = 0;
      let totalP = 0;
      let totalC = 0;
      let totalF = 0;
      let totalWeightG = 0;
      let totalWeightMl = 0;
      let hasMixedUnits = false;
      
      selectedFoods.forEach(food => {
        totalCal += Number(food.calories || 0);
        totalP += Number(food.protein || 0);
        totalC += Number(food.carbs || 0);
        totalF += Number(food.fat || 0);
        
        const parsed = parseQuantity(food.amount || '');
        if (parsed.value > 0) {
          if (parsed.unit === 'ml') {
            totalWeightMl += parsed.value;
          } else if (parsed.unit === 'g') {
            totalWeightG += parsed.value;
          } else {
            hasMixedUnits = true;
          }
        } else {
          hasMixedUnits = true;
        }
      });
      
      let combinedAmount = "";
      if (!hasMixedUnits) {
        if (totalWeightG > 0 && totalWeightMl === 0) {
          combinedAmount = `${Math.round(totalWeightG)}g`;
        } else if (totalWeightMl > 0 && totalWeightG === 0) {
          combinedAmount = `${Math.round(totalWeightMl)}ml`;
        } else {
          combinedAmount = "1 ks";
        }
      } else {
        combinedAmount = "1 ks";
      }
      
      const firstFood = selectedFoods[0];
      const categoryStr = getFoodCategory(firstFood);
      
      // Delete the original items from logs
      appState.logs[todayStr] = todayFood.filter(f => !selectedIds.has(f.id));
      
      // Add the combined item
      const now = new Date();
      const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
      
      appState.logs[todayStr].push({
        id: Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
        time: timeStr,
        name: combinedName,
        amount: combinedAmount,
        calories: Math.round(totalCal),
        protein: Math.round(totalP * 10) / 10,
        carbs: Math.round(totalC * 10) / 10,
        fat: Math.round(totalF * 10) / 10,
        category: categoryStr
      });
      
      window.combineModeActive = false;
      window.combineSelectedIds.clear();
      
      saveState();
      renderDashboard();
      updateCombineFloatingBar();
      showToast("Jídla sloučena! 🍲");
    });
  }
}

// ==========================================================================
// AI COACH CHAT
// ==========================================================================
// Master switch for the coach's memory (conversation + manual facts).
function coachMemoryOn() {
  return appState.coachMemoryEnabled !== false;
}

// Conversations are stored as a list of chats. Each chat:
//   { id, title, messages: [{role, text}], createdAt, updatedAt }
// When memory is ON they live in appState.coachChats (persisted + synced).
// When OFF, the active chat is ephemeral and never saved.
let activeCoachChat = null;

function genCoachId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
}

function getCoachChats() {
  if (!Array.isArray(appState.coachChats)) appState.coachChats = [];
  return appState.coachChats;
}

// One-time migration: fold a legacy single coachHistory into a chat.
function migrateCoachChats() {
  if (!Array.isArray(appState.coachChats)) appState.coachChats = [];
  if (appState.coachChats.length === 0 && Array.isArray(appState.coachHistory) && appState.coachHistory.length) {
    const firstUser = appState.coachHistory.find((m) => m && m.role === 'user');
    appState.coachChats.push({
      id: genCoachId(),
      title: (firstUser ? firstUser.text : 'Chat').slice(0, 40),
      messages: appState.coachHistory.slice(),
      createdAt: Date.now(),
      updatedAt: Date.now()
    });
    appState.coachHistory = [];
  }
}

// ---- Manual memories (facts the user wants the coach to always know) ----
function getCoachMemories() {
  if (!Array.isArray(appState.coachMemories)) appState.coachMemories = [];
  return appState.coachMemories;
}

function addCoachMemory() {
  const input = document.getElementById('coach-memory-input');
  if (!input) return;
  const text = input.value.trim();
  if (!text) return;
  getCoachMemories().push({
    id: Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
    text
  });
  input.value = '';
  saveState();
  renderCoachMemorySettings();
  showToast('Přidáno do paměti ✓');
}

function removeCoachMemory(id) {
  appState.coachMemories = getCoachMemories().filter((m) => m.id !== id);
  saveState();
  renderCoachMemorySettings();
}

function toggleCoachMemory() {
  appState.coachMemoryEnabled = !coachMemoryOn();
  saveState();
  renderCoachMemorySettings();
  showToast(coachMemoryOn() ? 'Paměť zapnuta' : 'Paměť vypnuta');
}

// Paint the memory settings panel (toggle state, chat count, fact list).
function renderCoachMemorySettings() {
  const toggle = document.getElementById('btn-toggle-coach-memory');
  if (toggle) toggle.setAttribute('aria-checked', coachMemoryOn() ? 'true' : 'false');

  const stats = document.getElementById('coach-memory-stats');
  if (stats) {
    const chats = getCoachChats();
    const msgs = chats.reduce((s, c) => s + (Array.isArray(c.messages) ? c.messages.length : 0), 0);
    stats.textContent = coachMemoryOn()
      ? `Uloženo ${chats.length} chatů (${msgs} zpráv)`
      : 'Paměť je vypnutá — chaty se neukládají';
  }

  const list = document.getElementById('coach-memory-list');
  if (list) {
    const mems = getCoachMemories();
    list.innerHTML = '';
    if (mems.length === 0) {
      list.innerHTML = '<div class="mem-empty">Zatím žádná uložená fakta.</div>';
    } else {
      mems.forEach((m) => {
        const row = document.createElement('div');
        row.className = 'mem-item';
        const txt = document.createElement('div');
        txt.className = 'mem-item-text';
        txt.textContent = m.text;
        const del = document.createElement('button');
        del.className = 'mem-item-del';
        del.textContent = '×';
        del.setAttribute('aria-label', 'Odstranit');
        del.addEventListener('click', () => removeCoachMemory(m.id));
        row.appendChild(txt);
        row.appendChild(del);
        list.appendChild(row);
      });
    }
  }
}

function openCoach() {
  const modal = document.getElementById('coach-modal');
  if (!modal) return;
  modal.classList.add('active');
  hideCoachChatList();
  newCoachChat(); // a fresh chat every time the coach is opened
  setTimeout(() => {
    const input = document.getElementById('coach-input');
    if (input) input.focus();
  }, 250);
}

function closeCoach() {
  const modal = document.getElementById('coach-modal');
  if (modal) modal.classList.remove('active');
  hideCoachChatList();
}

function renderCoachEmpty() {
  const box = document.getElementById('coach-messages');
  if (!box) return;
  box.innerHTML = `<div class="coach-empty">čau bro, jsem tvůj kouč<br>vidím celej tvůj plán, jídlo i váhy z tréninku<br><br>klidně se ptej:<br>„jak na tom dnes jsem"<br>„co si dát k večeři"<br>„jak mi roste bench"</div>`;
}

// Start a brand-new (empty, not-yet-saved) chat as the active one.
function newCoachChat() {
  activeCoachChat = {
    id: genCoachId(),
    title: '',
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  hideCoachChatList();
  renderActiveCoachChat();
}

// Repaint the active chat's messages (no animation — instant).
function renderActiveCoachChat() {
  const box = document.getElementById('coach-messages');
  if (!box) return;
  if (!activeCoachChat || activeCoachChat.messages.length === 0) { renderCoachEmpty(); return; }
  box.innerHTML = '';
  activeCoachChat.messages.forEach((m) => appendCoachBubble(m.text, m.role === 'assistant' ? 'assistant' : 'user', false));
  box.scrollTop = box.scrollHeight;
}

// Load a saved chat by id and make it active.
function loadCoachChat(id) {
  const chat = getCoachChats().find((c) => c.id === id);
  if (!chat) return;
  activeCoachChat = chat;
  hideCoachChatList();
  renderActiveCoachChat();
}

function deleteCoachChat(id) {
  if (!confirm('Smazat tento chat?')) return;
  appState.coachChats = getCoachChats().filter((c) => c.id !== id);
  if (activeCoachChat && activeCoachChat.id === id) {
    newCoachChat();
  }
  saveState();
  renderCoachChatList();
  if (typeof renderCoachMemorySettings === 'function') renderCoachMemorySettings();
}

// ---- Chat list drawer ----
function showCoachChatList() {
  renderCoachChatList();
  const drawer = document.getElementById('coach-chatlist');
  const scrim = document.getElementById('coach-chatlist-scrim');
  if (drawer) drawer.classList.add('active');
  if (scrim) scrim.classList.add('active');
}

function hideCoachChatList() {
  const drawer = document.getElementById('coach-chatlist');
  const scrim = document.getElementById('coach-chatlist-scrim');
  if (drawer) drawer.classList.remove('active');
  if (scrim) scrim.classList.remove('active');
}

function toggleCoachChatList() {
  const drawer = document.getElementById('coach-chatlist');
  if (drawer && drawer.classList.contains('active')) hideCoachChatList();
  else showCoachChatList();
}

function renderCoachChatList() {
  const items = document.getElementById('coach-chatlist-items');
  if (!items) return;
  const chats = getCoachChats().slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  items.innerHTML = '';
  if (chats.length === 0) {
    items.innerHTML = '<div class="coach-chatlist-empty">Zatím žádné uložené chaty.<br>Napiš zprávu a chat se uloží.</div>';
    return;
  }
  chats.forEach((chat) => {
    const row = document.createElement('div');
    row.className = 'coach-chat-item' + (activeCoachChat && activeCoachChat.id === chat.id ? ' active' : '');
    const title = document.createElement('div');
    title.className = 'coach-chat-item-title';
    title.textContent = chat.title || 'Nový chat';
    title.addEventListener('click', () => loadCoachChat(chat.id));
    const del = document.createElement('button');
    del.className = 'coach-chat-item-del';
    del.textContent = '×';
    del.setAttribute('aria-label', 'Smazat chat');
    del.addEventListener('click', (e) => { e.stopPropagation(); deleteCoachChat(chat.id); });
    row.appendChild(title);
    row.appendChild(del);
    items.appendChild(row);
  });
}

// Clear ALL chats (used by the Memory settings "clear history" button).
function clearCoachHistoryAll() {
  if (!confirm('Smazat všechny chaty s AI Koučem?')) return;
  appState.coachChats = [];
  appState.coachHistory = [];
  newCoachChat();
  saveState();
  if (typeof renderCoachMemorySettings === 'function') renderCoachMemorySettings();
  showToast('Všechny chaty smazány');
}

// Render the AI's light markdown (bold/italic/bullets) safely as HTML.
function formatCoachText(text) {
  const esc = String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return esc
    // **bold**
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    // *italic* and _italic_ (not touching ** which is already handled)
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/(^|[\s(])_([^_\n]+)_/g, '$1<em>$2</em>')
    // bullet markers at line start -> •
    .replace(/^[ \t]*[-*][ \t]+/gm, '• ');
}

// Wrap each word inside a line element in a span that pops in, keeping any
// markdown tags (<strong>/<em>) intact. Returns the running word index so the
// stagger continues across lines. Reveals line by line, word by word.
function wrapCoachWords(lineEl, startIndex, box) {
  const walker = document.createTreeWalker(lineEl, NodeFilter.SHOW_TEXT, null);
  const textNodes = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode);

  let i = startIndex;
  textNodes.forEach((node) => {
    const parts = node.textContent.split(/(\s+)/); // keep whitespace chunks
    const frag = document.createDocumentFragment();
    parts.forEach((part) => {
      if (part === '' || /^\s+$/.test(part)) {
        frag.appendChild(document.createTextNode(part));
      } else {
        const span = document.createElement('span');
        span.className = 'coach-word';
        span.textContent = part;
        span.style.animationDelay = (i * 0.04) + 's';
        // Scroll to follow the reveal as each word appears.
        if (box) span.addEventListener('animationstart', () => { box.scrollTop = box.scrollHeight; });
        i++;
        frag.appendChild(span);
      }
    });
    node.parentNode.replaceChild(frag, node);
  });
  return i;
}

// Reveal an assistant reply progressively: lines are ADDED to the DOM over
// time (so the bubble grows from the top down and scrolls — "posunuje"), and
// within each line the words pop in one after another. Adding lines over time
// (instead of rendering them all invisible up front) avoids the giant empty
// box that reserved space for not-yet-revealed text.
const COACH_WORD_STEP_MS = 40; // delay between words within a line
const COACH_LINE_GAP_MS = 110; // extra pause between lines

function renderCoachLines(el, text, box) {
  el.innerHTML = '';
  const lines = String(text).split('\n').filter((l) => l.trim() !== '');
  let lineDelay = 0;
  el._coachTimers = el._coachTimers || [];

  lines.forEach((line) => {
    const wordCount = line.trim().split(/\s+/).length;
    const t = setTimeout(() => {
      const lineEl = document.createElement('div');
      lineEl.className = 'coach-line';
      lineEl.innerHTML = formatCoachText(line);
      // Word delays restart per line (the line itself is already time-offset).
      wrapCoachWords(lineEl, 0, box);
      el.appendChild(lineEl);
      if (box) box.scrollTop = box.scrollHeight;
    }, lineDelay);
    el._coachTimers.push(t);
    lineDelay += wordCount * COACH_WORD_STEP_MS + COACH_LINE_GAP_MS;
  });
}

function appendCoachBubble(text, role, animate, imageDataUrl) {
  const box = document.getElementById('coach-messages');
  if (!box) return null;
  const empty = box.querySelector('.coach-empty');
  if (empty) empty.remove();
  const div = document.createElement('div');
  div.className = `coach-bubble ${role}`;
  // Optional attached image (user messages).
  if (imageDataUrl) {
    const img = document.createElement('img');
    img.className = 'coach-bubble-img';
    img.src = imageDataUrl;
    div.appendChild(img);
  }
  // Assistant replies may contain markdown; render it. User text stays literal.
  if (role === 'assistant') {
    if (animate) {
      renderCoachLines(div, text, box);
    } else {
      div.innerHTML = formatCoachText(text);
    }
  } else if (text) {
    // User text — append as a text node so any image thumbnail is preserved.
    div.appendChild(document.createTextNode(text));
  }
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
  return div;
}

// Build the food/calorie context for the currently viewed day.
function buildFoodContext() {
  const date = getActiveDateString();
  const items = (appState.logs[date] || []).map(i => ({
    id: i.id,
    name: i.name,
    amount: i.amount,
    category: getCategoryName(getFoodCategory(i)),
    calories: i.calories,
    protein: i.protein,
    carbs: i.carbs,
    fat: i.fat
  }));
  const totals = items.reduce((s, i) => ({
    calories: s.calories + Number(i.calories || 0),
    protein: s.protein + Number(i.protein || 0),
    carbs: s.carbs + Number(i.carbs || 0),
    fat: s.fat + Number(i.fat || 0)
  }), { calories: 0, protein: 0, carbs: 0, fat: 0 });
  totals.calories = Math.round(totals.calories);
  totals.protein = Math.round(totals.protein * 10) / 10;
  totals.carbs = Math.round(totals.carbs * 10) / 10;
  totals.fat = Math.round(totals.fat * 10) / 10;

  return {
    date,
    goals: appState.goals,
    totals,
    items,
    weight: appState.weight
  };
}

async function sendCoachMessage() {
  const input = document.getElementById('coach-input');
  const sendBtn = document.getElementById('coach-send');
  if (!input) return;
  const message = input.value.trim();
  const image = coachPendingImage; // may be null
  if (!message && !image) return;

  const session = getSession();
  if (!session || !session.token) {
    showToast('Chyba: Nejste přihlášen');
    return;
  }

  input.value = '';
  clearCoachImage();
  if (sendBtn) sendBtn.disabled = true;
  const memOn = coachMemoryOn();
  if (!activeCoachChat) newCoachChat();
  const chat = activeCoachChat;
  const isFirstMessage = chat.messages.length === 0;

  // User bubble: image thumbnail (if any) + text.
  appendCoachBubble(message, 'user', false, image);
  const storedText = image ? (message ? message + ' 📷' : '📷 (fotka)') : message;
  chat.messages.push({ role: 'user', text: storedText });
  chat.updatedAt = Date.now();
  if (isFirstMessage) {
    chat.title = (storedText || 'Fotka').slice(0, 40);
    if (memOn && !getCoachChats().some((c) => c.id === chat.id)) {
      getCoachChats().unshift(chat);
    }
  }
  if (memOn) saveState();

  const typing = appendCoachBubble('Píše…', 'assistant');
  if (typing) typing.classList.add('typing');

  // /api/chat gives the model real tools (profile, targets, workout plan,
  // meal plan) on top of the food-log actions the older /api/chat handled.
  const payload = buildCoachPayload(message, {
    image: image || undefined,
    history: chat.messages.slice(0, -1).slice(-20)
  });

  let data = null;
  let netError = false;
  try {
    data = await callCoachAPI(payload);
  } catch (error) {
    console.error('Coach fetch error:', error);
    netError = true;
  }

  try {
    if (typing) typing.remove();

    if (data && data.success && data.reply) {
      // Plan edits are applied immediately; food-log edits still go through
      // the confirmation card below.
      if (data.planChanged || Array.isArray(data.miniApps)) {
        applyCoachPlanUpdate(data);
        showToast(data.newMiniAppId ? 'Appka je hotová ✓' : 'Plán upraven ✓');
      }
      // Safeguard: never show a raw action block even if the backend missed it.
      const replyText = String(data.reply).replace(/\[\[ACTION\]\][\s\S]*$/, '').trim() || 'mám to';
      // The coach may split a reply into several short texts with ||| — show each
      // as its own bubble like a human firing off quick messages.
      const bubbles = replyText.split(/\s*\|\|\|\s*/).map((s) => s.trim()).filter(Boolean).slice(0, 3);
      const parts = bubbles.length ? bubbles : [replyText];
      parts.forEach((b, i) => {
        setTimeout(() => appendCoachBubble(b, 'assistant', true), i * 500);
      });
      chat.messages.push({ role: 'assistant', text: parts.join('\n') });
      chat.updatedAt = Date.now();
      if (chat.messages.length > 200) chat.messages = chat.messages.slice(-200);
      if (memOn) saveState();
      // If the coach proposed a food change, ask the user to confirm it.
      if (data.action && typeof data.action === 'object') {
        renderCoachActionCard(data.action);
      }
      if (data.newMiniAppId) {
        setTimeout(() => renderMiniAppChatCard(data.newMiniAppId), parts.length * 500 + 200);
      }
    } else if (netError) {
      appendCoachBubble('spojení vypadlo bro, zkus to ještě jednou', 'assistant');
    } else {
      appendCoachBubble((data && data.error) || 'sorry, jsem teď dost cooked, zkus to za chvíli', 'assistant');
    }
  } finally {
    if (sendBtn) sendBtn.disabled = false;
    input.focus();
  }
}

// ---- Coach image attachment ----
let coachPendingImage = null;

async function handleCoachImageFile(file) {
  if (!file) return;
  try {
    const dataUrl = await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = reject;
      r.readAsDataURL(file);
    });
    coachPendingImage = await downscaleImage(dataUrl, 1024, 0.8);
    const preview = document.getElementById('coach-image-preview');
    const thumb = document.getElementById('coach-image-thumb');
    if (thumb) thumb.src = coachPendingImage;
    if (preview) preview.style.display = 'flex';
  } catch (e) {
    showToast('Nepodařilo se načíst obrázek');
  }
}

function clearCoachImage() {
  coachPendingImage = null;
  const preview = document.getElementById('coach-image-preview');
  const fileInput = document.getElementById('coach-image-input');
  if (preview) preview.style.display = 'none';
  if (fileInput) fileInput.value = '';
}

// ---- Coach food-management actions (proposed by AI, confirmed by user) ----
function czCategoryToId(cz) {
  const n = normalizeFoodName(cz);
  const map = {
    'snidane': 'Breakfast', 'breakfast': 'Breakfast',
    'dopoledni svacina': 'Morning snack', 'morning snack': 'Morning snack',
    'obed': 'Lunch', 'lunch': 'Lunch',
    'odpoledni svacina': 'Afternoon snack', 'afternoon snack': 'Afternoon snack',
    'vecere': 'Dinner', 'dinner': 'Dinner',
    'druha vecere': 'Second dinner', 'second dinner': 'Second dinner'
  };
  return map[n] || 'Breakfast';
}

function shiftDateString(base, deltaDays) {
  const dt = new Date(base + 'T00:00:00');
  dt.setDate(dt.getDate() + deltaDays);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

function resolveActionDate(action) {
  const raw = action && action.date != null ? String(action.date).trim() : '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  if (raw) {
    // Fallback: resolve common relative keywords against the real today.
    const today = getTodayDateString();
    const n = normalizeFoodName(raw); // lowercased, diacritics stripped
    if (n === 'dnes' || n === 'today') return today;
    if (n === 'zitra' || n === 'tomorrow') return shiftDateString(today, 1);
    if (n === 'pozitri') return shiftDateString(today, 2);
    if (n === 'vcera' || n === 'yesterday') return shiftDateString(today, -1);
    if (n === 'predevcirem') return shiftDateString(today, -2);
  }
  return getActiveDateString();
}

// A short "📅 Po 25.6." label when an action targets a day other than the
// currently viewed one (so the user sees which day will change).
function actionDateNote(action) {
  const date = resolveActionDate(action);
  if (date === getActiveDateString()) return '';
  const dt = new Date(date + 'T00:00:00');
  const days = ['Ne', 'Po', 'Út', 'St', 'Čt', 'Pá', 'So'];
  const today = getTodayDateString();
  let rel = '';
  if (date === today) rel = ' (dnes)';
  else if (date === shiftDateString(today, 1)) rel = ' (zítra)';
  else if (date === shiftDateString(today, -1)) rel = ' (včera)';
  return `\n📅 ${days[dt.getDay()]} ${dt.getDate()}.${dt.getMonth() + 1}.${rel}`;
}

// Find a logged item by id across all days (returns {date, item} or null).
function findLoggedItemById(id) {
  for (const d of Object.keys(appState.logs || {})) {
    const it = (appState.logs[d] || []).find((x) => x.id === id);
    if (it) return { date: d, item: it };
  }
  return null;
}

// Human-readable summary of a proposed action (no mutation).
function describeCoachAction(action) {
  if (!action || !action.type) return 'Neznámá akce.';
  if (action.type === 'add') {
    const cat = getCategoryName(czCategoryToId(action.category));
    const items = (action.items || []).map((i) => `${i.name} (${i.amount || ''}, ${Math.round(Number(i.calories) || 0)} kcal)`);
    const head = action.replacesPlannedMeal
      ? `➕ Zapsat do „${cat}" to, co jsi fakt snědl${action._note ? ` (${action._note})` : ''}:`
      : `➕ Přidat do „${cat}":${actionDateNote(action)}`;
    return `${head}\n${items.map((t) => '• ' + t).join('\n')}`;
  }
  if (action.type === 'delete') {
    if (Array.isArray(action.ids) && action.ids.length) {
      const names = action.ids.map((id) => {
        const f = findLoggedItemById(id);
        return f ? f.item.name : id;
      });
      return `🗑️ Smazat: ${names.join(', ')}`;
    }
    if (action.category) {
      const catId = czCategoryToId(action.category);
      const date = resolveActionDate(action);
      const count = (appState.logs[date] || []).filter((i) => getFoodCategory(i) === catId).length;
      return `🗑️ Smazat celou kategorii „${getCategoryName(catId)}" (${count} položek)${actionDateNote(action)}`;
    }
    return '🗑️ Smazat jídlo';
  }
  if (action.type === 'edit') {
    const f = findLoggedItemById(action.id);
    const name = f ? f.item.name : 'položku';
    const ch = action.changes || {};
    const parts = [];
    if (ch.amount != null) parts.push(`množství → ${ch.amount}`);
    if (ch.calories != null) parts.push(`${Math.round(Number(ch.calories))} kcal`);
    if (ch.name != null) parts.push(`název → ${ch.name}`);
    return `✏️ Upravit „${name}": ${parts.join(', ') || 'změny'}`;
  }
  return 'Neznámá akce.';
}

// Apply a confirmed action to the logs. Returns a short result string.
function executeCoachAction(action) {
  if (!action || !action.type) return 'Nic se nestalo.';

  if (action.type === 'add') {
    const date = resolveActionDate(action);
    if (!appState.logs[date]) appState.logs[date] = [];
    const catId = czCategoryToId(action.category);

    // Logging what was actually eaten from a planned meal supersedes whatever
    // that meal wrote earlier, so ticking then correcting can't double-count.
    if (action.replacesPlannedMeal) {
      appState.logs[date] = appState.logs[date].filter((i) => i.fromPlan !== action.replacesPlannedMeal);
      const checks = getMealChecks(date);
      if (!checks.includes(action.replacesPlannedMeal)) checks.push(action.replacesPlannedMeal);
    }
    const now = new Date();
    const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    let n = 0;
    (action.items || []).forEach((it) => {
      if (!it || !it.name) return;
      appState.logs[date].push({
        id: Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
        time: timeStr,
        name: it.name,
        amount: it.amount || '100g',
        calories: Math.round(Number(it.calories) || 0),
        protein: Math.round((Number(it.protein) || 0) * 10) / 10,
        carbs: Math.round((Number(it.carbs) || 0) * 10) / 10,
        fat: Math.round((Number(it.fat) || 0) * 10) / 10,
        category: catId,
        fromPlan: action.replacesPlannedMeal || undefined
      });
      n++;
    });
    return `Přidáno ${n} ${n === 1 ? 'jídlo' : 'jídel'}.`;
  }

  if (action.type === 'delete') {
    let removed = 0;
    if (Array.isArray(action.ids) && action.ids.length) {
      const idset = new Set(action.ids);
      Object.keys(appState.logs).forEach((d) => {
        const before = appState.logs[d].length;
        appState.logs[d] = appState.logs[d].filter((i) => !idset.has(i.id));
        removed += before - appState.logs[d].length;
      });
    } else if (action.category) {
      const catId = czCategoryToId(action.category);
      const date = resolveActionDate(action);
      const before = (appState.logs[date] || []).length;
      appState.logs[date] = (appState.logs[date] || []).filter((i) => getFoodCategory(i) !== catId);
      removed = before - (appState.logs[date] || []).length;
    }
    return `Smazáno ${removed} ${removed === 1 ? 'položka' : 'položek'}.`;
  }

  if (action.type === 'edit') {
    const f = findLoggedItemById(action.id);
    if (!f) return 'Položka nenalezena.';
    const ch = action.changes || {};
    const it = f.item;
    if (ch.name != null) it.name = ch.name;
    if (ch.amount != null) it.amount = ch.amount;
    if (ch.calories != null) it.calories = Math.round(Number(ch.calories) || 0);
    if (ch.protein != null) it.protein = Math.round((Number(ch.protein) || 0) * 10) / 10;
    if (ch.carbs != null) it.carbs = Math.round((Number(ch.carbs) || 0) * 10) / 10;
    if (ch.fat != null) it.fat = Math.round((Number(ch.fat) || 0) * 10) / 10;
    // Editing overrides any prior leftover bookkeeping.
    delete it.original;
    delete it.leftovers;
    return 'Upraveno.';
  }

  return 'Neznámá akce.';
}

// Render a confirmation card for a proposed action with Confirm / Cancel.
function renderCoachActionCard(action) {
  const box = document.getElementById('coach-messages');
  if (!box) return;
  const card = document.createElement('div');
  card.className = 'coach-action-card';

  const summary = document.createElement('div');
  summary.className = 'coach-action-summary';
  summary.textContent = describeCoachAction(action);
  card.appendChild(summary);

  const ask = document.createElement('div');
  ask.className = 'coach-action-ask';
  ask.textContent = 'Můžu to provést?';
  card.appendChild(ask);

  const row = document.createElement('div');
  row.className = 'coach-action-buttons';
  const yes = document.createElement('button');
  yes.className = 'coach-action-btn confirm';
  yes.textContent = '✓ Potvrdit';
  const no = document.createElement('button');
  no.className = 'coach-action-btn cancel';
  no.textContent = '✕ Zrušit';
  row.appendChild(no);
  row.appendChild(yes);
  card.appendChild(row);

  const finish = (noteText) => {
    card.remove();
    appendCoachBubble(noteText, 'assistant', false);
    if (activeCoachChat) {
      activeCoachChat.messages.push({ role: 'assistant', text: noteText });
      activeCoachChat.updatedAt = Date.now();
      if (coachMemoryOn()) saveState();
    }
  };

  yes.addEventListener('click', () => {
    const result = executeCoachAction(action);
    saveState();
    renderDashboard();
    finish(`done, ${result.toLowerCase()}`);
    showToast('Jídelníček upraven ✓');
  });
  no.addEventListener('click', () => finish('ok, nechávám to bejt'));

  box.appendChild(card);
  box.scrollTop = box.scrollHeight;
}

function initCoachHandlers() {
  const openBtn = document.getElementById('btn-open-coach');
  const navCoachBtn = document.getElementById('nav-coach');
  const closeBtn = document.getElementById('btn-close-coach');
  const chatsBtn = document.getElementById('btn-coach-chats');
  const newChatBtn = document.getElementById('btn-new-coach-chat');
  const chatlistScrim = document.getElementById('coach-chatlist-scrim');
  const sendBtn = document.getElementById('coach-send');
  const input = document.getElementById('coach-input');
  const modal = document.getElementById('coach-modal');
  const attachBtn = document.getElementById('coach-attach');
  const imageInput = document.getElementById('coach-image-input');
  const imageRemove = document.getElementById('coach-image-remove');

  if (openBtn) openBtn.addEventListener('click', openCoach);
  if (navCoachBtn) navCoachBtn.addEventListener('click', openCoach);
  if (closeBtn) closeBtn.addEventListener('click', closeCoach);
  if (chatsBtn) chatsBtn.addEventListener('click', toggleCoachChatList);
  if (newChatBtn) newChatBtn.addEventListener('click', newCoachChat);
  if (chatlistScrim) chatlistScrim.addEventListener('click', hideCoachChatList);
  if (sendBtn) sendBtn.addEventListener('click', sendCoachMessage);
  if (attachBtn && imageInput) {
    attachBtn.addEventListener('click', () => imageInput.click());
    imageInput.addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      if (file) handleCoachImageFile(file);
    });
  }
  if (imageRemove) imageRemove.addEventListener('click', clearCoachImage);
  if (input) {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); sendCoachMessage(); }
    });
  }
  // Tap outside the sheet to dismiss.
  if (modal) {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeCoach();
    });
  }

  // ---- Memory settings (in the Settings screen) ----
  const memToggle = document.getElementById('btn-toggle-coach-memory');
  const memAddBtn = document.getElementById('btn-add-coach-memory');
  const memInput = document.getElementById('coach-memory-input');
  const histClearBtn = document.getElementById('btn-clear-coach-history');

  if (memToggle) memToggle.addEventListener('click', toggleCoachMemory);
  if (memAddBtn) memAddBtn.addEventListener('click', addCoachMemory);
  if (memInput) {
    memInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); addCoachMemory(); }
    });
  }
  if (histClearBtn) histClearBtn.addEventListener('click', clearCoachHistoryAll);
}

// Run app init

window.addEventListener('DOMContentLoaded', init);

// ==========================================================================
// COACH PLAN LAYER — profil, tréninkový plán, jídelníček
// ==========================================================================
// The plan itself is generated and edited by the AI coach through Gemini
// function calling (see api/chat.js). Everything below is the client side:
// rendering the plan, tracking what was ticked off, and handing the coach the
// context it needs.

const PLAN_DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const PLAN_DAY_CZ = {
  mon: 'Pondělí', tue: 'Úterý', wed: 'Středa', thu: 'Čtvrtek',
  fri: 'Pátek', sat: 'Sobota', sun: 'Neděle'
};
const PLAN_DAY_SHORT = { mon: 'Po', tue: 'Út', wed: 'St', thu: 'Čt', fri: 'Pá', sat: 'So', sun: 'Ne' };

let planViewTab = 'workout';   // 'workout' | 'meals'
let planViewDay = null;        // null = today

// Weekday key for a YYYY-MM-DD string (Monday-first, matching the backend).
function dayKeyForDateStr(dateStr) {
  const d = /^\d{4}-\d{2}-\d{2}$/.test(dateStr || '')
    ? new Date(`${dateStr}T12:00:00Z`)
    : new Date();
  return PLAN_DAY_KEYS[(d.getUTCDay() + 6) % 7];
}

function getTodayDayKey() {
  return dayKeyForDateStr(getTodayDateString());
}

function getActiveDayKey() {
  return planViewDay || dayKeyForDateStr(getActiveDateString());
}

function getWorkoutForDay(dayKey) {
  const plan = appState.workoutPlan;
  if (!plan || !plan.days) return null;
  return plan.days[dayKey] || null;
}

function getMealsForDay(dayKey) {
  const plan = appState.mealPlan;
  if (!plan || !plan.days || !plan.days[dayKey]) return [];
  return plan.days[dayKey].meals || [];
}

function hasPlan() {
  return !!(appState.workoutPlan || appState.mealPlan);
}

// ---- Completion tracking (per calendar date, not per weekday) ----

function getWorkoutLog(date) {
  const d = date || getActiveDateString();
  if (!appState.workoutLogs[d]) appState.workoutLogs[d] = { done: [] };
  if (!Array.isArray(appState.workoutLogs[d].done)) appState.workoutLogs[d].done = [];
  return appState.workoutLogs[d];
}

function toggleExerciseDone(exId, date) {
  const log = getWorkoutLog(date);
  const i = log.done.indexOf(exId);
  if (i === -1) log.done.push(exId); else log.done.splice(i, 1);
  saveState();
}

function getMealChecks(date) {
  const d = date || getActiveDateString();
  if (!Array.isArray(appState.mealChecks[d])) appState.mealChecks[d] = [];
  return appState.mealChecks[d];
}

// Ticking a planned meal also writes it into the real food log, so the rings
// and the coach see it like any other logged food.
function togglePlannedMeal(meal, date) {
  const d = date || getActiveDateString();
  const checks = getMealChecks(d);
  const idx = checks.indexOf(meal.id);

  if (idx === -1) {
    checks.push(meal.id);
    if (!appState.logs[d]) appState.logs[d] = [];
    const now = new Date();
    const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const catId = czCategoryToId(meal.category);
    (meal.items || []).forEach((it) => {
      appState.logs[d].push({
        id: Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
        time: timeStr,
        name: it.name,
        amount: it.amount || '100g',
        calories: Math.round(Number(it.calories) || 0),
        protein: Math.round((Number(it.protein) || 0) * 10) / 10,
        carbs: Math.round((Number(it.carbs) || 0) * 10) / 10,
        fat: Math.round((Number(it.fat) || 0) * 10) / 10,
        category: catId,
        fromPlan: meal.id
      });
    });
    showToast(`${meal.name} zapsáno ✓`);
  } else {
    checks.splice(idx, 1);
    // Remove exactly the entries this meal created.
    appState.logs[d] = (appState.logs[d] || []).filter((i) => i.fromPlan !== meal.id);
    showToast('Odškrtnuto');
  }
  saveState();
  renderPlanScreen();
  renderDashboard();
}

// Short text summary of today's training, handed to the coach as context.
function buildWorkoutStatus() {
  const dayKey = getTodayDayKey();
  const w = getWorkoutForDay(dayKey);
  if (!w) return 'Tréninkový plán zatím neexistuje.';
  if (w.rest) return `Dnes (${PLAN_DAY_CZ[dayKey]}) je volno.`;
  const log = getWorkoutLog(getTodayDateString());
  const total = w.exercises.length;
  const done = w.exercises.filter((e) => log.done.includes(e.id)).length;
  const rest = w.exercises.filter((e) => !log.done.includes(e.id)).map((e) => e.name);
  return `Dnes (${PLAN_DAY_CZ[dayKey]}): ${w.title} — hotovo ${done}/${total} cviků.` +
    (rest.length ? ` Zbývá: ${rest.join(', ')}` : ' Trénink dokončen.');
}

// ==========================================================================
// PLAN SCREEN — Trénink / Jídelníček
// ==========================================================================

function renderPlanDayStrip() {
  const strip = document.getElementById('plan-day-strip');
  if (!strip) return;
  const todayKey = getTodayDayKey();
  const activeKey = getActiveDayKey();
  strip.innerHTML = '';
  PLAN_DAY_KEYS.forEach((k) => {
    const btn = document.createElement('button');
    btn.className = 'plan-day-chip' + (k === activeKey ? ' active' : '') + (k === todayKey ? ' today' : '');
    btn.type = 'button';
    btn.textContent = PLAN_DAY_SHORT[k];
    btn.addEventListener('click', () => {
      planViewDay = k;
      renderPlanScreen();
    });
    strip.appendChild(btn);
  });
}

function renderWorkoutView() {
  const box = document.getElementById('plan-workout-view');
  if (!box) return;
  const dayKey = getActiveDayKey();
  const isToday = dayKey === getTodayDayKey();
  const date = isToday ? getTodayDateString() : null;
  const w = getWorkoutForDay(dayKey);

  if (!appState.workoutPlan) {
    box.innerHTML = `
      <div class="plan-empty">
        <div class="plan-empty-title">Zatím žádný tréninkový plán</div>
        <div class="plan-empty-sub">Řekni si o něj kouči — vygeneruje ti split na míru</div>
        <button class="plan-empty-btn" type="button" id="plan-ask-workout">Chci plán</button>
      </div>`;
    const b = document.getElementById('plan-ask-workout');
    if (b) b.addEventListener('click', () => askCoach('vygeneruj mi tréninkový plán'));
    return;
  }

  if (!w || w.rest) {
    box.innerHTML = `
      <div class="plan-rest-card">
        <div class="plan-rest-icon">😴</div>
        <div class="plan-rest-title">${PLAN_DAY_CZ[dayKey]} — volno</div>
        <div class="plan-rest-sub">Regenerace je součást plánu</div>
      </div>`;
    return;
  }

  const log = isToday ? getWorkoutLog(date) : { done: [] };
  const doneCount = w.exercises.filter((e) => log.done.includes(e.id)).length;
  const pct = w.exercises.length ? Math.round((doneCount / w.exercises.length) * 100) : 0;

  box.innerHTML = `
    <div class="plan-section-head">
      <div>
        <div class="plan-section-title">${w.title}</div>
        <div class="plan-section-sub">${w.focus || appState.workoutPlan.split}</div>
      </div>
      ${isToday ? `<div class="plan-progress-pill">${doneCount}/${w.exercises.length}</div>` : ''}
    </div>
    ${isToday ? `<div class="plan-progress-bar"><div class="plan-progress-fill" style="width:${pct}%"></div></div>` : ''}
    ${isToday ? `<button class="ses-start-btn" id="ses-start" type="button">${hasActiveSession() ? '▶  Pokračovat v tréninku' : '▶  Spustit trénink'}</button>` : ''}
    <div class="plan-ex-list" id="plan-ex-list"></div>`;

  const startBtn = document.getElementById('ses-start');
  if (startBtn) startBtn.addEventListener('click', () => {
    if (hasActiveSession()) resumeSessionIfAny(); else startWorkoutSession(dayKey);
  });

  const list = document.getElementById('plan-ex-list');
  w.exercises.forEach((ex) => {
    const done = log.done.includes(ex.id);
    const row = document.createElement('div');
    row.className = 'plan-ex-row' + (done ? ' done' : '');

    const last = getLastExerciseSession(ex.name, date || getTodayDateString());
    const lastTop = sessionTopSet(last);
    const suggestion = suggestNextLoad(ex.name, ex.reps);
    const stalled = isExerciseStalled(ex.name);
    const hasHistory = getExerciseHistory(ex.name).length > 0;

    let lastLine = '';
    if (lastTop) {
      lastLine = `<div class="plan-ex-last">minule ${formatSet(lastTop)}` +
        (suggestion ? ` · <b>zkus ${String(suggestion).replace('.', ',')} kg</b>` : '') +
        (stalled ? ' · <span class="ex-stall">stojí to</span>' : '') + '</div>';
    }

    row.innerHTML = `
      <div class="plan-ex-main">
        <button class="plan-ex-check${done ? ' checked' : ''}" type="button" aria-label="Hotovo">${done ? '✓' : ''}</button>
        <div class="plan-ex-body">
          <div class="plan-ex-name">${ex.name}</div>
          <div class="plan-ex-meta">${ex.sets} × ${ex.reps} · pauza ${ex.restSec}s${ex.note ? ' · ' + ex.note : ''}</div>
          ${lastLine}
        </div>
        ${hasHistory ? '<button class="plan-ex-chart" type="button" aria-label="Historie cviku">📈</button>' : ''}
      </div>`;

    if (isToday) {
      row.appendChild(buildSetInputs(ex, date));
      row.querySelector('.plan-ex-check').addEventListener('click', () => {
        // Ticking the exercise commits whatever is in the inputs — including
        // values still showing as prefilled — so "just confirm" really is one tap.
        commitSetInputs(ex, date, row);
        toggleExerciseDone(ex.id, date);
        renderPlanScreen();
      });
    } else {
      row.querySelector('.plan-ex-check').disabled = true;
    }

    const chartBtn = row.querySelector('.plan-ex-chart');
    if (chartBtn) chartBtn.addEventListener('click', () => openExerciseDetail(ex.name));

    list.appendChild(row);
  });
}

// One kg/reps input pair per planned set, prefilled from the last session so
// an unchanged workout is a single tap.
function buildSetInputs(ex, date) {
  const wrap = document.createElement('div');
  wrap.className = 'plan-ex-sets';

  const today = getSessionForDate(ex.name, date);
  const last = getLastExerciseSession(ex.name, date);
  const count = Math.max(1, Math.min(12, Number(ex.sets) || 3));

  for (let i = 0; i < count; i++) {
    const saved = today && today.sets[i];
    const prev = last && last.sets[i];
    const w = saved ? saved.w : (prev ? prev.w : '');
    const r = saved ? saved.r : (prev ? prev.r : '');

    const line = document.createElement('div');
    line.className = 'ex-set-row' + (saved ? ' filled' : '');
    line.innerHTML = `
      <span class="ex-set-idx">${i + 1}.</span>
      <input class="ex-set-w" type="number" inputmode="decimal" step="0.5" min="0" max="600"
             placeholder="kg" value="${w === '' ? '' : w}" aria-label="Váha série ${i + 1}">
      <span class="ex-set-x">×</span>
      <input class="ex-set-r" type="number" inputmode="numeric" step="1" min="0" max="100"
             placeholder="op." value="${r === '' ? '' : r}" aria-label="Opakování série ${i + 1}">`;
    wrap.appendChild(line);
  }

  // Persist as soon as a value changes, so nothing is lost if the app is closed.
  wrap.addEventListener('change', () => {
    commitSetInputs(ex, date, wrap.parentElement || wrap);
    wrap.querySelectorAll('.ex-set-row').forEach((r) => {
      const w = r.querySelector('.ex-set-w').value;
      const rep = r.querySelector('.ex-set-r').value;
      r.classList.toggle('filled', !!(w && rep));
    });
  });

  return wrap;
}

function commitSetInputs(ex, date, root) {
  if (!root) return;
  const sets = [...root.querySelectorAll('.ex-set-row')].map((r) => ({
    w: parseFloat(String(r.querySelector('.ex-set-w').value).replace(',', '.')),
    r: parseInt(r.querySelector('.ex-set-r').value, 10)
  }));
  logExerciseSession(ex.name, date, sets);
}

function renderMealsView() {
  const box = document.getElementById('plan-meals-view');
  if (!box) return;
  const dayKey = getActiveDayKey();
  const isToday = dayKey === getTodayDayKey();
  const date = isToday ? getTodayDateString() : null;
  const meals = getMealsForDay(dayKey);

  if (!appState.mealPlan) {
    box.innerHTML = `
      <div class="plan-empty">
        <div class="plan-empty-title">Zatím žádný jídelníček</div>
        <div class="plan-empty-sub">Kouč ti ho vygeneruje podle tvých cílů a chutí</div>
        <button class="plan-empty-btn" type="button" id="plan-ask-meals">Chci jídelníček</button>
      </div>`;
    const b = document.getElementById('plan-ask-meals');
    if (b) b.addEventListener('click', () => askCoach('vygeneruj mi jídelníček'));
    return;
  }

  if (!meals.length) {
    box.innerHTML = `<div class="plan-empty"><div class="plan-empty-sub">Pro ${PLAN_DAY_CZ[dayKey]} zatím není naplánované jídlo</div></div>`;
    return;
  }

  const tot = meals.reduce((s, m) => ({
    calories: s.calories + m.calories, protein: s.protein + m.protein,
    carbs: s.carbs + m.carbs, fat: s.fat + m.fat
  }), { calories: 0, protein: 0, carbs: 0, fat: 0 });
  const g = appState.goals || {};

  const drift = dayTargetDrift(dayKey);
  const driftWarn = (drift != null && Math.abs(drift) > 10)
    ? `<div class="plan-drift ${drift > 0 ? 'over' : 'under'}">Den je ${drift > 0 ? 'o ' + drift + ' % nad' : 'o ' + Math.abs(drift) + ' % pod'} cílem</div>`
    : '';

  const week = weekSummary();
  const rem = isToday ? remainingToday() : null;

  box.innerHTML = `
    <div class="plan-section-head">
      <div>
        <div class="plan-section-title">${PLAN_DAY_CZ[dayKey]}</div>
        <div class="plan-section-sub">${Math.round(tot.calories)} kcal z ${g.calories || '—'} · B ${Math.round(tot.protein)} g</div>
      </div>
    </div>
    ${driftWarn}
    ${rem ? `<div class="plan-remaining">Do cíle zbývá <b>${rem.calories} kcal</b> a <b>${rem.protein} g</b> bílkovin</div>` : ''}
    <div class="plan-day-actions">
      <button class="plan-day-action" data-act="regen" type="button">Přegenerovat den</button>
      ${isToday ? '<button class="plan-day-action" data-act="eaten" type="button">Vše snědeno</button>' : ''}
      <button class="plan-day-action" data-act="shop" type="button">Nákupní seznam</button>
      <button class="plan-day-action" data-act="share" type="button">Sdílet</button>
    </div>
    <div class="plan-meal-list" id="plan-meal-list"></div>
    ${week ? `<div class="plan-week-summary">
      <span class="plan-week-title">Průměr týdne (${week.days} dní)</span>
      <span class="plan-week-val">${week.avgCalories} kcal · B ${week.avgProtein} g · S ${week.avgCarbs} g · T ${week.avgFat} g</span>
    </div>` : ''}`;

  box.querySelectorAll('.plan-day-action').forEach((btn) => {
    btn.addEventListener('click', () => {
      const act = btn.getAttribute('data-act');
      if (act === 'regen') askCoach(`přegeneruj mi celý jídelníček na ${PLAN_DAY_CZ[dayKey].toLowerCase()}`);
      else if (act === 'eaten') markDayEaten(dayKey);
      else if (act === 'shop') openShoppingList();
      else if (act === 'share') shareMealPlan();
    });
  });

  const checks = isToday ? getMealChecks(date) : [];
  const list = document.getElementById('plan-meal-list');
  meals.forEach((m) => {
    const eaten = checks.includes(m.id);
    const card = document.createElement('div');
    card.className = 'plan-meal-card' + (eaten ? ' eaten' : '');
    const locked = isMealLocked(m.id);
    if (locked) card.classList.add('locked');
    card.innerHTML = `
      <div class="plan-meal-head">
        <button class="plan-meal-check${eaten ? ' checked' : ''}" type="button" aria-label="Snědeno">${eaten ? '✓' : ''}</button>
        <div class="plan-meal-titles">
          <div class="plan-meal-cat">${m.category}</div>
          <div class="plan-meal-name">${m.name}</div>
        </div>
        <button class="plan-meal-lock${locked ? ' on' : ''}" type="button" aria-label="${locked ? 'Odemknout' : 'Zamknout'}">${locked ? '🔒' : '🔓'}</button>
        <div class="plan-meal-kcal">${m.calories}<span>kcal</span></div>
      </div>
      <div class="plan-meal-items">${(m.items || []).map((i) => `<span>${i.name} ${i.amount}</span>`).join('')}</div>
      <div class="plan-meal-macros">B ${m.protein} g · S ${m.carbs} g · T ${m.fat} g</div>
      <div class="plan-meal-btns">
        ${isToday ? '<button class="plan-meal-btn" data-act="check" type="button">📷 Sedí to?</button>' : ''}
        <button class="plan-meal-btn" data-act="chat" type="button">💬 Domluvit</button>
        <button class="plan-meal-btn" data-act="copy" type="button">Kopírovat</button>
      </div>`;

    const chk = card.querySelector('.plan-meal-check');
    if (isToday) {
      chk.addEventListener('click', () => togglePlannedMeal(m, date));
    } else {
      chk.disabled = true;
    }
    card.querySelector('.plan-meal-lock').addEventListener('click', () => toggleMealLock(m.id));
    card.querySelectorAll('.plan-meal-btn').forEach((b) => {
      b.addEventListener('click', () => {
        const act = b.getAttribute('data-act');
        if (act === 'check') openMealCheck(m, dayKey);
        else if (act === 'chat') openMealChatSheet(m, dayKey);
        else if (act === 'copy') askCoach(`zkopíruj mi ${m.name} z ${PLAN_DAY_CZ[dayKey].toLowerCase()} i na další dny`);
      });
    });
    list.appendChild(card);
  });
}

function renderPlanScreen() {
  const screen = document.getElementById('screen-plan');
  if (!screen) return;
  renderPlanDayStrip();

  const wTab = document.getElementById('plan-tab-workout');
  const mTab = document.getElementById('plan-tab-meals');
  const wView = document.getElementById('plan-workout-view');
  const mView = document.getElementById('plan-meals-view');
  const showWorkout = planViewTab === 'workout';

  if (wTab) wTab.classList.toggle('active', showWorkout);
  if (mTab) mTab.classList.toggle('active', !showWorkout);
  if (wView) wView.style.display = showWorkout ? 'block' : 'none';
  if (mView) mView.style.display = showWorkout ? 'none' : 'block';

  if (showWorkout) renderWorkoutView(); else renderMealsView();
}

function openPlanScreen(tab) {
  if (tab) planViewTab = tab;
  planViewDay = null;
  if (window.switchAppScreen) window.switchAppScreen('screen-plan');
}

// ==========================================================================
// DASHBOARD PLAN CARDS
// ==========================================================================

function renderDashboardPlanCards() {
  const wrap = document.getElementById('dash-plan-cards');
  if (!wrap) return;

  if (!hasPlan()) {
    wrap.innerHTML = `
      <button class="dash-plan-cta" type="button" id="dash-plan-cta">
        <div class="dash-plan-cta-title">Nemáš ještě plán</div>
        <div class="dash-plan-cta-sub">Nech si od kouče sestavit trénink a jídelníček</div>
      </button>`;
    const c = document.getElementById('dash-plan-cta');
    if (c) c.addEventListener('click', () => startOnboarding(true));
    return;
  }

  const dayKey = getTodayDayKey();
  const date = getTodayDateString();
  const w = getWorkoutForDay(dayKey);
  const meals = getMealsForDay(dayKey);

  let workoutHtml = '';
  if (w && !w.rest) {
    const log = getWorkoutLog(date);
    const done = w.exercises.filter((e) => log.done.includes(e.id)).length;
    const pct = w.exercises.length ? Math.round((done / w.exercises.length) * 100) : 0;
    workoutHtml = `
      <button class="dash-plan-card" type="button" data-tab="workout">
        <div class="dash-plan-card-head">
          <span class="dash-plan-card-label">Dnešní trénink</span>
          <span class="dash-plan-card-badge">${done}/${w.exercises.length}</span>
        </div>
        <div class="dash-plan-card-title">${w.title}</div>
        <div class="dash-plan-bar"><div class="dash-plan-bar-fill" style="width:${pct}%"></div></div>
      </button>`;
  } else if (w) {
    workoutHtml = `
      <button class="dash-plan-card" type="button" data-tab="workout">
        <div class="dash-plan-card-head"><span class="dash-plan-card-label">Dnešní trénink</span></div>
        <div class="dash-plan-card-title">Volno 😴</div>
        <div class="dash-plan-card-sub">Regenerace</div>
      </button>`;
  }

  let mealsHtml = '';
  if (meals.length) {
    const checks = getMealChecks(date);
    const eaten = meals.filter((m) => checks.includes(m.id)).length;
    const kcal = meals.reduce((s, m) => s + m.calories, 0);
    mealsHtml = `
      <button class="dash-plan-card" type="button" data-tab="meals">
        <div class="dash-plan-card-head">
          <span class="dash-plan-card-label">Dnešní jídelníček</span>
          <span class="dash-plan-card-badge">${eaten}/${meals.length}</span>
        </div>
        <div class="dash-plan-card-title">${kcal} kcal</div>
        <div class="dash-plan-card-sub">${meals.map((m) => m.category).join(' · ')}</div>
      </button>`;
  }

  wrap.innerHTML = workoutHtml + mealsHtml;
  wrap.querySelectorAll('.dash-plan-card').forEach((el) => {
    el.addEventListener('click', () => openPlanScreen(el.getAttribute('data-tab')));
  });
}

// ==========================================================================
// COACH — unified endpoint with Gemini function calling
// ==========================================================================

// Merge whatever the coach changed back into local state.
function applyCoachPlanUpdate(data) {
  let changed = false;
  if (data.profile && typeof data.profile === 'object') {
    appState.profile = data.profile;
    changed = true;
  }
  if (data.targets && data.targets.calories) {
    appState.goals = {
      calories: Math.round(data.targets.calories),
      protein: Math.round(data.targets.protein),
      carbs: Math.round(data.targets.carbs),
      fat: Math.round(data.targets.fat)
    };
    changed = true;
  }
  if (data.workoutPlan) { appState.workoutPlan = data.workoutPlan; changed = true; }
  if (data.exerciseLogs && typeof data.exerciseLogs === 'object') {
    appState.exerciseLogs = data.exerciseLogs;
    changed = true;
  }
  if (Array.isArray(data.miniApps)) {
    appState.miniApps = data.miniApps;
    changed = true;
  }
  if (data.mealPlan) { appState.mealPlan = data.mealPlan; changed = true; }
  if (changed) {
    saveState();
    renderDashboard();
    renderPlanScreen();
  }
  return changed;
}

// Everything the coach needs to answer with full awareness of the app.
function buildCoachPayload(message, opts = {}) {
  return {
    message,
    mode: opts.mode || 'coach',
    image: opts.image || undefined,
    history: opts.history || [],
    profile: appState.profile || {},
    targets: appState.goals || null,
    workoutPlan: appState.workoutPlan || null,
    mealPlan: appState.mealPlan || null,
    lockedMeals: getMealLocks(),
    exerciseLogs: getExerciseLogs(),
    exerciseHistory: buildExerciseContext(),
    appSnapshot: buildAppSnapshot(),
    miniApps: getMiniApps(),
    sessionHistory: (appState.sessionHistory || []).slice(0, 5),
    foodContext: buildFoodContext(),
    workoutStatus: buildWorkoutStatus(),
    memories: coachMemoryOn() ? getCoachMemories().map((m) => m.text) : [],
    today: getTodayDateString(),
    nowTime: (() => {
      const n = new Date();
      return `${String(n.getHours()).padStart(2, '0')}:${String(n.getMinutes()).padStart(2, '0')}`;
    })()
  };
}

// Single place that talks to /api/chat, with the same retry behaviour the
// food coach already uses.
async function callCoachAPI(payload) {
  const session = getSession();
  if (!session || !session.token) throw new Error('Nejste přihlášen');

  const body = JSON.stringify(payload);
  let data = null;
  let netError = false;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const resp = await fetch('/api/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.token}`
        },
        body
      });
      data = await resp.json().catch(() => ({}));
      netError = false;
      if (data && data.success) break;
      if (resp.status === 503 && attempt < 1) {
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
      break;
    } catch (e) {
      console.error('Coach fetch error:', e);
      netError = true;
      if (attempt < 1) {
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
    }
  }
  if (netError) throw new Error('spojení vypadlo bro, zkus to ještě jednou');
  return data;
}

// Open the coach and send a message on the user's behalf (used by the plan
// screen's "Vyměnit jídlo" / "Chci plán" buttons).
function askCoach(text) {
  openCoach();
  const input = document.getElementById('coach-input');
  if (input) {
    input.value = text;
    sendCoachMessage();
  }
}

// ==========================================================================
// ONBOARDING — chat s koučem místo formuláře
// ==========================================================================
// The coach drives the whole thing: it asks one question at a time and calls
// save_profile / compute_targets / set_workout_plan / set_meal_plan through
// Gemini function calling. There is no form and no fixed question order.

let onboardingBusy = false;

const ONBOARDING_OPENER = 'ahoj, jsem tvůj kouč. pojďme si to nastavit ||| co chceš dokázat — zpevnit, zhubnout, nebo nabrat?';

function onboardingNeeded() {
  return !appState.onboardingDone && !hasPlan();
}

function appendOnboardingBubble(text, role, animate) {
  const box = document.getElementById('onb-messages');
  if (!box) return null;
  const el = document.createElement('div');
  el.className = `coach-bubble ${role}`;
  box.appendChild(el);
  if (animate && role === 'assistant') {
    renderCoachLines(el, text, box);
  } else {
    el.innerHTML = formatCoachText(text);
  }
  box.scrollTop = box.scrollHeight;
  return el;
}

function renderOnboardingHistory() {
  const box = document.getElementById('onb-messages');
  if (!box) return;
  box.innerHTML = '';
  (appState.onboardingChat || []).forEach((m) => {
    m.text.split(/\s*\|\|\|\s*/).filter(Boolean).forEach((part) => {
      appendOnboardingBubble(part, m.role, false);
    });
  });
}

function startOnboarding(force) {
  const overlay = document.getElementById('onboarding-overlay');
  if (!overlay) return;
  if (force) appState.onboardingDone = false;
  overlay.classList.add('active');
  document.body.style.overflow = 'hidden';

  if (!appState.onboardingChat.length) {
    ONBOARDING_OPENER.split(/\s*\|\|\|\s*/).forEach((part, i) => {
      setTimeout(() => appendOnboardingBubble(part.trim(), 'assistant', true), i * 700);
    });
    appState.onboardingChat.push({ role: 'assistant', text: ONBOARDING_OPENER });
    saveState();
  } else {
    renderOnboardingHistory();
  }
  setTimeout(() => {
    const inp = document.getElementById('onb-input');
    if (inp) inp.focus();
  }, 400);
}

function finishOnboarding() {
  const overlay = document.getElementById('onboarding-overlay');
  appState.onboardingDone = true;
  saveState();
  if (overlay) overlay.classList.remove('active');
  document.body.style.overflow = '';
  renderDashboard();
  renderPlanScreen();
}

// Progress hint under the header — purely informative, the coach decides flow.
function updateOnboardingProgress() {
  const el = document.getElementById('onb-progress');
  if (!el) return;
  const p = appState.profile || {};
  const fields = ['goal', 'sex', 'age', 'heightCm', 'weightKg', 'trainingDaysPerWeek', 'equipment', 'experience'];
  const filled = fields.filter((f) => p[f] != null && p[f] !== '').length;
  const pct = Math.round((filled / fields.length) * 100);
  el.querySelector('.onb-progress-fill').style.width = `${pct}%`;
  const label = el.querySelector('.onb-progress-label');
  if (hasPlan()) {
    label.textContent = 'plán hotový';
  } else if (filled >= fields.length) {
    label.textContent = 'skládám ti plán…';
  } else {
    label.textContent = `${filled}/${fields.length} zjištěno`;
  }
}

async function sendOnboardingMessage() {
  const input = document.getElementById('onb-input');
  const sendBtn = document.getElementById('onb-send');
  if (!input || onboardingBusy) return;
  const message = input.value.trim();
  if (!message) return;

  input.value = '';
  onboardingBusy = true;
  if (sendBtn) sendBtn.disabled = true;

  appendOnboardingBubble(message, 'user', false);
  appState.onboardingChat.push({ role: 'user', text: message });
  saveState();

  const typing = appendOnboardingBubble('Píše…', 'assistant');
  if (typing) typing.classList.add('typing');

  try {
    const payload = buildCoachPayload(message, {
      mode: 'onboarding',
      history: appState.onboardingChat.slice(0, -1).slice(-20)
    });
    const data = await callCoachAPI(payload);
    if (typing) typing.remove();

    if (data && data.success && data.reply) {
      applyCoachPlanUpdate(data);
      updateOnboardingProgress();

      const parts = String(data.reply).split(/\s*\|\|\|\s*/).map((s) => s.trim()).filter(Boolean).slice(0, 3);
      parts.forEach((b, i) => setTimeout(() => appendOnboardingBubble(b, 'assistant', true), i * 600));
      appState.onboardingChat.push({ role: 'assistant', text: parts.join(' ||| ') });
      saveState();

      // Once the coach has produced both plans, offer the way out.
      if (appState.workoutPlan && appState.mealPlan) {
        setTimeout(() => showOnboardingDone(), parts.length * 600 + 400);
      }
    } else {
      appendOnboardingBubble((data && data.error) || 'sorry, jsem teď dost cooked, zkus to za chvíli', 'assistant');
    }
  } catch (e) {
    if (typing) typing.remove();
    appendOnboardingBubble(e.message || 'něco se pokazilo, zkus to znovu', 'assistant');
  } finally {
    onboardingBusy = false;
    if (sendBtn) sendBtn.disabled = false;
    input.focus();
  }
}

function showOnboardingDone() {
  const box = document.getElementById('onb-messages');
  if (!box || document.getElementById('onb-done-card')) return;
  const g = appState.goals || {};
  const card = document.createElement('div');
  card.className = 'coach-action-card';
  card.id = 'onb-done-card';
  card.innerHTML = `
    <div class="coach-action-summary">✅ Plán je hotový\n${g.calories} kcal denně · B ${g.protein} g · S ${g.carbs} g · T ${g.fat} g\nSplit: ${appState.workoutPlan.split}</div>
    <div class="coach-action-ask">Můžeš se na něj mrknout a kdykoliv mi napsat o změnu.</div>
    <div class="coach-action-buttons">
      <button class="coach-action-btn confirm" id="onb-go">Ukázat plán</button>
    </div>`;
  box.appendChild(card);
  box.scrollTop = box.scrollHeight;
  document.getElementById('onb-go').addEventListener('click', () => {
    finishOnboarding();
    openPlanScreen('workout');
  });
}

function initOnboardingHandlers() {
  const input = document.getElementById('onb-input');
  const sendBtn = document.getElementById('onb-send');
  const skipBtn = document.getElementById('onb-skip');
  const restartBtn = document.getElementById('btn-restart-onboarding');

  if (sendBtn) sendBtn.addEventListener('click', sendOnboardingMessage);
  if (input) {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); sendOnboardingMessage(); }
    });
  }
  if (skipBtn) {
    skipBtn.addEventListener('click', () => {
      appState.onboardingDone = true;
      saveState();
      const overlay = document.getElementById('onboarding-overlay');
      if (overlay) overlay.classList.remove('active');
      document.body.style.overflow = '';
    });
  }
  if (restartBtn) {
    restartBtn.addEventListener('click', () => {
      if (!confirm('Začít nastavení s koučem znovu? Tvůj profil a plán se přepíšou.')) return;
      appState.onboardingChat = [];
      appState.onboardingDone = false;
      saveState();
      startOnboarding(true);
    });
  }
}

// ==========================================================================
// PLAN SCREEN HANDLERS
// ==========================================================================

function initPlanHandlers() {
  const wTab = document.getElementById('plan-tab-workout');
  const mTab = document.getElementById('plan-tab-meals');
  const coachBtn = document.getElementById('plan-coach-btn');

  if (wTab) wTab.addEventListener('click', () => { planViewTab = 'workout'; renderPlanScreen(); });
  if (mTab) mTab.addEventListener('click', () => { planViewTab = 'meals'; renderPlanScreen(); });
  if (coachBtn) coachBtn.addEventListener('click', () => openCoach());
}

// ==========================================================================
// KONTROLA JÍDLA PODLE PLÁNU — vyfoť talíř, appka řekne jestli sedí
// ==========================================================================
// The user photographs what is actually on the plate; the AI compares it with
// the planned meal and says whether to eat more, less, or that it is fine.
// "Ukaž mi to" then renders the corrected plate with the image model.

let mealCheckState = null; // { meal, dayKey, photo, verdict }

const MEAL_CHECK_MODEL_IMAGE = 'gemini-2.5-flash-image';

function plannedMealSummary(meal) {
  const items = (meal.items || []).map((i) => `${i.name} ${i.amount}`).join(', ');
  return `${meal.name} (${items}) — ${meal.calories} kcal, B ${meal.protein} g, S ${meal.carbs} g, T ${meal.fat} g`;
}

// Ask Gemini to compare the photo against the planned meal.
async function analyzePlannedMeal(photoBase64, meal) {
  const session = getSession();
  if (!session) throw new Error('Nejste přihlášen');

  const small = await downscaleImage(photoBase64, 768, 0.72);
  const m = /^data:(image\/[a-zA-Z+]+);base64,(.+)$/.exec(small);
  if (!m) throw new Error('Neplatná fotka');

  const systemInstruction = `Jsi nutriční specialista. Uživatel má naplánované jídlo a vyfotil, co má reálně na talíři. Porovnej fotku s plánem a řekni, jestli to sedí.

PLÁNOVANÉ JÍDLO:
${plannedMealSummary(meal)}

POSTUP:
1. Identifikuj VŠECHNY viditelné složky na fotce a odhadni jejich hmotnost. Domácí porce bývají MENŠÍ než restaurační — při pochybnostech odhadni méně.
2. Spočítej skutečné kalorie a makra toho, co je na fotce.
3. Porovnej s plánem a rozhodni:
   - "ok" = kalorie jsou do ±12 % plánu
   - "more" = na talíři je VÝRAZNĚ MÍŇ, než má být → user má sníst ještě něco
   - "less" = na talíři je VÝRAZNĚ VÍC → user má ubrat
4. V "advice" napiš JEDNU krátkou větu česky, neformálně, malým písmenem, bez tečky na konci. Konkrétně kolik gramů čeho ubrat/přidat.
5. V "adjustments" uveď konkrétní úpravy (co a kolik gramů). Když je verdikt "ok", nech pole prázdné.

Vrať POUZE validní JSON, žádný markdown:
{
  "detected": [{"name":"český název","amount":"150g","calories":200,"protein":20,"carbs":10,"fat":5}],
  "total": {"calories":200,"protein":20,"carbs":10,"fat":5},
  "verdict": "ok" | "more" | "less",
  "diffCalories": -120,
  "advice": "sněz ještě asi 60 g rýže",
  "adjustments": [{"action":"add"|"remove","item":"rýže","grams":60}]
}`;

  const payload = {
    systemInstruction: { parts: [{ text: systemInstruction }] },
    contents: [{
      role: 'user',
      parts: [
        { text: 'Porovnej tuhle fotku s plánovaným jídlem podle pravidel.' },
        { inlineData: { mimeType: m[1], data: m[2] } }
      ]
    }],
    generationConfig: { temperature: 0.3, maxOutputTokens: 2048 }
  };

  const resp = await fetch('/api/gemini', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session.token}` },
    body: JSON.stringify(payload)
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error((data.error && data.error.message) || 'AI je teď vytížená, zkus to za chvíli');

  const cand = data.candidates && data.candidates[0];
  const text = cand && cand.content && Array.isArray(cand.content.parts)
    ? cand.content.parts.map((p) => p.text || '').join('').trim()
    : '';
  if (!text) throw new Error('AI nevrátila odpověď');

  const cleaned = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    const s = cleaned.indexOf('{');
    const en = cleaned.lastIndexOf('}');
    if (s === -1 || en === -1) throw new Error('AI vrátila nečitelnou odpověď');
    parsed = JSON.parse(cleaned.slice(s, en + 1));
  }
  if (!['ok', 'more', 'less'].includes(parsed.verdict)) parsed.verdict = 'ok';
  return parsed;
}

// Render the corrected plate with the image model ("nano banana").
async function renderCorrectedPlate(photoBase64, verdict, meal) {
  const session = getSession();
  if (!session) throw new Error('Nejste přihlášen');

  const small = await downscaleImage(photoBase64, 768, 0.8);
  const m = /^data:(image\/[a-zA-Z+]+);base64,(.+)$/.exec(small);
  if (!m) throw new Error('Neplatná fotka');

  const adj = (verdict.adjustments || [])
    .map((a) => `${a.action === 'add' ? 'přidej' : 'uber'} ${a.grams} g — ${a.item}`)
    .join('; ');

  const prompt = verdict.verdict === 'ok'
    ? `Uprav tuhle fotku jídla tak, aby vypadala jako ideální porce podle plánu: ${plannedMealSummary(meal)}. Zachovej stejný talíř, úhel i osvětlení, jen dolaď množství. Fotorealisticky.`
    : `Uprav tuhle fotku jídla podle instrukcí: ${adj}. Zachovej PŘESNĚ stejný talíř, stejný úhel pohledu, stejné osvětlení i pozadí — změň jen množství jídla na talíři, ať je vidět, jak má porce správně vypadat. Fotorealisticky, žádný text ani popisky v obrázku.`;

  const payload = {
    __model: MEAL_CHECK_MODEL_IMAGE,
    contents: [{
      role: 'user',
      parts: [{ text: prompt }, { inlineData: { mimeType: m[1], data: m[2] } }]
    }],
    generationConfig: { responseModalities: ['IMAGE'] }
  };

  const resp = await fetch('/api/gemini', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session.token}` },
    body: JSON.stringify(payload)
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error((data.error && data.error.message) || 'Obrázek se nepovedlo vygenerovat');

  const cand = data.candidates && data.candidates[0];
  const parts = (cand && cand.content && Array.isArray(cand.content.parts)) ? cand.content.parts : [];
  const img = parts.find((p) => p.inlineData && p.inlineData.data);
  if (!img) throw new Error('Model nevrátil obrázek');
  return `data:${img.inlineData.mimeType || 'image/png'};base64,${img.inlineData.data}`;
}

// ---- Meal check UI ----

function openMealCheck(meal, dayKey) {
  mealCheckState = { meal, dayKey, photo: null, verdict: null };
  const input = document.getElementById('meal-check-input');
  if (input) { input.value = ''; input.click(); }
}

function closeMealCheck() {
  const modal = document.getElementById('meal-check-modal');
  if (modal) modal.classList.remove('active');
  mealCheckState = null;
  mealChat = null;
}

function showMealCheckModal() {
  const modal = document.getElementById('meal-check-modal');
  if (modal) modal.classList.add('active');
}

function renderMealCheckBody(html) {
  const body = document.getElementById('meal-check-body');
  if (body) body.innerHTML = html;
}

async function handleMealCheckPhoto(file) {
  if (!file || !mealCheckState) return;
  const dataUrl = await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  }).catch(() => null);
  if (!dataUrl) { showToast('Nepodařilo se načíst fotku'); return; }

  mealCheckState.photo = dataUrl;
  showMealCheckModal();
  renderMealCheckBody(`
    <div class="mc-photo-wrap"><img src="${dataUrl}" alt="tvoje jídlo"></div>
    <div class="mc-loading"><div class="mc-spinner"></div><span>porovnávám s plánem…</span></div>`);

  try {
    const verdict = await analyzePlannedMeal(dataUrl, mealCheckState.meal);
    if (!mealCheckState) return; // user closed it meanwhile
    mealCheckState.verdict = verdict;
    renderMealCheckVerdict();
  } catch (e) {
    renderMealCheckBody(`
      <div class="mc-photo-wrap"><img src="${dataUrl}" alt="tvoje jídlo"></div>
      <div class="mc-error">${e.message || 'Nepovedlo se to vyhodnotit'}</div>
      <button class="mc-btn secondary" id="mc-retry" type="button">Zkusit znovu</button>`);
    const r = document.getElementById('mc-retry');
    if (r) r.addEventListener('click', () => handleMealCheckPhoto(file));
  }
}

function renderMealCheckVerdict() {
  const { meal, verdict, photo } = mealCheckState;
  const badge = { ok: 'Sedí to', more: 'Sněz ještě', less: 'Uber trochu' }[verdict.verdict];
  const tone = { ok: 'good', more: 'warn', less: 'warn' }[verdict.verdict];
  const t = verdict.total || {};
  const diff = Math.round(Number(verdict.diffCalories) || 0);
  const diffTxt = diff === 0 ? '' : (diff > 0 ? `+${diff}` : `${diff}`) + ' kcal oproti plánu';

  renderMealCheckBody(`
    <div class="mc-photo-wrap"><img src="${photo}" alt="tvoje jídlo"></div>
    <div class="mc-verdict ${tone}">
      <div class="mc-verdict-badge">${badge}</div>
      <div class="mc-verdict-advice">${verdict.advice || ''}</div>
      ${diffTxt ? `<div class="mc-verdict-diff">${diffTxt}</div>` : ''}
    </div>
    <div class="mc-compare">
      <div class="mc-compare-col">
        <span class="mc-compare-label">Na talíři</span>
        <span class="mc-compare-val">${Math.round(t.calories || 0)} kcal</span>
        <span class="mc-compare-sub">B ${Math.round(t.protein || 0)} · S ${Math.round(t.carbs || 0)} · T ${Math.round(t.fat || 0)}</span>
      </div>
      <div class="mc-compare-col">
        <span class="mc-compare-label">Plán</span>
        <span class="mc-compare-val">${meal.calories} kcal</span>
        <span class="mc-compare-sub">B ${Math.round(meal.protein)} · S ${Math.round(meal.carbs)} · T ${Math.round(meal.fat)}</span>
      </div>
    </div>
    ${(verdict.detected || []).length ? `<div class="mc-detected">${verdict.detected.map((d) => `<span>${d.name} ${d.amount}</span>`).join('')}</div>` : ''}
    <div id="mc-image-slot"></div>
    <div class="mc-actions">
      ${verdict.verdict !== 'ok' ? '<button class="mc-btn secondary" id="mc-visualize" type="button">Ukaž mi to</button>' : ''}
      <button class="mc-btn primary" id="mc-log" type="button">Zapsat, co mám na talíři</button>
    </div>
    <div class="mc-chat-divider"><span>nebo se domluv s koučem</span></div>
    <div id="mc-chat-slot"></div>`);

  const viz = document.getElementById('mc-visualize');
  if (viz) viz.addEventListener('click', visualizeCorrectedPlate);

  const log = document.getElementById('mc-log');
  if (log) log.addEventListener('click', logDetectedMeal);

  // Same contextual chat as the meal card, but it also knows the photo verdict.
  const slot = document.getElementById('mc-chat-slot');
  if (slot) mountMealChat(slot, { meal, dayKey: mealCheckState.dayKey, verdict, photo });
}

async function visualizeCorrectedPlate() {
  const btn = document.getElementById('mc-visualize');
  const slot = document.getElementById('mc-image-slot');
  if (!btn || !slot || !mealCheckState) return;
  btn.disabled = true;
  slot.innerHTML = '<div class="mc-loading"><div class="mc-spinner"></div><span>kreslím, jak to má vypadat…</span></div>';
  try {
    const url = await renderCorrectedPlate(mealCheckState.photo, mealCheckState.verdict, mealCheckState.meal);
    slot.innerHTML = `
      <div class="mc-generated">
        <span class="mc-generated-label">Takhle by to mělo vypadat</span>
        <img src="${url}" alt="upravená porce">
      </div>`;
  } catch (e) {
    slot.innerHTML = `<div class="mc-error">${e.message || 'Obrázek se nepovedlo vygenerovat'}</div>`;
    btn.disabled = false;
  }
}

// Log what is actually on the plate (not the planned meal) into the diary.
function logDetectedMeal() {
  if (!mealCheckState || !mealCheckState.verdict) return;
  const { meal, verdict } = mealCheckState;
  const items = verdict.detected || [];
  if (!items.length) { showToast('Nebylo co zapsat'); return; }

  const date = getTodayDateString();
  if (!appState.logs[date]) appState.logs[date] = [];
  const now = new Date();
  const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const catId = czCategoryToId(meal.category);

  // Replace anything this planned meal already wrote, so checking after
  // ticking doesn't double-count.
  appState.logs[date] = appState.logs[date].filter((i) => i.fromPlan !== meal.id);
  items.forEach((it) => {
    appState.logs[date].push({
      id: Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
      time: timeStr,
      name: it.name,
      amount: it.amount || '100g',
      calories: Math.round(Number(it.calories) || 0),
      protein: Math.round((Number(it.protein) || 0) * 10) / 10,
      carbs: Math.round((Number(it.carbs) || 0) * 10) / 10,
      fat: Math.round((Number(it.fat) || 0) * 10) / 10,
      category: catId,
      fromPlan: meal.id
    });
  });
  const checks = getMealChecks(date);
  if (!checks.includes(meal.id)) checks.push(meal.id);

  saveState();
  renderDashboard();
  renderPlanScreen();
  closeMealCheck();
  showToast('Zapsáno podle fotky ✓');
}

function initMealCheckHandlers() {
  const input = document.getElementById('meal-check-input');
  const closeBtn = document.getElementById('meal-check-close');
  const modal = document.getElementById('meal-check-modal');

  if (input) input.addEventListener('change', (e) => handleMealCheckPhoto(e.target.files[0]));
  if (closeBtn) closeBtn.addEventListener('click', closeMealCheck);
  if (modal) modal.addEventListener('click', (e) => { if (e.target === modal) closeMealCheck(); });
}

// ==========================================================================
// MALÉ FUNKCE JÍDELNÍČKU
// ==========================================================================

// ---- Zámek jídla: uzamčené jídlo kouč při přegenerování nemá měnit ----
function getMealLocks() {
  if (!Array.isArray(appState.mealLocks)) appState.mealLocks = [];
  if (!appState.exerciseLogs || typeof appState.exerciseLogs !== 'object') appState.exerciseLogs = {};
  return appState.mealLocks;
}

function isMealLocked(mealId) {
  return getMealLocks().includes(mealId);
}

function toggleMealLock(mealId) {
  const locks = getMealLocks();
  const i = locks.indexOf(mealId);
  if (i === -1) { locks.push(mealId); showToast('Jídlo zamčeno 🔒'); }
  else { locks.splice(i, 1); showToast('Jídlo odemčeno'); }
  saveState();
  renderPlanScreen();
}

// ---- Denní souhrn a odchylka od cílů ----
function dayTotals(dayKey) {
  return getMealsForDay(dayKey).reduce((s, m) => ({
    calories: s.calories + m.calories,
    protein: s.protein + m.protein,
    carbs: s.carbs + m.carbs,
    fat: s.fat + m.fat
  }), { calories: 0, protein: 0, carbs: 0, fat: 0 });
}

// How far a day's plan is from the calorie target, as a signed percentage.
function dayTargetDrift(dayKey) {
  const goal = (appState.goals && appState.goals.calories) || 0;
  if (!goal) return null;
  const kcal = dayTotals(dayKey).calories;
  if (!kcal) return null;
  return Math.round(((kcal - goal) / goal) * 100);
}

function weekSummary() {
  const days = PLAN_DAY_KEYS.filter((k) => getMealsForDay(k).length);
  if (!days.length) return null;
  const sum = days.reduce((s, k) => {
    const t = dayTotals(k);
    return {
      calories: s.calories + t.calories,
      protein: s.protein + t.protein,
      carbs: s.carbs + t.carbs,
      fat: s.fat + t.fat
    };
  }, { calories: 0, protein: 0, carbs: 0, fat: 0 });
  return {
    days: days.length,
    avgCalories: Math.round(sum.calories / days.length),
    avgProtein: Math.round(sum.protein / days.length),
    avgCarbs: Math.round(sum.carbs / days.length),
    avgFat: Math.round(sum.fat / days.length)
  };
}

// ---- Kolik ještě zbývá do dnešního cíle ----
function remainingToday() {
  const date = getTodayDateString();
  const eaten = (appState.logs[date] || []).reduce((s, i) => ({
    calories: s.calories + (Number(i.calories) || 0),
    protein: s.protein + (Number(i.protein) || 0)
  }), { calories: 0, protein: 0 });
  const g = appState.goals || {};
  return {
    calories: Math.max(0, Math.round((g.calories || 0) - eaten.calories)),
    protein: Math.max(0, Math.round((g.protein || 0) - eaten.protein))
  };
}

// ---- Nákupní seznam: sečte suroviny přes celý týden ----
function buildShoppingList() {
  const totals = {};
  PLAN_DAY_KEYS.forEach((k) => {
    getMealsForDay(k).forEach((m) => {
      (m.items || []).forEach((it) => {
        const key = normalizeFoodName(it.name);
        const grams = parseFloat(String(it.amount).replace(',', '.')) || 0;
        const unit = /ml/i.test(it.amount || '') ? 'ml' : 'g';
        if (!totals[key]) totals[key] = { name: it.name, grams: 0, unit };
        totals[key].grams += grams;
      });
    });
  });
  return Object.values(totals)
    .sort((a, b) => b.grams - a.grams)
    .map((x) => ({ name: x.name, amount: `${Math.round(x.grams)} ${x.unit}` }));
}

function openShoppingList() {
  const list = buildShoppingList();
  const modal = document.getElementById('shopping-modal');
  const body = document.getElementById('shopping-body');
  if (!modal || !body) return;

  if (!list.length) {
    body.innerHTML = '<div class="plan-empty-sub" style="padding:24px 0;text-align:center;">Jídelníček je prázdný</div>';
  } else {
    const bought = new Set(Array.isArray(appState.shoppingBought) ? appState.shoppingBought : []);
    body.innerHTML = list.map((x, i) => `
      <label class="shop-row${bought.has(x.name) ? ' bought' : ''}">
        <input type="checkbox" data-name="${x.name.replace(/"/g, '&quot;')}"${bought.has(x.name) ? ' checked' : ''}>
        <span class="shop-name">${x.name}</span>
        <span class="shop-amount">${x.amount}</span>
      </label>`).join('');
    body.querySelectorAll('input[type=checkbox]').forEach((cb) => {
      cb.addEventListener('change', () => {
        if (!Array.isArray(appState.shoppingBought)) appState.shoppingBought = [];
  if (!Array.isArray(appState.miniApps)) appState.miniApps = [];
  if (appState.activeSession === undefined) appState.activeSession = null;
  if (!Array.isArray(appState.sessionHistory)) appState.sessionHistory = [];
        const n = cb.getAttribute('data-name');
        const idx = appState.shoppingBought.indexOf(n);
        if (cb.checked && idx === -1) appState.shoppingBought.push(n);
        if (!cb.checked && idx !== -1) appState.shoppingBought.splice(idx, 1);
        cb.closest('.shop-row').classList.toggle('bought', cb.checked);
        saveState();
      });
    });
  }
  modal.classList.add('active');
}

// ---- Označit celý den jako snědený ----
function markDayEaten(dayKey) {
  const meals = getMealsForDay(dayKey);
  if (!meals.length) return;
  const date = getTodayDateString();
  const checks = getMealChecks(date);
  const pending = meals.filter((m) => !checks.includes(m.id));
  if (!pending.length) { showToast('Už je odškrtnuto všechno'); return; }
  pending.forEach((m) => togglePlannedMealSilent(m, date));
  saveState();
  renderPlanScreen();
  renderDashboard();
  showToast(`Zapsáno ${pending.length} jídel ✓`);
}

// Same as togglePlannedMeal but without the per-meal toast / re-render, so
// marking a whole day doesn't fire six toasts and six full re-renders.
function togglePlannedMealSilent(meal, date) {
  const checks = getMealChecks(date);
  if (checks.includes(meal.id)) return;
  checks.push(meal.id);
  if (!appState.logs[date]) appState.logs[date] = [];
  const now = new Date();
  const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const catId = czCategoryToId(meal.category);
  (meal.items || []).forEach((it) => {
    appState.logs[date].push({
      id: Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
      time: timeStr,
      name: it.name,
      amount: it.amount || '100g',
      calories: Math.round(Number(it.calories) || 0),
      protein: Math.round((Number(it.protein) || 0) * 10) / 10,
      carbs: Math.round((Number(it.carbs) || 0) * 10) / 10,
      fat: Math.round((Number(it.fat) || 0) * 10) / 10,
      category: catId,
      fromPlan: meal.id
    });
  });
}

// ---- Export jídelníčku jako text ----
function mealPlanAsText() {
  const g = appState.goals || {};
  const lines = [`Můj jídelníček — ${g.calories} kcal, B ${g.protein} g, S ${g.carbs} g, T ${g.fat} g`, ''];
  PLAN_DAY_KEYS.forEach((k) => {
    const meals = getMealsForDay(k);
    if (!meals.length) return;
    const t = dayTotals(k);
    lines.push(`${PLAN_DAY_CZ[k]} (${Math.round(t.calories)} kcal):`);
    meals.forEach((m) => {
      lines.push(`  ${m.category}: ${m.name} — ${m.calories} kcal`);
      (m.items || []).forEach((i) => lines.push(`    · ${i.name} ${i.amount}`));
    });
    lines.push('');
  });
  return lines.join('\n');
}

async function shareMealPlan() {
  const text = mealPlanAsText();
  try {
    if (navigator.share) {
      await navigator.share({ title: 'Můj jídelníček', text });
      return;
    }
    await navigator.clipboard.writeText(text);
    showToast('Jídelníček zkopírován ✓');
  } catch (e) {
    if (e && e.name === 'AbortError') return; // user dismissed the share sheet
    showToast('Nepodařilo se sdílet');
  }
}

function initShoppingHandlers() {
  const modal = document.getElementById('shopping-modal');
  const closeBtn = document.getElementById('shopping-close');
  const clearBtn = document.getElementById('shopping-clear');
  if (closeBtn) closeBtn.addEventListener('click', () => modal.classList.remove('active'));
  if (modal) modal.addEventListener('click', (e) => { if (e.target === modal) modal.classList.remove('active'); });
  if (clearBtn) clearBtn.addEventListener('click', () => {
    appState.shoppingBought = [];
    saveState();
    openShoppingList();
  });
}

// ==========================================================================
// LOGOVÁNÍ VAH U CVIKŮ — progressive overload
// ==========================================================================
// History is keyed by the NORMALISED EXERCISE NAME, not by the exercise id.
// The coach regenerates the workout plan (and with it every exercise id)
// whenever it rebuilds a day, so an id-keyed history would be wiped on the
// first "přegeneruj mi trénink". Names survive that.

function normalizeExerciseName(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')  // strip diacritics
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function getExerciseLogs() {
  if (!appState.exerciseLogs || typeof appState.exerciseLogs !== 'object') {
    appState.exerciseLogs = {};
  }
  return appState.exerciseLogs;
}

// All sessions for an exercise, newest first.
function getExerciseHistory(name) {
  const entry = getExerciseLogs()[normalizeExerciseName(name)];
  if (!entry || !Array.isArray(entry.sessions)) return [];
  return entry.sessions.slice().sort((a, b) => b.date.localeCompare(a.date));
}

// The most recent session BEFORE the given date (so today's own entry doesn't
// become its own "last time").
function getLastExerciseSession(name, beforeDate) {
  const hist = getExerciseHistory(name);
  if (!beforeDate) return hist[0] || null;
  return hist.find((s) => s.date < beforeDate) || null;
}

function getSessionForDate(name, date) {
  return getExerciseHistory(name).find((s) => s.date === date) || null;
}

// Total volume of a session: Σ weight × reps.
function sessionVolume(session) {
  if (!session || !Array.isArray(session.sets)) return 0;
  return session.sets.reduce((s, x) => s + (Number(x.w) || 0) * (Number(x.r) || 0), 0);
}

// Heaviest set of a session (the number people actually track).
function sessionTopSet(session) {
  if (!session || !Array.isArray(session.sets) || !session.sets.length) return null;
  return session.sets.reduce((best, x) =>
    (Number(x.w) || 0) > (Number(best.w) || 0) ? x : best, session.sets[0]);
}

function formatSet(set) {
  if (!set) return '';
  const w = Number(set.w) || 0;
  const r = Number(set.r) || 0;
  const wTxt = Number.isInteger(w) ? String(w) : String(w).replace('.', ',');
  return `${wTxt} kg × ${r}`;
}

// Write (or overwrite) one day's sets for an exercise. Empty sets clear the day.
function logExerciseSession(name, date, sets) {
  const logs = getExerciseLogs();
  const key = normalizeExerciseName(name);
  if (!key) return;
  if (!logs[key]) logs[key] = { name, sessions: [] };
  logs[key].name = name; // keep the prettiest spelling we have seen

  const clean = (sets || [])
    .map((s) => ({ w: Math.round((Number(s.w) || 0) * 10) / 10, r: Math.round(Number(s.r) || 0) }))
    .filter((s) => s.w > 0 && s.r > 0);

  logs[key].sessions = logs[key].sessions.filter((s) => s.date !== date);
  if (clean.length) logs[key].sessions.push({ date, sets: clean });
  logs[key].sessions.sort((a, b) => a.date.localeCompare(b.date));
  // A year of history per exercise is plenty and keeps the blob small.
  if (logs[key].sessions.length > 200) {
    logs[key].sessions = logs[key].sessions.slice(-200);
  }
  saveState();
}

// Is the exercise stalled? True when the top-set weight hasn't improved across
// the last `n` sessions (and there are at least that many).
function isExerciseStalled(name, n = 3) {
  const hist = getExerciseHistory(name).slice(0, n);
  if (hist.length < n) return false;
  const weights = hist.map((s) => { const t = sessionTopSet(s); return t ? Number(t.w) || 0 : 0; });
  return Math.max(...weights) <= weights[weights.length - 1];
}

// Suggest the next top set: nudge up when the last session hit its rep target.
function suggestNextLoad(name, targetReps) {
  const last = getLastExerciseSession(name);
  const top = sessionTopSet(last);
  if (!top) return null;
  const w = Number(top.w) || 0;
  const r = Number(top.r) || 0;
  // "8-12" → 12 ; "5" → 5
  const goal = parseInt(String(targetReps || '').split(/[-–]/).pop(), 10);
  if (!goal || r < goal) return null;
  const step = w >= 60 ? 5 : 2.5;
  return Math.round((w + step) * 10) / 10;
}

// Compact history for the coach's context: last 5 sessions per exercise.
function buildExerciseContext() {
  const logs = getExerciseLogs();
  const out = [];
  Object.keys(logs).forEach((key) => {
    const entry = logs[key];
    if (!entry || !Array.isArray(entry.sessions) || !entry.sessions.length) return;
    const recent = entry.sessions.slice(-5).reverse().map((s) => ({
      date: s.date,
      sets: s.sets.map((x) => `${x.w}kg×${x.r}`).join(', '),
      volume: Math.round(sessionVolume(s)),
      top: formatSet(sessionTopSet(s))
    }));
    out.push({ name: entry.name, stalled: isExerciseStalled(entry.name), recent });
  });
  return out.slice(0, 25);
}

// ---- Detail cviku: graf vývoje váhy + objem ----

// Inline SVG line chart of top-set weight over time, with volume bars behind.
// Inline so it works under the app's CSP with no charting library.
function exerciseChartSvg(sessions) {
  const W = 320, H = 130, padL = 30, padR = 8, padT = 12, padB = 22;
  const pts = sessions.map((s) => ({
    date: s.date,
    w: Number((sessionTopSet(s) || {}).w) || 0,
    vol: sessionVolume(s)
  }));
  if (pts.length < 2) return '';

  const ws = pts.map((p) => p.w);
  const minW = Math.min(...ws);
  const maxW = Math.max(...ws);
  const span = (maxW - minW) || 1;
  const lo = minW - span * 0.15;
  const hi = maxW + span * 0.15;
  const maxVol = Math.max(...pts.map((p) => p.vol)) || 1;

  const x = (i) => padL + (i * (W - padL - padR)) / (pts.length - 1);
  const y = (v) => padT + (1 - (v - lo) / (hi - lo)) * (H - padT - padB);

  const bars = pts.map((p, i) => {
    const bw = Math.max(4, (W - padL - padR) / pts.length * 0.42);
    const bh = (p.vol / maxVol) * (H - padT - padB) * 0.55;
    return `<rect x="${(x(i) - bw / 2).toFixed(1)}" y="${(H - padB - bh).toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" rx="2" fill="rgba(255,255,255,0.10)"/>`;
  }).join('');

  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.w).toFixed(1)}`).join(' ');
  const dots = pts.map((p, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(p.w).toFixed(1)}" r="3.2" fill="#fff"/>`).join('');

  const fmtDate = (d) => { const [, m, dd] = d.split('-'); return `${Number(dd)}.${Number(m)}.`; };
  const labels = [0, pts.length - 1].map((i) =>
    `<text x="${x(i).toFixed(1)}" y="${H - 6}" fill="rgba(255,255,255,0.4)" font-size="9" text-anchor="${i === 0 ? 'start' : 'end'}">${fmtDate(pts[i].date)}</text>`
  ).join('');
  const yLabels = [maxW, minW].map((v) =>
    `<text x="2" y="${(y(v) + 3).toFixed(1)}" fill="rgba(255,255,255,0.4)" font-size="9">${String(v).replace('.', ',')}</text>`
  ).join('');

  return `<svg class="ex-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Vývoj váhy v čase">
    ${bars}
    <path d="${line}" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    ${dots}${labels}${yLabels}
  </svg>`;
}

function openExerciseDetail(name) {
  const modal = document.getElementById('exercise-modal');
  const body = document.getElementById('exercise-body');
  const title = document.getElementById('exercise-title');
  if (!modal || !body) return;

  const hist = getExerciseHistory(name);          // newest first
  const chrono = hist.slice().reverse();          // oldest first, for the chart
  if (title) title.textContent = name;

  if (!hist.length) {
    body.innerHTML = '<div class="plan-empty-sub" style="padding:24px 0;text-align:center;">Zatím žádná data</div>';
    modal.classList.add('active');
    return;
  }

  const best = hist.reduce((b, s) => {
    const t = sessionTopSet(s);
    return (t && (!b || t.w > b.w)) ? t : b;
  }, null);
  const totalVol = hist.reduce((s, x) => s + sessionVolume(x), 0);
  const first = sessionTopSet(chrono[0]);
  const latest = sessionTopSet(hist[0]);
  const gain = (first && latest) ? Math.round((latest.w - first.w) * 10) / 10 : 0;

  body.innerHTML = `
    <div class="ex-stats">
      <div class="ex-stat"><span class="ex-stat-label">Osobák</span><span class="ex-stat-val">${best ? formatSet(best) : '—'}</span></div>
      <div class="ex-stat"><span class="ex-stat-label">Naposledy</span><span class="ex-stat-val">${latest ? formatSet(latest) : '—'}</span></div>
      <div class="ex-stat"><span class="ex-stat-label">Tréninků</span><span class="ex-stat-val">${hist.length}</span></div>
      <div class="ex-stat"><span class="ex-stat-label">Celkový objem</span><span class="ex-stat-val">${Math.round(totalVol).toLocaleString('cs-CZ')} kg</span></div>
    </div>
    ${gain !== 0 ? `<div class="ex-gain ${gain > 0 ? 'up' : 'down'}">${gain > 0 ? '+' : ''}${String(gain).replace('.', ',')} kg od začátku</div>` : ''}
    ${isExerciseStalled(name) ? '<div class="plan-drift over">Váha se 3 tréninky nehnula — řekni si kouči o deload</div>' : ''}
    ${exerciseChartSvg(chrono)}
    <div class="ex-history">
      ${hist.slice(0, 12).map((s) => {
        const [y, m, d] = s.date.split('-');
        return `<div class="ex-hist-row">
          <span class="ex-hist-date">${Number(d)}.${Number(m)}.</span>
          <span class="ex-hist-sets">${s.sets.map((x) => `${String(x.w).replace('.', ',')}×${x.r}`).join(' · ')}</span>
          <span class="ex-hist-vol">${Math.round(sessionVolume(s))} kg</span>
        </div>`;
      }).join('')}
    </div>
    <button class="mc-btn secondary" id="ex-ask-coach" type="button">Zeptat se kouče na progres</button>`;

  const ask = document.getElementById('ex-ask-coach');
  if (ask) ask.addEventListener('click', () => {
    modal.classList.remove('active');
    askCoach(`jak mi roste ${name} za poslední měsíc a co mám dělat dál?`);
  });

  modal.classList.add('active');
}

function initExerciseDetailHandlers() {
  const modal = document.getElementById('exercise-modal');
  const closeBtn = document.getElementById('exercise-close');
  if (closeBtn) closeBtn.addEventListener('click', () => modal.classList.remove('active'));
  if (modal) modal.addEventListener('click', (e) => { if (e.target === modal) modal.classList.remove('active'); });
}

// ==========================================================================
// PLNÝ SNÍMEK APPKY PRO KOUČE
// ==========================================================================
// The coach used to only see today's food, so it asked things it could have
// looked up ("kolik kalorií ti chybí do cíle?"). This hands it everything the
// app knows, as compact summaries rather than raw state.

// Per-day rollup for the last `days` days: what was eaten, whether the plan
// was followed, and whether a workout happened.
function buildDayHistory(days = 14) {
  const out = [];
  const goal = (appState.goals && appState.goals.calories) || 0;
  for (let i = 0; i < days; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const date = getDateString(d);
    const items = appState.logs[date] || [];
    if (!items.length && !(appState.workoutLogs && appState.workoutLogs[date])) continue;

    const t = items.reduce((s, x) => ({
      calories: s.calories + (Number(x.calories) || 0),
      protein: s.protein + (Number(x.protein) || 0),
      carbs: s.carbs + (Number(x.carbs) || 0),
      fat: s.fat + (Number(x.fat) || 0)
    }), { calories: 0, protein: 0, carbs: 0, fat: 0 });

    const wl = (appState.workoutLogs && appState.workoutLogs[date]) || null;
    const dayKey = dayKeyForDateStr(date);
    const planned = getWorkoutForDay(dayKey);
    const plannedCount = planned && !planned.rest ? planned.exercises.length : 0;

    out.push({
      date,
      calories: Math.round(t.calories),
      protein: Math.round(t.protein),
      carbs: Math.round(t.carbs),
      fat: Math.round(t.fat),
      goalCalories: goal,
      items: items.length,
      trainedExercises: wl ? wl.done.length : 0,
      plannedExercises: plannedCount,
      water: Math.round(((appState.water && appState.water[date]) || 0) * 100) / 100
    });
  }
  return out;
}

// Consecutive days (ending today or yesterday) with at least one logged item.
function loggingStreak() {
  let streak = 0;
  for (let i = 0; i < 400; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const items = appState.logs[getDateString(d)] || [];
    if (items.length) { streak++; continue; }
    if (i === 0) continue; // today may simply not have started yet
    break;
  }
  return streak;
}

function trainingStreakDays() {
  const logs = appState.workoutLogs || {};
  return Object.keys(logs).filter((d) => (logs[d].done || []).length).length;
}

// How much of the planned menu the user actually ticked off, last 7 days.
function planAdherence7d() {
  let planned = 0, eaten = 0;
  for (let i = 0; i < 7; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const date = getDateString(d);
    const meals = getMealsForDay(dayKeyForDateStr(date));
    if (!meals.length) continue;
    planned += meals.length;
    const checks = (appState.mealChecks && appState.mealChecks[date]) || [];
    eaten += meals.filter((m) => checks.includes(m.id)).length;
  }
  return planned ? Math.round((eaten / planned) * 100) : null;
}

function buildAppSnapshot() {
  const history = buildDayHistory(14);
  const logged = history.filter((h) => h.items > 0);
  const avg = (key) => logged.length
    ? Math.round(logged.reduce((s, h) => s + h[key], 0) / logged.length)
    : 0;

  const weights = (appState.weightLogs || [])
    .slice()
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 10)
    .map((w) => ({ date: w.date, weight: w.weight }));

  const todayStr = getTodayDateString();
  const water7 = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(); d.setDate(d.getDate() - i);
    water7.push((appState.water && appState.water[getDateString(d)]) || 0);
  }

  return {
    today: todayStr,
    daysWithData: history.length,
    history,
    averages: { calories: avg('calories'), protein: avg('protein'), carbs: avg('carbs'), fat: avg('fat') },
    weight: {
      current: appState.weight,
      target: appState.weightTarget,
      recent: weights
    },
    water: {
      today: Math.round(((appState.water && appState.water[todayStr]) || 0) * 100) / 100,
      avg7: Math.round((water7.reduce((s, x) => s + x, 0) / 7) * 100) / 100
    },
    favorites: (appState.favorites || []).slice(0, 30).map((f) => f.name).filter(Boolean),
    knownFoods: getKnownFoods(40).map((f) => f.name).filter(Boolean),
    streaks: { loggingDays: loggingStreak(), workoutsLogged: trainingStreakDays() },
    planAdherence7d: planAdherence7d(),
    lockedMeals: getMealLocks().length,
    shoppingListSize: buildShoppingList().length
  };
}

// ==========================================================================
// DOMLUVA S KOUČEM U KONKRÉTNÍHO JÍDLA
// ==========================================================================
// A small chat bound to one meal, so the user doesn't have to explain which
// meal they mean. Reused in two places: as its own sheet from the meal card,
// and embedded inside the "Sedí to?" verdict.

let mealChat = null; // { meal, dayKey, messages: [], verdict, photo, container }

const MEAL_CHAT_CHIPS = [
  { label: 'nesnědl jsem to', local: 'untick' },
  { label: 'změň gramáž' },
  { label: 'vyměň za jiné' },
  { label: 'míň kalorií' },
  { label: 'víc bílkovin' }
];

function mealChatContextLine() {
  if (!mealChat) return '';
  const { meal, dayKey, verdict } = mealChat;
  const parts = [
    `Jídlo: ${meal.category} — ${meal.name} (${PLAN_DAY_CZ[dayKey]})`,
    `Plán: ${meal.calories} kcal, B ${meal.protein} g, S ${meal.carbs} g, T ${meal.fat} g`,
    `Suroviny: ${(meal.items || []).map((i) => `${i.name} ${i.amount}`).join(', ')}`,
    `ID jídla pro nástroje: ${meal.id}`
  ];
  if (verdict) {
    const t = verdict.total || {};
    parts.push(`Z fotky talíře: ${Math.round(t.calories || 0)} kcal, B ${Math.round(t.protein || 0)} g — verdikt „${verdict.verdict}", rada „${verdict.advice || ''}"`);
    if ((verdict.detected || []).length) {
      parts.push(`Na talíři: ${verdict.detected.map((d) => `${d.name} ${d.amount}`).join(', ')}`);
    }
  }
  return parts.join('\n');
}

function renderMealChatMessages() {
  if (!mealChat) return;
  const box = mealChat.container.querySelector('.mchat-messages');
  if (!box) return;
  box.innerHTML = '';
  mealChat.messages.forEach((m) => {
    m.text.split(/\s*\|\|\|\s*/).filter(Boolean).forEach((part) => {
      const el = document.createElement('div');
      el.className = `coach-bubble ${m.role}`;
      el.innerHTML = formatCoachText(part.trim());
      box.appendChild(el);
    });
  });
  box.scrollTop = box.scrollHeight;
}

// Build the chat UI into any container. Works standalone or embedded.
function mountMealChat(container, ctx) {
  mealChat = {
    meal: ctx.meal,
    dayKey: ctx.dayKey,
    verdict: ctx.verdict || null,
    photo: ctx.photo || null,
    messages: [],
    container
  };

  container.innerHTML = `
    <div class="mchat">
      <div class="mchat-chips">
        ${MEAL_CHAT_CHIPS.map((c, i) => `<button class="mchat-chip" data-i="${i}" type="button">${c.label}</button>`).join('')}
      </div>
      <div class="mchat-messages"></div>
      <div class="mchat-input-row">
        <input type="text" class="mchat-input" placeholder="napiš, co s tím…" autocomplete="off">
        <button class="mchat-send" type="button" aria-label="Odeslat">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>
        </button>
      </div>
    </div>`;

  container.querySelectorAll('.mchat-chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      const chip = MEAL_CHAT_CHIPS[Number(btn.getAttribute('data-i'))];
      if (chip.local === 'untick') {
        untickMealFromChat();
        return;
      }
      sendMealChatMessage(chip.label);
    });
  });

  const input = container.querySelector('.mchat-input');
  const send = container.querySelector('.mchat-send');
  if (send) send.addEventListener('click', () => sendMealChatMessage(input.value.trim()));
  if (input) {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); sendMealChatMessage(input.value.trim()); }
    });
  }
}

// "nesnědl jsem to" has an immediate local effect — undo the tick and pull the
// items back out of the diary — and then asks the coach what to do instead.
function untickMealFromChat() {
  if (!mealChat) return;
  const { meal } = mealChat;
  const date = getTodayDateString();
  const checks = getMealChecks(date);
  const i = checks.indexOf(meal.id);
  const wasTicked = i !== -1;
  if (wasTicked) checks.splice(i, 1);
  appState.logs[date] = (appState.logs[date] || []).filter((x) => x.fromPlan !== meal.id);
  saveState();
  renderDashboard();
  renderPlanScreen();
  appendMealChatBubble(wasTicked ? 'ok, odškrtnuto a smazáno z deníku' : 'ok, beru že jsi to nejedl', 'assistant');
  sendMealChatMessage('tohle jídlo jsem nesnědl, co s tím mám udělat se zbytkem dne?', { silent: true });
}

function appendMealChatBubble(text, role) {
  if (!mealChat) return;
  mealChat.messages.push({ role, text });
  renderMealChatMessages();
}

async function sendMealChatMessage(text, opts = {}) {
  if (!mealChat || !text) return;
  const container = mealChat.container;
  const input = container.querySelector('.mchat-input');
  const send = container.querySelector('.mchat-send');
  if (input) input.value = '';
  if (send) send.disabled = true;

  if (!opts.silent) appendMealChatBubble(text, 'user');

  const typing = document.createElement('div');
  typing.className = 'coach-bubble assistant typing';
  typing.textContent = 'Píše…';
  const box = container.querySelector('.mchat-messages');
  if (box) { box.appendChild(typing); box.scrollTop = box.scrollHeight; }

  try {
    const payload = buildCoachPayload(text, {
      history: mealChat.messages.slice(0, -1).slice(-10)
    });
    payload.focus = {
      kind: 'meal',
      mealId: mealChat.meal.id,
      day: mealChat.dayKey,
      summary: mealChatContextLine()
    };
    const data = await callCoachAPI(payload);
    typing.remove();

    if (data && data.success && data.reply) {
      if (data.planChanged) {
        applyCoachPlanUpdate(data);
        // The meal object we hold may have been replaced by the coach.
        const fresh = getMealsForDay(mealChat.dayKey).find((m) => m.id === mealChat.meal.id);
        if (fresh) mealChat.meal = fresh;
        showToast('Plán upraven ✓');
      }
      appendMealChatBubble(String(data.reply), 'assistant');
      if (data.action && typeof data.action === 'object') {
        renderMealChatAction(data.action);
      }
      if (data.newMiniAppId) {
        renderMiniAppChatCard(data.newMiniAppId, mealChat.container.querySelector('.mchat-messages'));
      }
    } else {
      appendMealChatBubble((data && data.error) || 'sorry, zkus to ještě jednou', 'assistant');
    }
  } catch (e) {
    typing.remove();
    appendMealChatBubble(e.message || 'spojení vypadlo, zkus to znovu', 'assistant');
  } finally {
    if (send) send.disabled = false;
    if (input) input.focus();
  }
}

// Food-diary changes still need a yes/no, same as in the main coach chat.
function renderMealChatAction(action) {
  if (!mealChat) return;
  const box = mealChat.container.querySelector('.mchat-messages');
  if (!box) return;
  const card = document.createElement('div');
  card.className = 'coach-action-card';
  card.innerHTML = `
    <div class="coach-action-summary">${describeCoachAction(action)}</div>
    <div class="coach-action-buttons">
      <button class="coach-action-btn cancel" type="button">✕ Zrušit</button>
      <button class="coach-action-btn confirm" type="button">✓ Potvrdit</button>
    </div>`;
  const [no, yes] = card.querySelectorAll('.coach-action-btn');
  yes.addEventListener('click', () => {
    const result = executeCoachAction(action);
    saveState();
    renderDashboard();
    renderPlanScreen();
    card.remove();
    appendMealChatBubble(`done, ${result.toLowerCase()}`, 'assistant');
    showToast('Hotovo ✓');
  });
  no.addEventListener('click', () => {
    card.remove();
    appendMealChatBubble('ok, nechávám to bejt', 'assistant');
  });
  box.appendChild(card);
  box.scrollTop = box.scrollHeight;
}

// ---- Standalone sheet from the meal card ----

function openMealChatSheet(meal, dayKey) {
  const modal = document.getElementById('meal-chat-modal');
  const head = document.getElementById('meal-chat-head');
  const body = document.getElementById('meal-chat-body');
  if (!modal || !body) return;

  if (head) {
    head.innerHTML = `
      <div class="mchat-meal">
        <div class="mchat-meal-cat">${meal.category} · ${PLAN_DAY_CZ[dayKey]}</div>
        <div class="mchat-meal-name">${meal.name}</div>
        <div class="mchat-meal-macros">${meal.calories} kcal · B ${meal.protein} g · S ${meal.carbs} g · T ${meal.fat} g</div>
      </div>`;
  }
  mountMealChat(body, { meal, dayKey });
  modal.classList.add('active');
  setTimeout(() => {
    const i = body.querySelector('.mchat-input');
    if (i) i.focus();
  }, 250);
}

function closeMealChatSheet() {
  const modal = document.getElementById('meal-chat-modal');
  if (modal) modal.classList.remove('active');
  mealChat = null;
}

function initMealChatHandlers() {
  const modal = document.getElementById('meal-chat-modal');
  const closeBtn = document.getElementById('meal-chat-close');
  if (closeBtn) closeBtn.addEventListener('click', closeMealChatSheet);
  if (modal) modal.addEventListener('click', (e) => { if (e.target === modal) closeMealChatSheet(); });
}

// ==========================================================================
// MINI APPKY OD KOUČE
// ==========================================================================
// The coach can build a small purpose-made screen for a situation the plan
// doesn't cover (restaurant tonight, a trip, a party). It sends a declarative
// spec — never code — and this renders it with the app's own components.

function getMiniApps() {
  if (!Array.isArray(appState.miniApps)) appState.miniApps = [];
  if (appState.activeSession === undefined) appState.activeSession = null;
  if (!Array.isArray(appState.sessionHistory)) appState.sessionHistory = [];
  return appState.miniApps;
}

function findMiniApp(id) {
  return getMiniApps().find((a) => a.id === id) || null;
}

function deleteMiniApp(id) {
  appState.miniApps = getMiniApps().filter((a) => a.id !== id);
  saveState();
  renderDashboard();
}

function miniAppRelativeTime(ts) {
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 1) return 'právě teď';
  if (mins < 60) return `před ${mins} min`;
  const h = Math.round(mins / 60);
  if (h < 24) return `před ${h} h`;
  const d = Math.round(h / 24);
  return d === 1 ? 'včera' : `před ${d} dny`;
}

// ---- Rendering ----

function renderMiniAppBlock(block, app) {
  const el = document.createElement('div');

  if (block.type === 'html') {
    return renderMiniAppHtmlBlock(block);
  }

  if (block.type === 'info') {
    el.className = 'ma-info';
    el.innerHTML = `${block.title ? `<div class="ma-block-title">${block.title}</div>` : ''}
      <div class="ma-info-text">${block.text}</div>`;
    return el;
  }

  if (block.type === 'stats') {
    el.className = 'ma-stats-wrap';
    el.innerHTML = `${block.title ? `<div class="ma-block-title">${block.title}</div>` : ''}
      <div class="ma-stats">${block.items.map((i) => `
        <div class="ma-stat">
          <span class="ma-stat-label">${i.label}</span>
          <span class="ma-stat-value">${i.value}</span>
          ${i.sub ? `<span class="ma-stat-sub">${i.sub}</span>` : ''}
        </div>`).join('')}</div>`;
    return el;
  }

  if (block.type === 'checklist') {
    el.className = 'ma-checklist-wrap';
    el.innerHTML = `${block.title ? `<div class="ma-block-title">${block.title}</div>` : ''}
      <div class="ma-checklist"></div>`;
    const list = el.querySelector('.ma-checklist');
    block.items.forEach((item) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'ma-check-row' + (item.done ? ' done' : '');
      row.innerHTML = `<span class="ma-check-box">${item.done ? '✓' : ''}</span><span class="ma-check-label">${item.label}</span>`;
      row.addEventListener('click', () => {
        item.done = !item.done;
        saveState();
        row.classList.toggle('done', item.done);
        row.querySelector('.ma-check-box').textContent = item.done ? '✓' : '';
      });
      list.appendChild(row);
    });
    return el;
  }

  if (block.type === 'options') {
    el.className = 'ma-options-wrap';
    el.innerHTML = `${block.title ? `<div class="ma-block-title">${block.title}</div>` : ''}
      ${block.note ? `<div class="ma-block-note">${block.note}</div>` : ''}
      <div class="ma-options"></div>`;
    const list = el.querySelector('.ma-options');

    block.options.forEach((opt) => {
      const card = document.createElement('div');
      card.className = 'ma-option' + (opt.recommended ? ' recommended' : '');
      card.innerHTML = `
        <div class="ma-option-head">
          <div class="ma-option-titles">
            ${opt.tag ? `<span class="ma-option-tag">${opt.tag}</span>` : ''}
            <div class="ma-option-name">${opt.name}</div>
            ${opt.description ? `<div class="ma-option-desc">${opt.description}</div>` : ''}
          </div>
          ${opt.loggable ? `<div class="ma-option-kcal">${opt.calories}<span>kcal</span></div>` : ''}
        </div>
        ${opt.loggable ? `<div class="ma-option-macros">B ${opt.protein} g · S ${opt.carbs} g · T ${opt.fat} g${opt.amount ? ' · ' + opt.amount : ''}</div>` : ''}
        <div class="ma-option-btns">
          ${opt.loggable ? '<button class="ma-option-btn primary" data-act="log" type="button">Zapsat do deníku</button>' : ''}
          <button class="ma-option-btn" data-act="ask" type="button">Zeptat se kouče</button>
        </div>`;

      card.querySelectorAll('.ma-option-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          if (btn.getAttribute('data-act') === 'log') logMiniAppOption(opt);
          else {
            closeMiniApp();
            askCoach(`k té appce „${app.title}" — co si myslíš o „${opt.name}"?`);
          }
        });
      });
      list.appendChild(card);
    });
    return el;
  }

  return el;
}

// One tap logs a picked option straight into today's diary.
function logMiniAppOption(opt) {
  const date = getTodayDateString();
  if (!appState.logs[date]) appState.logs[date] = [];
  const now = new Date();
  appState.logs[date].push({
    id: Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
    time: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
    name: opt.name,
    amount: opt.amount || '1 porce',
    calories: Math.round(Number(opt.calories) || 0),
    protein: Math.round((Number(opt.protein) || 0) * 10) / 10,
    carbs: Math.round((Number(opt.carbs) || 0) * 10) / 10,
    fat: Math.round((Number(opt.fat) || 0) * 10) / 10,
    category: guessMealCategoryByTime()
  });
  saveState();
  renderDashboard();
  showToast(`${opt.name} zapsáno ✓`);
}

function openMiniApp(id) {
  const app = findMiniApp(id);
  const modal = document.getElementById('miniapp-modal');
  const body = document.getElementById('miniapp-body');
  const head = document.getElementById('miniapp-head');
  if (!app || !modal || !body) return;

  if (head) {
    // Say plainly where the numbers came from. An app built without a web
    // lookup is the coach's guess, and the user deserves to know that before
    // trusting a menu's calories.
    const sources = Array.isArray(app.sources) ? app.sources : [];
    const badge = app.estimated === false
      ? `<span class="ma-badge verified">ověřeno na webu</span>`
      : `<span class="ma-badge estimate">hodnoty jsou odhad</span>`;
    head.innerHTML = `
      <div class="ma-hero">
        <div class="ma-hero-icon">${app.icon}</div>
        <div class="ma-hero-text">
          <div class="ma-hero-title">${app.title}</div>
          ${app.subtitle ? `<div class="ma-hero-sub">${app.subtitle}</div>` : ''}
          <div class="ma-hero-badges">${badge}</div>
        </div>
      </div>
      ${sources.length ? `<div class="ma-sources">
        <span class="ma-sources-label">Zdroje</span>
        ${sources.map((x) => `<a class="ma-source" href="${x.uri}" target="_blank" rel="noopener noreferrer">${x.title || 'odkaz'}</a>`).join('')}
      </div>` : ''}`;
  }

  detachMiniAppFrames();
  body.innerHTML = '';
  app.blocks.forEach((b) => body.appendChild(renderMiniAppBlock(b, app)));

  const footer = document.createElement('div');
  footer.className = 'ma-footer';
  footer.innerHTML = `
    <button class="mc-btn secondary" id="ma-change" type="button">Chci to jinak</button>
    <button class="ma-delete" id="ma-delete" type="button">Smazat appku</button>`;
  body.appendChild(footer);

  document.getElementById('ma-change').addEventListener('click', () => {
    closeMiniApp();
    askCoach(`uprav mi appku „${app.title}" (id: ${app.id})`);
  });
  document.getElementById('ma-delete').addEventListener('click', () => {
    if (!confirm(`Smazat appku „${app.title}"?`)) return;
    deleteMiniApp(app.id);
    closeMiniApp();
    showToast('Appka smazána');
  });

  modal.classList.add('active');
}

function closeMiniApp() {
  const modal = document.getElementById('miniapp-modal');
  if (modal) modal.classList.remove('active');
  detachMiniAppFrames();
}

// Each HTML block registers a window message listener; drop them when its
// markup goes away, otherwise reopening apps piles listeners up.
function detachMiniAppFrames() {
  const body = document.getElementById('miniapp-body');
  if (!body) return;
  body.querySelectorAll('.ma-html-wrap').forEach((w) => {
    if (typeof w._detach === 'function') w._detach();
  });
}

// Cards on the dashboard — these are situational and usually about today.
function renderMiniAppCards() {
  const wrap = document.getElementById('dash-miniapps');
  if (!wrap) return;
  const apps = getMiniApps();
  if (!apps.length) { wrap.innerHTML = ''; return; }

  wrap.innerHTML = `
    <div class="dash-section-label">Appky od kouče</div>
    <div class="ma-card-row">${apps.slice(0, 6).map((a) => `
      <button class="ma-card" type="button" data-id="${a.id}">
        <span class="ma-card-icon">${a.icon}</span>
        <span class="ma-card-title">${a.title}</span>
        <span class="ma-card-time">${miniAppRelativeTime(a.updatedAt)}</span>
      </button>`).join('')}</div>`;

  wrap.querySelectorAll('.ma-card').forEach((el) => {
    el.addEventListener('click', () => openMiniApp(el.getAttribute('data-id')));
  });
}

// A card in the coach chat right after one is built.
function renderMiniAppChatCard(id, container) {
  const app = findMiniApp(id);
  const box = container || document.getElementById('coach-messages');
  if (!app || !box) return;
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'ma-chat-card';
  card.innerHTML = `
    <span class="ma-chat-icon">${app.icon}</span>
    <span class="ma-chat-text">
      <span class="ma-chat-title">${app.title}</span>
      <span class="ma-chat-sub">${app.subtitle || 'appka je hotová'}</span>
    </span>
    <span class="ma-chat-open">Otevřít</span>`;
  card.addEventListener('click', () => openMiniApp(app.id));
  box.appendChild(card);
  box.scrollTop = box.scrollHeight;
}

function initMiniAppHandlers() {
  const modal = document.getElementById('miniapp-modal');
  const closeBtn = document.getElementById('miniapp-close');
  if (closeBtn) closeBtn.addEventListener('click', closeMiniApp);
  if (modal) modal.addEventListener('click', (e) => { if (e.target === modal) closeMiniApp(); });
}

// ==========================================================================
// VLASTNÍ HTML BLOK V MINI APPCE
// ==========================================================================
// The coach sometimes needs a layout the four fixed block types can't express.
// It may then write plain HTML + CSS, which renders inside a sandboxed iframe.
//
// Why an iframe and not innerHTML: the sandbox has NO allow-same-origin, so the
// frame runs in an opaque origin and cannot reach the app's DOM, localStorage
// or session. On top of that the markup is stripped of <script> and on*
// handlers server-side, and a CSP inside the frame blocks every external load.
// The only script that runs in there is the bootstrap below, written by us.

// The app's look, handed to the frame so coach-authored markup matches the rest
// of the UI instead of inventing its own colours.
const MINIAPP_FRAME_CSS = `
:root{
  --bg-app:#000;--bg-card:#0E0E10;--bg-elevated:#131315;--bg-elevated-2:#1B1B1E;--bg-elevated-3:#26262A;
  --text-1:#fff;--text-2:rgba(255,255,255,.62);--text-3:rgba(255,255,255,.40);
  --sep:rgba(255,255,255,.09);--sep-strong:rgba(255,255,255,.17);--red:#FF453A;
  --r-lg:24px;--r-md:16px;--r-pill:100px;
}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
body{
  margin:0;background:transparent;color:var(--text-1);
  font-family:-apple-system,BlinkMacSystemFont,'SF Pro Display','Inter',system-ui,sans-serif;
  font-size:15px;line-height:1.45;
}
.card{background:var(--bg-card);border:.5px solid var(--sep);border-radius:var(--r-lg);padding:14px;margin-bottom:10px}
.card.hi{border-color:rgba(255,255,255,.45)}
.row{display:flex;align-items:center;gap:12px}
.row.between{justify-content:space-between}
.col{display:flex;flex-direction:column;gap:4px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:9px}
.grid.g3{grid-template-columns:1fr 1fr 1fr}
.title{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.7px;color:var(--text-3);margin-bottom:9px}
.name{font-size:15.5px;font-weight:700;letter-spacing:-.2px}
.muted{font-size:13px;color:var(--text-3);line-height:1.4}
.big{font-size:20px;font-weight:800;letter-spacing:-.5px;font-variant-numeric:tabular-nums}
.pill{display:inline-block;font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.6px;
  padding:3px 9px;border-radius:var(--r-pill);background:linear-gradient(180deg,#fff,#D9D9D9);color:#000}
.pill.dim{background:rgba(255,255,255,.07);color:var(--text-2);border:.5px solid var(--sep-strong)}
.bar{height:5px;border-radius:3px;background:rgba(255,255,255,.08);overflow:hidden;margin-top:8px}
.bar>i{display:block;height:100%;border-radius:3px;background:linear-gradient(90deg,#fff,#C7C7C7)}
.btn{display:block;width:100%;margin-top:12px;padding:11px;border-radius:11px;border:.5px solid var(--sep-strong);
  background:transparent;color:var(--text-2);font:inherit;font-size:13.5px;font-weight:650;cursor:pointer}
.btn.primary{background:linear-gradient(180deg,#fff,#DCDCDC);border-color:transparent;color:#000;font-weight:700}
.btn:active{transform:scale(.98)}
hr{border:0;border-top:.5px solid var(--sep);margin:14px 0}
a{color:var(--text-1)}
`;

// Runs inside the frame. Reports height so the iframe can size itself, and
// forwards taps on [data-log-name] up to the app. Nothing else.
const MINIAPP_FRAME_JS = `
(function(){
  function post(m){ parent.postMessage(m,'*'); }
  function height(){ post({t:'h', h: Math.ceil(document.documentElement.scrollHeight)}); }
  new ResizeObserver(height).observe(document.documentElement);
  addEventListener('load', height); height();
  addEventListener('click', function(e){
    var el = e.target.closest('[data-log-name]');
    if(!el) return;
    post({ t:'log', food:{
      name: el.getAttribute('data-log-name'),
      amount: el.getAttribute('data-log-amount') || '',
      calories: el.getAttribute('data-log-calories'),
      protein: el.getAttribute('data-log-protein'),
      carbs: el.getAttribute('data-log-carbs'),
      fat: el.getAttribute('data-log-fat')
    }});
    el.textContent = 'zapsáno ✓';
    el.setAttribute('disabled','');
  });
})();
`;

function buildMiniAppFrameDoc(block) {
  // The CSP is what stops the frame reaching the network at all. Combined with
  // the missing allow-same-origin, there is nowhere for data to leak to.
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; font-src data:">
<style>${MINIAPP_FRAME_CSS}${block.css || ''}</style>
</head><body>${block.html}<script>${MINIAPP_FRAME_JS}<\/script></body></html>`;
}

function renderMiniAppHtmlBlock(block) {
  const wrap = document.createElement('div');
  wrap.className = 'ma-html-wrap';
  if (block.title) {
    const t = document.createElement('div');
    t.className = 'ma-block-title';
    t.textContent = block.title;
    wrap.appendChild(t);
  }

  const frame = document.createElement('iframe');
  frame.className = 'ma-html-frame';
  // No allow-same-origin: the frame gets an opaque origin and stays walled off.
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.setAttribute('referrerpolicy', 'no-referrer');
  frame.setAttribute('loading', 'lazy');
  frame.srcdoc = buildMiniAppFrameDoc(block);
  wrap.appendChild(frame);

  const onMessage = (e) => {
    // Origin is "null" for a sandboxed frame, so identity comes from the source
    // window — that is the only thing that can't be spoofed by another frame.
    if (e.source !== frame.contentWindow) return;
    const msg = e.data;
    if (!msg || typeof msg !== 'object') return;

    if (msg.t === 'h') {
      const h = Number(msg.h);
      if (Number.isFinite(h) && h > 0) frame.style.height = Math.min(h + 4, 2000) + 'px';
      return;
    }
    if (msg.t === 'log' && msg.food && msg.food.name) {
      const f = msg.food;
      logMiniAppOption({
        name: String(f.name).slice(0, 90),
        amount: String(f.amount || '1 porce').slice(0, 30),
        calories: Number(f.calories) || 0,
        protein: Number(f.protein) || 0,
        carbs: Number(f.carbs) || 0,
        fat: Number(f.fat) || 0
      });
    }
  };
  window.addEventListener('message', onMessage);
  // Dropped along with the modal contents; keep a handle so it can be removed.
  wrap._detach = () => window.removeEventListener('message', onMessage);

  return wrap;
}

// ==========================================================================
// ŽIVÝ TRÉNINK — session s časovačem, sériemi a koučem u toho
// ==========================================================================
// Everything time-related is stored as an absolute timestamp, never as a
// counted-down number. iOS suspends timers the moment the screen locks or the
// app goes to background, so a counter would silently drift; a timestamp is
// still correct whenever the user comes back.

let sessionTick = null;      // 1s render loop
let sessionCountdown = null; // 3-2-1 before the start
let coachPingTimer = null;

const SESSION_COACH_MIN_GAP = 100000; // ≥100 s between proactive coach pings

function getSession_() { return appState.activeSession || null; }

function hasActiveSession() {
  const s = getSession_();
  return !!(s && !s.endedAt);
}

function newSessionFromDay(dayKey) {
  const w = getWorkoutForDay(dayKey);
  if (!w || w.rest || !w.exercises.length) return null;
  return {
    id: 'ses_' + Date.now().toString(36),
    date: getTodayDateString(),
    dayKey,
    title: w.title,
    startedAt: Date.now(),
    endedAt: null,
    pausedAt: null,
    pausedTotal: 0,
    idx: 0,
    restEndsAt: null,
    restTotal: 0,
    exercises: w.exercises.map((e) => ({
      id: e.id, name: e.name, targetSets: e.sets, targetReps: e.reps,
      restSec: e.restSec, note: e.note || '', sets: []
    })),
    messages: [],
    lastPing: 0
  };
}

function sessionElapsedMs() {
  const s = getSession_();
  if (!s) return 0;
  const end = s.endedAt || (s.pausedAt || Date.now());
  return Math.max(0, end - s.startedAt - (s.pausedTotal || 0));
}

// Haptics, but only when the browser will actually allow it. Chrome logs an
// intervention warning if vibrate() is called before the page has ever been
// tapped, and that log can't be caught — so check user activation first rather
// than spamming the console on desktop and in tests.
function buzz(pattern) {
  try {
    if (!navigator.vibrate) return;
    const ua = navigator.userActivation;
    if (ua && !ua.hasBeenActive) return;
    navigator.vibrate(pattern);
  } catch (e) { /* no haptics available */ }
}

function fmtClock(ms) {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const sec = total % 60;
  const h = Math.floor(m / 60);
  return h > 0
    ? `${h}:${String(m % 60).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
    : `${m}:${String(sec).padStart(2, '0')}`;
}

function sessionCurrentExercise() {
  const s = getSession_();
  return s ? s.exercises[s.idx] || null : null;
}

function sessionTotals() {
  const s = getSession_();
  if (!s) return { sets: 0, volume: 0, done: 0 };
  let sets = 0, volume = 0, done = 0;
  s.exercises.forEach((e) => {
    sets += e.sets.length;
    e.sets.forEach((x) => { volume += (Number(x.w) || 0) * (Number(x.r) || 0); });
    if (e.sets.length >= e.targetSets) done++;
  });
  return { sets, volume: Math.round(volume), done };
}

// ---- Lifecycle ----

function startWorkoutSession(dayKey) {
  if (hasActiveSession() && !confirm('Máš rozdělaný trénink. Zahodit ho a začít nový?')) return;
  const s = newSessionFromDay(dayKey);
  if (!s) { showToast('Na tenhle den není trénink'); return; }

  appState.activeSession = s;
  saveState();
  requestWakeLock();

  const overlay = document.getElementById('session-overlay');
  if (overlay) overlay.classList.add('active');
  document.body.style.overflow = 'hidden';
  runSessionCountdown();
}

function runSessionCountdown() {
  const el = document.getElementById('session-countdown');
  const view = document.getElementById('session-view');
  if (!el || !view) return;
  view.style.display = 'none';
  el.style.display = 'flex';

  let n = 3;
  const paint = () => {
    el.innerHTML = `<div class="sc-num">${n > 0 ? n : 'JEDEM'}</div>`;
  };
  paint();
  clearInterval(sessionCountdown);
  sessionCountdown = setInterval(() => {
    n--;
    if (n < 0) {
      clearInterval(sessionCountdown);
      el.style.display = 'none';
      view.style.display = 'flex';
      // The clock only really starts once the countdown is done.
      const s = getSession_();
      if (s) { s.startedAt = Date.now(); saveState(); }
      startSessionTick();
      pingSessionCoach('start');
      return;
    }
    paint();
  }, 800);
}

function startSessionTick() {
  clearInterval(sessionTick);
  sessionTick = setInterval(renderSessionClock, 1000);
  renderSession();
}

function togglePauseSession() {
  const s = getSession_();
  if (!s) return;
  if (s.pausedAt) {
    s.pausedTotal = (s.pausedTotal || 0) + (Date.now() - s.pausedAt);
    s.pausedAt = null;
  } else {
    s.pausedAt = Date.now();
  }
  saveState();
  renderSession();
}

function finishWorkoutSession() {
  const s = getSession_();
  if (!s) return;
  const t = sessionTotals();
  if (!t.sets && !confirm('Nezapsal jsi ani sérii. Fakt ukončit?')) return;

  s.endedAt = Date.now();
  const durationMs = sessionElapsedMs(); // capture before the session is cleared

  // Fold the session into the permanent per-exercise history and mark the
  // day's exercises done, so the plan screen and the coach both see it.
  const log = getWorkoutLog(s.date);
  s.exercises.forEach((e) => {
    if (!e.sets.length) return;
    logExerciseSession(e.name, s.date, e.sets.map((x) => ({ w: x.w, r: x.r })));
    if (!log.done.includes(e.id)) log.done.push(e.id);
  });

  if (!Array.isArray(appState.sessionHistory)) appState.sessionHistory = [];
  appState.sessionHistory.unshift({
    id: s.id, date: s.date, title: s.title,
    durationMs, sets: t.sets, volume: t.volume,
    exercises: s.exercises.filter((e) => e.sets.length).map((e) => ({ name: e.name, sets: e.sets }))
  });
  if (appState.sessionHistory.length > 60) appState.sessionHistory.length = 60;

  appState.activeSession = null;
  saveState();
  closeSessionOverlay();
  renderPlanScreen();
  renderDashboard();
  showToast(`Trénink hotov · ${fmtClock(durationMs)} · ${t.sets} sérií`);
}

function closeSessionOverlay() {
  clearInterval(sessionTick);
  clearInterval(sessionCountdown);
  clearTimeout(coachPingTimer);
  const overlay = document.getElementById('session-overlay');
  if (overlay) overlay.classList.remove('active');
  document.body.style.overflow = '';
}

function resumeSessionIfAny() {
  if (!hasActiveSession()) return;
  const overlay = document.getElementById('session-overlay');
  const cd = document.getElementById('session-countdown');
  const view = document.getElementById('session-view');
  if (!overlay) return;
  overlay.classList.add('active');
  document.body.style.overflow = 'hidden';
  if (cd) cd.style.display = 'none';
  if (view) view.style.display = 'flex';
  requestWakeLock();
  startSessionTick();
}

// ---- Rendering ----

// Cheap 1s update: only the numbers that actually move.
function renderSessionClock() {
  const s = getSession_();
  if (!s) return;
  const clock = document.getElementById('ses-clock');
  if (clock) clock.textContent = fmtClock(sessionElapsedMs());

  const rest = document.getElementById('ses-rest');
  if (!rest) return;
  if (s.restEndsAt) {
    const left = s.restEndsAt - Date.now();
    if (left <= 0) {
      s.restEndsAt = null;
      saveState();
      rest.style.display = 'none';
      buzz([120, 60, 120]);
      showToast('Pauza je pryč, jedem');
      pingSessionCoach('rest_over');
    } else {
      rest.style.display = 'flex';
      const el = document.getElementById('ses-rest-num');
      if (el) el.textContent = Math.ceil(left / 1000) + 's';
    }
  } else {
    rest.style.display = 'none';
  }
}

function renderSession() {
  const s = getSession_();
  if (!s) return;
  const ex = sessionCurrentExercise();
  const t = sessionTotals();

  const head = document.getElementById('ses-head');
  if (head) {
    head.innerHTML = `
      <div class="ses-top">
        <button class="ses-icon-btn" id="ses-pause" type="button">${s.pausedAt ? '▶' : '❚❚'}</button>
        <div class="ses-clock-wrap">
          <div class="ses-clock" id="ses-clock">${fmtClock(sessionElapsedMs())}</div>
          <div class="ses-sub">${s.title} · ${t.done}/${s.exercises.length} cviků · ${t.sets} sérií</div>
        </div>
        <button class="ses-icon-btn" id="ses-close" type="button">✕</button>
      </div>`;
    document.getElementById('ses-pause').addEventListener('click', togglePauseSession);
    document.getElementById('ses-close').addEventListener('click', () => {
      if (confirm('Nechat trénink běžet na pozadí?')) { closeSessionOverlay(); return; }
      finishWorkoutSession();
    });
  }

  const body = document.getElementById('ses-body');
  if (!body || !ex) return;

  const last = getLastExerciseSession(ex.name, s.date);
  const lastTop = sessionTopSet(last);
  const prev = ex.sets.length ? ex.sets[ex.sets.length - 1] : (last && last.sets[ex.sets.length]) || lastTop;

  body.innerHTML = `
    <div class="ses-exnav">
      <button class="ses-nav-btn" id="ses-prev" type="button" ${s.idx === 0 ? 'disabled' : ''}>‹</button>
      <div class="ses-exname">
        <div class="ses-exname-t">${ex.name}</div>
        <div class="ses-exname-s">${ex.targetSets} × ${ex.targetReps}${lastTop ? ' · minule ' + formatSet(lastTop) : ''}</div>
      </div>
      <button class="ses-nav-btn" id="ses-next" type="button" ${s.idx >= s.exercises.length - 1 ? 'disabled' : ''}>›</button>
    </div>

    <div class="ses-setlist">
      ${ex.sets.map((x, i) => `<div class="ses-set done"><span>${i + 1}.</span><b>${x.w} kg × ${x.r}</b><span class="ses-set-vol">${Math.round(x.w * x.r)} kg</span></div>`).join('')}
      ${ex.sets.length < 20 ? `
      <div class="ses-set input">
        <span>${ex.sets.length + 1}.</span>
        <input id="ses-w" type="number" inputmode="decimal" step="0.5" min="0" placeholder="kg" value="${prev ? prev.w : ''}">
        <span class="ses-x">×</span>
        <input id="ses-r" type="number" inputmode="numeric" step="1" min="0" placeholder="op." value="${prev ? prev.r : ''}">
        <button class="ses-add" id="ses-add" type="button">✓</button>
      </div>` : ''}
    </div>

    <div class="ses-actions">
      <button class="ses-action" id="ses-skiprest" type="button">Přeskočit pauzu</button>
      <button class="ses-action primary" id="ses-finish" type="button">Ukončit trénink</button>
    </div>`;

  document.getElementById('ses-prev').addEventListener('click', () => moveExercise(-1));
  document.getElementById('ses-next').addEventListener('click', () => moveExercise(1));
  const add = document.getElementById('ses-add');
  if (add) add.addEventListener('click', logSessionSet);
  document.getElementById('ses-skiprest').addEventListener('click', () => {
    const cur = getSession_();
    if (cur) { cur.restEndsAt = null; saveState(); renderSessionClock(); }
  });
  document.getElementById('ses-finish').addEventListener('click', finishWorkoutSession);

  renderSessionClock();
}

function moveExercise(delta) {
  const s = getSession_();
  if (!s) return;
  const next = s.idx + delta;
  if (next < 0 || next >= s.exercises.length) return;
  s.idx = next;
  saveState();
  renderSession();
  pingSessionCoach('exercise_change');
}

function logSessionSet() {
  const s = getSession_();
  const ex = sessionCurrentExercise();
  if (!s || !ex) return;
  const w = parseFloat(String(document.getElementById('ses-w').value).replace(',', '.'));
  const r = parseInt(document.getElementById('ses-r').value, 10);
  if (!(w > 0) || !(r > 0)) { showToast('Vyplň váhu i opakování'); return; }

  ex.sets.push({ w: Math.round(w * 10) / 10, r, at: Date.now() });
  s.restEndsAt = Date.now() + (ex.restSec || 90) * 1000;
  s.restTotal = (s.restTotal || 0) + (ex.restSec || 90);
  saveState();
  buzz(40);
  renderSession();
  pingSessionCoach('set_logged');
}

// ---- Kouč u tréninku ----

function sessionContextForCoach() {
  const s = getSession_();
  if (!s) return null;
  const ex = sessionCurrentExercise();
  const t = sessionTotals();
  return {
    title: s.title,
    elapsed: fmtClock(sessionElapsedMs()),
    currentExercise: ex ? {
      name: ex.name, target: `${ex.targetSets} × ${ex.targetReps}`,
      setsDone: ex.sets.map((x) => `${x.w}kg×${x.r}`),
      restSec: ex.restSec,
      lastTime: (() => { const l = sessionTopSet(getLastExerciseSession(ex.name, s.date)); return l ? formatSet(l) : null; })()
    } : null,
    progress: `${t.done}/${s.exercises.length} cviků, ${t.sets} sérií, objem ${t.volume} kg`,
    remaining: s.exercises.slice(s.idx + 1).map((e) => e.name),
    resting: !!s.restEndsAt
  };
}

function appendSessionMessage(text, role) {
  const s = getSession_();
  if (!s) return;
  s.messages.push({ role, text, ts: Date.now() });
  if (s.messages.length > 60) s.messages = s.messages.slice(-60);
  saveState();
  renderSessionChat();
}

function renderSessionChat() {
  const s = getSession_();
  const box = document.getElementById('ses-chat-msgs');
  if (!s || !box) return;
  box.innerHTML = '';
  s.messages.slice(-20).forEach((m) => {
    m.text.split(/\s*\|\|\|\s*/).filter(Boolean).forEach((part) => {
      const el = document.createElement('div');
      el.className = `coach-bubble ${m.role}`;
      el.innerHTML = formatCoachText(part.trim());
      box.appendChild(el);
    });
  });
  box.scrollTop = box.scrollHeight;

  const badge = document.getElementById('ses-chat-badge');
  if (badge) {
    const unread = s.messages.length && s.messages[s.messages.length - 1].role === 'assistant' && !isSessionChatOpen();
    badge.style.display = unread ? 'block' : 'none';
  }
}

function isSessionChatOpen() {
  const p = document.getElementById('ses-chat');
  return !!(p && p.classList.contains('open'));
}

function toggleSessionChat() {
  const p = document.getElementById('ses-chat');
  if (!p) return;
  p.classList.toggle('open');
  if (p.classList.contains('open')) {
    renderSessionChat();
    const i = document.getElementById('ses-chat-input');
    if (i) setTimeout(() => i.focus(), 200);
  }
}

// Proactive nudge. Rate-limited, and the coach may answer with the sentinel
// [nic] to stay quiet — a spotter who comments on every single set is noise.
async function pingSessionCoach(trigger) {
  const s = getSession_();
  if (!s || s.endedAt) return;
  if (trigger !== 'user' && Date.now() - (s.lastPing || 0) < SESSION_COACH_MIN_GAP) return;
  s.lastPing = Date.now();

  try {
    const payload = buildCoachPayload(`(trénink běží — událost: ${trigger})`, {
      mode: 'workout',
      history: s.messages.slice(-8)
    });
    payload.session = sessionContextForCoach();
    payload.proactive = true;
    const data = await callCoachAPI(payload);
    const cur = getSession_();
    if (!cur || cur.endedAt) return;
    if (data && data.success && data.reply) {
      const txt = String(data.reply).trim();
      if (/^\[?nic\]?$/i.test(txt)) return; // coach chose silence
      appendSessionMessage(txt, 'assistant');
      if (!isSessionChatOpen()) showToast('Kouč něco poslal');
    }
  } catch (e) { /* a missed nudge is not worth bothering the user about */ }
}

async function sendSessionChatMessage() {
  const input = document.getElementById('ses-chat-input');
  const s = getSession_();
  if (!input || !s) return;
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  appendSessionMessage(text, 'user');

  const box = document.getElementById('ses-chat-msgs');
  const typing = document.createElement('div');
  typing.className = 'coach-bubble assistant typing';
  typing.textContent = 'Píše…';
  if (box) { box.appendChild(typing); box.scrollTop = box.scrollHeight; }

  try {
    const payload = buildCoachPayload(text, { mode: 'workout', history: s.messages.slice(0, -1).slice(-10) });
    payload.session = sessionContextForCoach();
    const data = await callCoachAPI(payload);
    typing.remove();
    appendSessionMessage((data && data.reply) || 'sorry, zkus to ještě jednou', 'assistant');
    if (data && data.planChanged) applyCoachPlanUpdate(data);
  } catch (e) {
    typing.remove();
    appendSessionMessage('spojení vypadlo', 'assistant');
  }
}

function initSessionHandlers() {
  const send = document.getElementById('ses-chat-send');
  const input = document.getElementById('ses-chat-input');
  const toggle = document.getElementById('ses-chat-toggle');
  const close = document.getElementById('ses-chat-close');
  if (send) send.addEventListener('click', sendSessionChatMessage);
  if (input) input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); sendSessionChatMessage(); }
  });
  if (toggle) toggle.addEventListener('click', toggleSessionChat);
  if (close) close.addEventListener('click', toggleSessionChat);

  // Coming back from a locked screen: repaint from timestamps immediately.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && hasActiveSession()) { renderSessionClock(); requestWakeLock(); }
  });
}
