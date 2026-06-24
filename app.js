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
    coachMemoryEnabled: true
  };
  saveState();
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
      if (hour >= 10 && hour < 12) return 'Morning snack';
      if (hour >= 12 && hour < 15) return 'Lunch';
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
  if (hour >= 10 && hour < 12) return 'Morning snack';
  if (hour >= 12 && hour < 15) return 'Lunch';
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

  const choicesList  = document.getElementById('fls-choices-list');
  const choicesThumb = document.getElementById('fls-choices-thumb');
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
    if (hour >= 10 && hour < 12) return 'Morning snack';
    if (hour >= 12 && hour < 15) return 'Lunch';
    if (hour >= 15 && hour < 18) return 'Afternoon snack';
    if (hour >= 18 && hour < 22) return 'Dinner';
    return 'Second dinner';
  }

  let flsPhotoBase64 = null;
  let flsItems = [];
  let flsChoices = [];
  let flsPresetCategory = null;  // přednastavená kategorie (z tlačítka u konkrétního jídla)
  let flsPickedCategory = null;  // kategorie vybraná uživatelem po skenu

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
      <div class="fls-detected-header-thumb"></div>
      <div style="flex:1;">
        <div style="font-size:13px; font-weight:700; color:#34D399; display:flex; align-items:center; gap:5px;">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#34D399" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
          Rozpoznáno ${count} ${word}
        </div>
        <div style="font-size:13px; font-weight:500; color:rgba(255,255,255,0.5); margin-top:2px;">${headerSub}</div>
      </div>`;

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

  function handleFile(file) {
    if (!file || !file.type.startsWith('image/')) return;
    const reader = new FileReader();
    reader.onload = e => handlePhoto(e.target.result);
    reader.readAsDataURL(file);
  }

  scrim.addEventListener('click', closeSheet);
  btnClose.addEventListener('click', closeSheet);
  shutter.addEventListener('click', () => camInput.click());
  btnGallery.addEventListener('click', () => galInput.click());
  btnBarcode.addEventListener('click', () => {
    closeSheet();
    document.getElementById('btn-wizard-scan-barcode')?.click();
  });
  camInput.addEventListener('change', e => handleFile(e.target.files[0]));
  galInput.addEventListener('change', e => handleFile(e.target.files[0]));
  document.getElementById('fls-btn-save').addEventListener('click', saveItems);

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
        } else if (targetScreenId === 'screen-history') {
          showHistoryTab(tabType || 'meals');
          renderHistory();
        } else if (targetScreenId === 'screen-settings') {
          renderSettings();
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

  // Shrink the photo before sending it through the backend proxy.
  if (imageBase64) {
    imageBase64 = await downscaleImage(imageBase64, 1024, 0.8);
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

3. Pokud uživatel nahrál OBRÁZEK (volitelně doplněný textem), pečlivě odhadni, co je na fotce a JAK VELKÁ je porce. Navrhni přesně 3 NEJPRAVDĚPODOBNĚJŠÍ varianty toho, co jídlo je (např. 1. odlehčená/zdravější verze, 2. standardní verze, 3. kaloričtější verze s omáčkou/olejem). U KAŽDÉ varianty odhadni hmotnost jednotlivých složek co nejpřesněji podle velikosti na fotce. Vrať JSON v tomto formátu (formát type "image_choices"):
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
      parts.push({ text: "Odhadni 3 nejčastější varianty jídla zobrazeného na fotce a rozepiš je podle pravidel." });
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

  // WHOOP Integration buttons
  const btnWhoopConnect = document.getElementById('btn-whoop-connect');
  const btnWhoopRefresh = document.getElementById('btn-whoop-refresh');
  const btnWhoopDisconnect = document.getElementById('btn-whoop-disconnect');

  if (btnWhoopConnect) {
    btnWhoopConnect.addEventListener('click', initiateWhoopAuth);
  }
  if (btnWhoopRefresh) {
    btnWhoopRefresh.addEventListener('click', refreshWhoopData);
  }
  if (btnWhoopDisconnect) {
    btnWhoopDisconnect.addEventListener('click', disconnectWhoop);
  }

  // Check WHOOP connection status
  checkWhoopStatus();

  // AI Coach chat
  initCoachHandlers();

  // Check if already logged in
  const session = getSession();
  if (session) {
    showAppAfterLogin();
    // Background cloud sync
    syncFromCloud();
    // If we just returned from the WHOOP OAuth flow, jump to Settings.
    const params = new URLSearchParams(window.location.search);
    if (params.get('screen') === 'settings' && window.switchAppScreen) {
      window.switchAppScreen('screen-settings');
      history.replaceState(null, '', '/');
    }
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
  const answer = prompt(
    `Kolik ${unit === 'ml' ? 'mililitrů (ml)' : 'gramů (g)'} jsi snědl/a?`,
    `100${unit}`
  );
  // Uživatel zrušil → necháme předvyplněných 100 g/ml, nic se neloguje.
  if (answer === null) return;

  const trimmed = String(answer).trim();
  if (trimmed === '') return;

  const multiplier = getQuantityMultiplier(trimmed, unit);
  if (isNaN(multiplier) || multiplier <= 0) {
    alert('Neplatné množství – ponechávám 100' + unit + '.');
    return;
  }

  // Zapiš zadané množství a přepočítej hodnoty
  const parsed = parseQuantity(trimmed, unit);
  const setVal = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
  setVal('input-food-amount', `${parsed.value}${parsed.unit}`);
  setVal('input-food-cal', Math.round(currentFormBaseValues.calories * multiplier));
  setVal('input-food-p', Math.round(currentFormBaseValues.protein * multiplier * 10) / 10);
  setVal('input-food-c', Math.round(currentFormBaseValues.carbs * multiplier * 10) / 10);
  setVal('input-food-f', Math.round(currentFormBaseValues.fat * multiplier * 10) / 10);
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
        
        const newAmountStr = prompt(`Upravit množství pro: ${item.name}`, item.amount || '100g');
        if (newAmountStr !== null && newAmountStr.trim() !== '') {
          const oldParsed = parseQuantity(item.amount || '100g');
          const newParsed = parseQuantity(newAmountStr, oldParsed.unit);
          
          if (oldParsed.value > 0 && newParsed.value >= 0) {
            const ratio = newParsed.value / oldParsed.value;
            item.amount = newAmountStr.trim();
            if (item.original && item.leftovers && item.leftovers.length) {
              // Scale the original portion and every logged leftover, then
              // recompute the net so the breakdown stays consistent.
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
            showToast("Množství upraveno! ✏️");
          } else {
            alert("Neplatné množství.");
          }
        }
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
// WHOOP API INTEGRATION
// ==========================================================================

// Paint the WHOOP metrics card from the snapshot the server returns.
function renderWhoopMetrics(w) {
  const set = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  };
  const rec = w && w.recovery;
  const str = w && w.strain;
  const slp = w && w.sleep;

  set('whoop-recovery', rec && rec.recoveryScore != null ? `${rec.recoveryScore} %` : '—');
  set('whoop-hrv', rec && rec.hrvMs != null ? `${rec.hrvMs} ms` : '—');
  set('whoop-rhr', rec && rec.restingHeartRate != null ? `${rec.restingHeartRate} bpm` : '—');
  set('whoop-strain', str && str.strain != null ? `${str.strain}` : '—');
  set('whoop-burn', str && str.activeKcal != null ? `${str.activeKcal} kcal` : '—');
  set('whoop-sleep', slp && slp.totalInBedMs != null ? `${(slp.totalInBedMs / 3600000).toFixed(1)} h` : '—');
}

async function checkWhoopStatus() {
  try {
    const session = getSession();
    if (!session || !session.token) return;

    const response = await fetch('/api/whoop', {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${session.token}` }
    });
    const data = await response.json();

    const statusEl = document.getElementById('whoop-status');
    const metricsEl = document.getElementById('whoop-metrics');
    const connectBtn = document.getElementById('btn-whoop-connect');
    const refreshBtn = document.getElementById('btn-whoop-refresh');
    const disconnectBtn = document.getElementById('btn-whoop-disconnect');

    if (data.connected) {
      if (statusEl) statusEl.innerHTML = 'Stav: <strong style="color:var(--ios-green,#30D158);">Připojeno ✓</strong>';
      if (metricsEl) metricsEl.style.display = 'block';
      renderWhoopMetrics(data.data);
      if (connectBtn) connectBtn.style.display = 'none';
      if (refreshBtn) refreshBtn.style.display = 'block';
      if (disconnectBtn) disconnectBtn.style.display = 'block';
    } else {
      if (statusEl) statusEl.innerHTML = 'Stav: <strong style="color:var(--text-3);">Nepřipojeno</strong>';
      if (metricsEl) metricsEl.style.display = 'none';
      if (connectBtn) connectBtn.style.display = 'block';
      if (refreshBtn) refreshBtn.style.display = 'none';
      if (disconnectBtn) disconnectBtn.style.display = 'none';
      if (data.authUrl) window._whoopAuthUrl = data.authUrl;
    }
  } catch (error) {
    console.error('Error checking WHOOP status:', error);
  }
}

