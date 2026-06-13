// ==========================================================================
// CONFIGURATION & GLOBAL STATE
// ==========================================================================
const DEFAULT_API_KEY = "AQ.Ab8RN6JH3n55zajmZYJOXUfwQeGacIJLPAKJQkAdyTa1pmC_cg";

let appState = {
  apiKey: DEFAULT_API_KEY,
  goals: {
    calories: 2000,
    protein: 130,
    carbs: 220,
    fat: 65
  },
  logs: {} // Format: { "YYYY-MM-DD": [ { id, time, name, amount, calories, protein, carbs, fat }, ... ] }
};

// Temporary store for AI scanning review
let tempDetectedItems = [];
let currentPhotoBase64 = null;
let currentGeminiData = null; // Store full response from Gemini
let selectedOptionIndex = 0;  // Currently selected option index

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
      // Ensure the key is never lost and falls back to pre-filled if missing
      if (!appState.apiKey) {
        appState.apiKey = DEFAULT_API_KEY;
      }
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
    weightLogs: []
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

function updateCalendarRow() {
  const calendarRow = document.querySelector('.calendar-row');
  if (!calendarRow) return;
  
  const today = new Date();
  const currentDay = today.getDay(); // 0 = Sunday, 1 = Monday...
  const dayDiff = currentDay === 0 ? 6 : currentDay - 1;
  
  const monday = new Date(today);
  monday.setDate(today.getDate() - dayDiff);
  
  const dayLabels = ['Po', 'Út', 'St', 'Čt', 'Pá', 'So', 'Ne'];
  
  let html = '';
  
  for (let i = 0; i < 7; i++) {
    const dayDate = new Date(monday);
    dayDate.setDate(monday.getDate() + i);
    
    const dateStr = getDateString(dayDate);
    const dayNum = dayDate.getDate();
    
    const isToday = dayDate.getDate() === today.getDate() &&
                    dayDate.getMonth() === today.getMonth() &&
                    dayDate.getFullYear() === today.getFullYear();
                    
    if (isToday) {
      // Calculate today's eaten percent
      const todayFood = appState.logs[dateStr] || [];
      let todayCal = 0;
      todayFood.forEach(item => todayCal += Number(item.calories || 0));
      const goalCal = appState.goals.calories;
      const percent = Math.min(100, Math.round((todayCal / goalCal) * 100));
      const strokeDashoffset = 100 - percent;
      
      html += `
        <div class="cal-day current">
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
      const hasLogs = appState.logs[dateStr] && appState.logs[dateStr].length > 0;
      let circleClass = 'future';
      if (hasLogs) {
        // Calculate calories eaten
        let dayCal = 0;
        appState.logs[dateStr].forEach(item => dayCal += Number(item.calories || 0));
        if (dayCal > 0) {
          circleClass = 'active-goal';
        }
      }
      
      html += `
        <div class="cal-day">
          <span>${dayLabels[i]}</span>
          <div class="cal-circle ${circleClass}">${dayNum}</div>
        </div>`;
    }
  }
  
  calendarRow.innerHTML = html;
}

window.navigateToManualAddFood = function(categoryId) {
  // Find the fab and click it to go to screen-add
  const fab = document.querySelector('.nav-fab');
  if (fab) {
    fab.click();
  }
  
  // Find manual tab button and click it
  const manualTabBtn = document.getElementById('tab-btn-manual');
  if (manualTabBtn) {
    manualTabBtn.click();
  }
  
  // Set dropdown value
  const categorySelect = document.getElementById('input-food-category');
  if (categorySelect) {
    categorySelect.value = categoryId;
  }
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
  const todayStr = getTodayDateString();
  const todayFood = appState.logs[todayStr] || [];
  
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
  
  const goalCal = appState.goals.calories;
  const goalP = appState.goals.protein;
  const goalC = appState.goals.carbs;
  const goalF = appState.goals.fat;
  
  // Update Main Dashboard Stats
  document.getElementById('dash-eaten').innerText = `${totalCal} kcal`;
  document.getElementById('dash-current').innerText = totalCal;
  document.getElementById('dash-target').innerText = `/ ${goalCal} kcal`;
  
  const percent = Math.min(100, Math.round((totalCal / goalCal) * 100));
  document.getElementById('dash-percent').innerText = `${percent} %`;
  
  // Main Ring SVG Animation (circumference approx 534 for r=85)
  const ringPath = document.getElementById('dash-circle-path');
  const ringOffset = 534 - (534 * Math.min(1, totalCal / goalCal));
  ringPath.style.strokeDashoffset = ringOffset;
  
  if (totalCal > goalCal) {
    ringPath.style.stroke = "var(--color-danger)";
    document.getElementById('dash-percent').style.backgroundColor = "var(--color-danger)";
  } else {
    ringPath.style.stroke = "var(--color-calorie)";
    document.getElementById('dash-percent').style.backgroundColor = "var(--color-calorie)";
  }
  
  // Update Macros
  document.getElementById('val-p-current').innerText = `${totalP} g`;
  document.getElementById('val-p-target').innerText = `${goalP} g`;
  const pPct = Math.round((totalP / goalP) * 100);
  document.getElementById('val-p-pct').innerText = `${Math.min(100, pPct)} %`;
  document.getElementById('bar-p-fill').style.strokeDashoffset = 100 - Math.min(100, pPct);
  
  document.getElementById('val-c-current').innerText = `${totalC} g`;
  document.getElementById('val-c-target').innerText = `${goalC} g`;
  const cPct = Math.round((totalC / goalC) * 100);
  document.getElementById('val-c-pct').innerText = `${Math.min(100, cPct)} %`;
  document.getElementById('bar-c-fill').style.strokeDashoffset = 100 - Math.min(100, cPct);
  
  document.getElementById('val-f-current').innerText = `${totalF} g`;
  document.getElementById('val-f-target').innerText = `${goalF} g`;
  const fPct = Math.round((totalF / goalF) * 100);
  document.getElementById('val-f-pct').innerText = `${Math.min(100, fPct)} %`;
  document.getElementById('bar-f-fill').style.strokeDashoffset = 100 - Math.min(100, fPct);
  
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
    
    const catCard = document.createElement('div');
    catCard.className = 'meal-card category-header';
    
    catCard.innerHTML = `
      <div class="meal-left">
        <div class="meal-icon">${cat.icon}</div>
        <div class="meal-details">
          <span class="meal-name">${cat.name}</span>
          <span class="meal-macros">${macroStr}</span>
        </div>
      </div>
      <div class="meal-actions">
        <button class="btn-add-meal" onclick="window.navigateToManualAddFood('${cat.id}')">+</button>
      </div>`;
      
    foodListContainer.appendChild(catCard);
    
    // Now render items in this category
    catItems.forEach(item => {
      const subItem = document.createElement('div');
      subItem.className = 'meal-sub-item';
      
      const amountStr = item.amount ? ` • ${item.amount}` : '';
      
      subItem.innerHTML = `
        <div class="meal-sub-details">
          <span class="meal-sub-name">${item.name}</span>
          <span class="meal-sub-macros">${item.calories} kcal${amountStr} (B:${item.protein}g S:${item.carbs}g T:${item.fat}g)</span>
        </div>
        <button class="btn-delete-sub-food" data-id="${item.id}">×</button>`;
        
      foodListContainer.appendChild(subItem);
    });
  });
  
  // Add click listeners to delete buttons
  foodListContainer.querySelectorAll('.btn-delete-sub-food').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const foodId = e.target.getAttribute('data-id');
      deleteFoodItem(foodId);
    });
  });

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

function deleteFoodItem(id) {
  const todayStr = getTodayDateString();
  if (appState.logs[todayStr]) {
    const itemIndex = appState.logs[todayStr].findIndex(item => item.id === id);
    if (itemIndex !== -1) {
      const deletedName = appState.logs[todayStr][itemIndex].name;
      appState.logs[todayStr].splice(itemIndex, 1);
      
      // Clean up empty day lists
      if (appState.logs[todayStr].length === 0) {
        delete appState.logs[todayStr];
      }
      
      saveState();
      renderDashboard();
      showToast(`Smazáno: ${deletedName}`);
    }
  }
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
  document.getElementById('input-gemini-key').value = appState.apiKey || '';
  document.getElementById('input-goal-cal').value = appState.goals.calories || 2000;
  document.getElementById('input-goal-p').value = appState.goals.protein || 130;
  document.getElementById('input-goal-c').value = appState.goals.carbs || 220;
  document.getElementById('input-goal-f').value = appState.goals.fat || 65;
}

function saveSettingsFromUI() {
  const apiKey = document.getElementById('input-gemini-key').value.trim();
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
          // Pre-select category based on current time
          const now = new Date();
          const hour = now.getHours();
          let categoryId = 'Breakfast';
          if (hour >= 5 && hour < 10) categoryId = 'Breakfast';
          else if (hour >= 10 && hour < 12) categoryId = 'Morning snack';
          else if (hour >= 12 && hour < 15) categoryId = 'Lunch';
          else if (hour >= 15 && hour < 18) categoryId = 'Afternoon snack';
          else if (hour >= 18 && hour < 22) categoryId = 'Dinner';
          else categoryId = 'Second dinner';
          
          const categorySelect = document.getElementById('input-food-category');
          if (categorySelect) {
            categorySelect.value = categoryId;
          }
        }
      } else {
        screen.classList.remove('active');
      }
    });
  }

  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const screenAttr = tab.getAttribute('data-screen');
      if (screenAttr) {
        const tabType = tab.id === 'nav-progres' ? 'progress' : 'meals';
        switchScreen(`screen-${screenAttr}`, tabType);
      }
    });
  });
  
  // Floating Action Button Link
  if (fab) {
    fab.addEventListener('click', () => {
      switchScreen('screen-add');
    });
  }
  
  // Dashboard Quick Action Links
  const qaAdd = document.getElementById('qa-add');
  const qaCamera = document.getElementById('qa-camera');
  const qaMic = document.getElementById('qa-mic');
  
  if (qaAdd) qaAdd.addEventListener('click', () => switchScreen('screen-add'));
  if (qaCamera) qaCamera.addEventListener('click', () => {
    switchScreen('screen-add');
    const photoTrigger = document.getElementById('btn-photo-trigger');
    if (photoTrigger) photoTrigger.click();
  });
  if (qaMic) qaMic.addEventListener('click', () => {
    switchScreen('screen-add');
    document.getElementById('ai-text-input').focus();
  });

  // Inner sub-views of "Add Screen" (AI Scanner vs Manual)
  const aiTabBtn = document.getElementById('tab-btn-ai');
  const manualTabBtn = document.getElementById('tab-btn-manual');
  const aiSubView = document.getElementById('sub-view-ai');
  const manualSubView = document.getElementById('sub-view-manual');
  
  if (aiTabBtn && manualTabBtn) {
    aiTabBtn.addEventListener('click', () => {
      aiTabBtn.classList.add('active');
      manualTabBtn.classList.remove('active');
      aiSubView.classList.add('active');
      manualSubView.classList.remove('active');
    });
    
    manualTabBtn.addEventListener('click', () => {
      manualTabBtn.classList.add('active');
      aiTabBtn.classList.remove('active');
      manualSubView.classList.add('active');
      aiSubView.classList.remove('active');
    });
  }
  
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
function initPhotoHandlers() {
  const photoTrigger = document.getElementById('btn-photo-trigger');
  const cameraInput = document.getElementById('camera-input');
  const galleryInput = document.getElementById('gallery-input');
  
  const previewArea = document.getElementById('photo-preview-area');
  const previewImg = document.getElementById('photo-preview-img');
  const clearPhotoBtn = document.getElementById('btn-clear-photo');
  
  // Clicking the trigger opens gallery picker directly
  if (photoTrigger) {
    photoTrigger.addEventListener('click', () => {
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
    cameraInput.value = '';
    galleryInput.value = '';
  });
}

// ==========================================================================
// GEMINI AI SERVICE INTEGRATION
// ==========================================================================
async function callGeminiAPI(textPrompt, imageBase64) {
  if (!appState.apiKey) {
    throw new Error("Gemini API Key není nastaven. Zadej ho v Nastavení.");
  }
  
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${appState.apiKey}`;
  
  const systemInstructionText = `Jsi expert na výživu a nutriční hodnoty. Tvým úkolem je analyzovat vstup uživatele a vrátit strukturovaná data o jídlech a jejich nutričních hodnotách v přesném formátu JSON.

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

3. Pokud uživatel nahrál OBRÁZEK (volitelně doplněný textem), odhadni, co je na fotce. Protože z fotky nelze přesně určit suroviny, navrhni přesně 3 NEJPRAVDĚPODOBNĚJŠÍ varianty jídla (např. 1. odlehčená/zdravější verze, 2. standardní verze, 3. kaloričtější verze s omáčkou/olejem apod.). Vrať JSON v tomto formátu (formát type "image_choices"):
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

Pokud nelze jídlo vůbec identifikovat nebo je vstup nesmyslný, vrať prázdný text_result s nulovými hodnotami.`;

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
    
    parts.push({ text: "Odhadni 3 nejčastější varianty jídla zobrazeného na fotce a rozepiš je podle pravidel." });
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

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
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
    return JSON.parse(resultText.trim());
  } catch (e) {
    console.error("Neplatná JSON odpověď od Gemini: ", resultText);
    throw new Error("AI odpověď se nepodařilo zpracovat jako JSON.");
  }
}

// ==========================================================================
// AI REVIEW MODAL CONTROLS
// ==========================================================================
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
    tempDetectedItems = JSON.parse(JSON.stringify(geminiData.choices[0].items));
    
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
        tempDetectedItems = JSON.parse(JSON.stringify(geminiData.choices[index].items));
        
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
    tempDetectedItems = geminiData.items || [];
  }
  
  renderReviewModal();
  document.getElementById('ai-review-modal').classList.add('active');
}

function renderReviewModal() {
  const listContainer = document.getElementById('ai-detected-list');
  listContainer.innerHTML = '';
  
  let totalCal = 0;
  let totalP = 0;
  let totalC = 0;
  let totalF = 0;

  if (tempDetectedItems.length === 0) {
    listContainer.innerHTML = `<p class="empty-state">AI nerozpoznala žádná jídla. Zkus jiný popis/fotku.</p>`;
  } else {
    tempDetectedItems.forEach((item, index) => {
      totalCal += Number(item.calories || 0);
      totalP += Number(item.protein || 0);
      totalC += Number(item.carbs || 0);
      totalF += Number(item.fat || 0);

      const div = document.createElement('div');
      div.className = 'detected-item';
      div.innerHTML = `
        <div class="detected-item-left">
          <span class="detected-item-name">${item.name}</span>
          <span class="detected-item-amount">${item.amount || 'Neznámé množství'}</span>
          <span class="detected-item-macros">B: ${item.protein}g • S: ${item.carbs}g • T: ${item.fat}g</span>
        </div>
        <div class="detected-item-right">
          <span class="detected-item-cal">${item.calories} kcal</span>
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
  }

  // Update totals in Modal
  document.getElementById('modal-summary-cal').innerText = `${totalCal} kcal`;
  document.getElementById('modal-summary-p').innerText = Math.round(totalP * 10) / 10;
  document.getElementById('modal-summary-c').innerText = Math.round(totalC * 10) / 10;
  document.getElementById('modal-summary-f').innerText = Math.round(totalF * 10) / 10;
}

function saveReviewedItemsToLog() {
  if (tempDetectedItems.length === 0) {
    showToast("Žádná jídla k uložení.");
    closeModal();
    return;
  }
  
  const todayStr = getTodayDateString();
  if (!appState.logs[todayStr]) {
    appState.logs[todayStr] = [];
  }
  
  const now = new Date();
  const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  
  tempDetectedItems.forEach(item => {
    appState.logs[todayStr].push({
      id: Date.now() + Math.random().toString(36).substr(2, 5),
      time: timeStr,
      name: item.name,
      amount: item.amount || '',
      calories: Math.round(Number(item.calories || 0)),
      protein: Math.round(Number(item.protein || 0) * 10) / 10,
      carbs: Math.round(Number(item.carbs || 0) * 10) / 10,
      fat: Math.round(Number(item.fat || 0) * 10) / 10
    });
  });
  
  saveState();
  closeModal();
  
  // Reset fields in scanner view
  document.getElementById('ai-text-input').value = '';
  document.getElementById('btn-clear-photo').click();
  
  // Go to Dashboard
  const dashTab = document.querySelector('.nav-item[data-screen="dashboard"]');
  if (dashTab) dashTab.click();
  
  showToast(`${tempDetectedItems.length} jídel přidáno!`);
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
  
  // Handle Manual Log Submission
  manualForm.addEventListener('submit', (e) => {
    e.preventDefault();
    
    const name = document.getElementById('input-food-name').value.trim();
    const calories = parseInt(document.getElementById('input-food-cal').value) || 0;
    const category = document.getElementById('input-food-category').value;
    const amount = document.getElementById('input-food-amount').value.trim() || '';
    const protein = parseFloat(document.getElementById('input-food-p').value) || 0;
    const carbs = parseFloat(document.getElementById('input-food-c').value) || 0;
    const fat = parseFloat(document.getElementById('input-food-f').value) || 0;
    
    const todayStr = getTodayDateString();
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
    manualForm.reset();
    
    // Go to dashboard
    const dashTab = document.querySelector('.nav-item[data-screen="dashboard"]');
    if (dashTab) dashTab.click();
    
    showToast(`Přidáno: ${name}`);
  });
  
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
        if (cloudState.apiKey) appState.apiKey = cloudState.apiKey;
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

async function syncToCloud() {
  const session = getSession();
  if (!session) return;

  try {
    const dataToSync = {
      goals: appState.goals,
      logs: appState.logs,
      apiKey: appState.apiKey,
      water: appState.water,
      weight: appState.weight,
      weightTarget: appState.weightTarget,
      weightLogs: appState.weightLogs
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

  try {
    const resp = await fetch('/api/sync', {
      headers: { 'Authorization': `Bearer ${session.token}` }
    });
    const data = await resp.json();

    if (data.success && data.appData) {
      const cloudState = data.appData;
      if (cloudState.goals) appState.goals = cloudState.goals;
      if (cloudState.apiKey) appState.apiKey = cloudState.apiKey;
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
      
      saveState(true);
      renderDashboard();
      showToast('☁️ Data synchronizována z cloudu');
    }
  } catch (err) {
    console.error('Cloud load error:', err);
  }
}

function doLogout() {
  clearSession();
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
// APPLICATION INITIALIZATION
// ==========================================================================
function init() {
  loadState();
  updateDateLabels();
  initNavigation();
  initPhotoHandlers();
  initFormHandlers();
  initAuthHandlers();

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
  if (weightEditBtn) {
    weightEditBtn.addEventListener('click', () => {
      const currentVal = prompt("Zadej svou aktuální váhu (kg):", appState.weight);
      if (currentVal !== null) {
        const parsedCurrent = parseFloat(currentVal.replace(',', '.'));
        if (!isNaN(parsedCurrent) && parsedCurrent > 0) {
          appState.weight = parsedCurrent;
          
          const todayStr = getTodayDateString();
          appState.weightLogs = appState.weightLogs.filter(log => log.date !== todayStr);
          appState.weightLogs.push({ date: todayStr, weight: parsedCurrent });
          appState.weightLogs.sort((a, b) => b.date.localeCompare(a.date));

          const targetVal = prompt("Zadej svou cílovou váhu (kg):", appState.weightTarget);
          if (targetVal !== null) {
            const parsedTarget = parseFloat(targetVal.replace(',', '.'));
            if (!isNaN(parsedTarget) && parsedTarget > 0) {
              appState.weightTarget = parsedTarget;
            }
          }
          saveState();
          renderDashboard();
          showToast("Váha aktualizována! ⚖️");
        }
      }
    });
  }

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

// Run app init
window.addEventListener('DOMContentLoaded', init);