function initiateWhoopAuth() {
  const session = getSession();
  if (!session || !session.token) {
    showToast('Chyba: Nejste přihlášen');
    return;
  }
  // Persist the session token so the OAuth callback page can finish the exchange.
  localStorage.setItem('_fitai_session_token', session.token);

  if (window._whoopAuthUrl) {
    window.location.href = window._whoopAuthUrl;
  } else {
    showToast('Chyba: Nelze inicializovat WHOOP přihlášení');
  }
}

async function refreshWhoopData() {
  try {
    const session = getSession();
    if (!session || !session.token) {
      showToast('Chyba: Nejste přihlášen');
      return;
    }
    const response = await fetch('/api/whoop', {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${session.token}` }
    });
    const data = await response.json();

    if (data.connected) {
      renderWhoopMetrics(data.data);
      showToast('WHOOP data obnovena ✓');
    } else {
      showToast('WHOOP odpojen, připoj se prosím znovu');
      checkWhoopStatus();
    }
  } catch (error) {
    console.error('Error refreshing WHOOP data:', error);
    showToast('Chyba: ' + error.message);
  }
}

async function disconnectWhoop() {
  if (!confirm('Opravdu chcete odpojit WHOOP?')) return;
  try {
    const session = getSession();
    if (!session || !session.token) {
      showToast('Chyba: Nejste přihlášen');
      return;
    }
    const response = await fetch('/api/whoop', {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${session.token}` }
    });
    const data = await response.json();
    if (data.success) {
      showToast('WHOOP odpojena');
      checkWhoopStatus();
    } else {
      showToast('Chyba: ' + (data.error || 'Nepodařilo se odpojit'));
    }
  } catch (error) {
    console.error('Error disconnecting WHOOP:', error);
    showToast('Chyba: ' + error.message);
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
  box.innerHTML = `<div class="coach-empty">Ahoj! 👋 Jsem tvůj AI kouč.<br>Vidím tvá WHOOP data, jídla a kalorie.<br><br>Zeptej se mě třeba:<br>„Jak na tom dnes jsem?"<br>„Co bych měl sníst k večeři?"<br>„Mám dneska trénovat?"</div>`;
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

function appendCoachBubble(text, role, animate) {
  const box = document.getElementById('coach-messages');
  if (!box) return null;
  const empty = box.querySelector('.coach-empty');
  if (empty) empty.remove();
  const div = document.createElement('div');
  div.className = `coach-bubble ${role}`;
  // Assistant replies may contain markdown; render it. User text stays literal.
  if (role === 'assistant') {
    if (animate) {
      renderCoachLines(div, text, box);
    } else {
      div.innerHTML = formatCoachText(text);
    }
  } else {
    div.textContent = text;
  }
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
  return div;
}

// Build the food/calorie context for the currently viewed day.
function buildFoodContext() {
  const date = (typeof getViewingDate === 'function')
    ? getViewingDate()
    : (selectedDate || getTodayDateString());
  const items = (appState.logs[date] || []).map(i => ({
    name: i.name,
    amount: i.amount,
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
  if (!message) return;

  const session = getSession();
  if (!session || !session.token) {
    showToast('Chyba: Nejste přihlášen');
    return;
  }

  input.value = '';
  if (sendBtn) sendBtn.disabled = true;
  const memOn = coachMemoryOn();
  if (!activeCoachChat) newCoachChat();
  const chat = activeCoachChat;
  const isFirstMessage = chat.messages.length === 0;

  appendCoachBubble(message, 'user');
  chat.messages.push({ role: 'user', text: message });
  chat.updatedAt = Date.now();
  if (isFirstMessage) {
    chat.title = message.slice(0, 40);
    // Save the chat into the list on its first message (when memory is on).
    if (memOn && !getCoachChats().some((c) => c.id === chat.id)) {
      getCoachChats().unshift(chat);
    }
  }
  if (memOn) saveState(); // persist the question (local + cloud)

  const typing = appendCoachBubble('Píše…', 'assistant');
  if (typing) typing.classList.add('typing');

  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.token}`
      },
      body: JSON.stringify({
        message,
        // Send recent context from THIS chat (the backend trims further).
        history: chat.messages.slice(0, -1).slice(-20),
        // Manual facts the coach should always know (only when memory is on).
        memories: memOn ? getCoachMemories().map((m) => m.text) : [],
        foodContext: buildFoodContext()
      })
    });
    const data = await response.json();
    if (typing) typing.remove();

    if (data.success && data.reply) {
      appendCoachBubble(data.reply, 'assistant', true);
      chat.messages.push({ role: 'assistant', text: data.reply });
      chat.updatedAt = Date.now();
      // Cap a single chat so it can't grow without bound.
      if (chat.messages.length > 200) chat.messages = chat.messages.slice(-200);
      if (memOn) saveState(); // persist the reply (local + cloud)
    } else {
      appendCoachBubble(data.error || 'Promiň, něco se pokazilo. Zkus to znovu.', 'assistant');
    }
  } catch (error) {
    console.error('Coach error:', error);
    if (typing) typing.remove();
    appendCoachBubble('Chyba spojení. Zkontroluj připojení a zkus to znovu.', 'assistant');
  } finally {
    if (sendBtn) sendBtn.disabled = false;
    input.focus();
  }
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

  if (openBtn) openBtn.addEventListener('click', openCoach);
  if (navCoachBtn) navCoachBtn.addEventListener('click', openCoach);
  if (closeBtn) closeBtn.addEventListener('click', closeCoach);
  if (chatsBtn) chatsBtn.addEventListener('click', toggleCoachChatList);
  if (newChatBtn) newChatBtn.addEventListener('click', newCoachChat);
  if (chatlistScrim) chatlistScrim.addEventListener('click', hideCoachChatList);
  if (sendBtn) sendBtn.addEventListener('click', sendCoachMessage);
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
