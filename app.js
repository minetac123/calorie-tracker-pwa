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

// ==========================================================================
// STORAGE FUNCTIONS
// ==========================================================================
function saveState() {
  localStorage.setItem('fitai_state', JSON.stringify(appState));
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
    logs: {}
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
  toast.classList.add('active');
  setTimeout(() => {
    toast.classList.remove('active');
  }, 2500);
}

// ==========================================================================
// UI RENDERING - DASHBOARD
// ==========================================================================
function renderDashboard() {
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
  
  // Round macros to 1 decimal place
  totalP = Math.round(totalP * 10) / 10;
  totalC = Math.round(totalC * 10) / 10;
  totalF = Math.round(totalF * 10) / 10;
  
  // Goals
  const goalCal = appState.goals.calories;
  const goalP = appState.goals.protein;
  const goalC = appState.goals.carbs;
  const goalF = appState.goals.fat;
  
  // Calories Remaining Calculation
  const remainingCal = Math.max(0, goalCal - totalCal);
  document.getElementById('val-calories-remaining').innerText = remainingCal;
  document.getElementById('val-calories-stats').innerText = `Snězeno ${totalCal} z ${goalCal}`;
  
  // Animate SVG Circle Ring
  // Circumference = 502.65
  const progressRing = document.getElementById('progress-calories');
  const percent = Math.min(1, totalCal / goalCal);
  const offset = 502.65 * (1 - percent);
  progressRing.style.strokeDashoffset = offset;
  
  // Red color glow if budget is exceeded
  if (totalCal > goalCal) {
    progressRing.style.stroke = "var(--color-danger)";
  } else {
    progressRing.style.stroke = "var(--color-calorie)";
  }
  
  // Render Macro Bars
  document.getElementById('val-p-current').innerText = totalP;
  document.getElementById('val-p-target').innerText = goalP;
  const pPercent = Math.min(100, (totalP / goalP) * 100);
  document.getElementById('bar-p-fill').style.width = `${pPercent}%`;
  
  document.getElementById('val-c-current').innerText = totalC;
  document.getElementById('val-c-target').innerText = goalC;
  const cPercent = Math.min(100, (totalC / goalC) * 100);
  document.getElementById('bar-c-fill').style.width = `${cPercent}%`;
  
  document.getElementById('val-f-current').innerText = totalF;
  document.getElementById('val-f-target').innerText = goalF;
  const fPercent = Math.min(100, (totalF / goalF) * 100);
  document.getElementById('bar-f-fill').style.width = `${fPercent}%`;
  
  // Render Food Timeline List
  const foodListContainer = document.getElementById('food-list-today');
  foodListContainer.innerHTML = '';
  
  if (todayFood.length === 0) {
    foodListContainer.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🍳</div>
        <p>Zatím žádná jídla. Zkus jídlo vyfotit nebo popsat na záložce Záznam!</p>
      </div>`;
  } else {
    todayFood.forEach((item, index) => {
      const row = document.createElement('div');
      row.className = 'food-item-row';
      
      const amountStr = item.amount ? ` • ${item.amount}` : '';
      
      row.innerHTML = `
        <div class="food-details">
          <div class="food-name">${item.name}</div>
          <div class="food-meta">
            <span>${item.time || 'Dnes'}${amountStr}</span>
            <span class="food-macros">
              <span class="food-macro-dot p"></span>${item.protein || 0}g
              <span class="food-macro-dot c"></span>${item.carbs || 0}g
              <span class="food-macro-dot f"></span>${item.fat || 0}g
            </span>
          </div>
        </div>
        <div class="food-right">
          <div class="food-calories">${item.calories} kcal</div>
          <button class="btn-delete-food" data-index="${index}">×</button>
        </div>`;
      
      foodListContainer.appendChild(row);
    });
    
    // Add event listeners to delete buttons
    foodListContainer.querySelectorAll('.btn-delete-food').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const index = parseInt(e.target.getAttribute('data-index'));
        deleteFoodItem(index);
      });
    });
  }
}

function deleteFoodItem(index) {
  const todayStr = getTodayDateString();
  if (appState.logs[todayStr]) {
    const deletedName = appState.logs[todayStr][index].name;
    appState.logs[todayStr].splice(index, 1);
    
    // Clean up empty day lists
    if (appState.logs[todayStr].length === 0) {
      delete appState.logs[todayStr];
    }
    
    saveState();
    renderDashboard();
    showToast(`Smazáno: ${deletedName}`);
  }
}

// ==========================================================================
// UI RENDERING - HISTORY
// ==========================================================================
function renderHistory() {
  const historyContainer = document.getElementById('history-container');
  historyContainer.innerHTML = '';
  
  // Sort log dates descending
  const dates = Object.keys(appState.logs).sort().reverse();
  
  if (dates.length === 0) {
    historyContainer.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">📅</div>
        <p>Žádná historie. Zapiš si první jídlo dnes!</p>
      </div>`;
    return;
  }
  
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
    card.className = 'card history-day-card';
    
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
  const tabs = document.querySelectorAll('.tab-btn');
  const screens = document.querySelectorAll('.app-screen');
  
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const targetScreenId = `screen-${tab.getAttribute('data-screen')}`;
      
      // Update Tab active states
      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      
      // Update Screen active states
      screens.forEach(screen => {
        if (screen.id === targetScreenId) {
          screen.classList.add('active');
          // Perform screen-specific refresh
          if (targetScreenId === 'screen-dashboard') {
            renderDashboard();
          } else if (targetScreenId === 'screen-history') {
            renderHistory();
          } else if (targetScreenId === 'screen-settings') {
            renderSettings();
          }
        } else {
          screen.classList.remove('active');
        }
      });
    });
  });
  
  // Dashboard Settings Icon Link
  document.getElementById('btn-to-settings').addEventListener('click', () => {
    const settingsTab = document.querySelector('.tab-btn[data-screen="settings"]');
    if (settingsTab) settingsTab.click();
  });
  
  // Quick Add Button Link
  document.getElementById('btn-quick-add').addEventListener('click', () => {
    const addTab = document.querySelector('.tab-btn[data-screen="add"]');
    if (addTab) addTab.click();
  });

  // Inner sub-views of "Add Screen" (AI Skener vs Ruční zápis)
  const aiTabBtn = document.getElementById('tab-btn-ai');
  const manualTabBtn = document.getElementById('tab-btn-manual');
  const aiSubView = document.getElementById('sub-view-ai');
  const manualSubView = document.getElementById('sub-view-manual');
  
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
  
  // Settings view Toggle Gemini key visibility
  const btnToggleKey = document.getElementById('btn-toggle-key');
  const inputKey = document.getElementById('input-gemini-key');
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

// ==========================================================================
// CAMERA & PHOTO UPLOAD LOGIC
// ==========================================================================
function initPhotoHandlers() {
  const photoTrigger = document.getElementById('btn-photo-trigger');
  const photoPickerSheet = document.getElementById('photo-picker-sheet');
  const cameraInput = document.getElementById('camera-input');
  const galleryInput = document.getElementById('gallery-input');
  
  const sheetCameraBtn = document.getElementById('btn-sheet-camera');
  const sheetGalleryBtn = document.getElementById('btn-sheet-gallery');
  const sheetCancelBtn = document.getElementById('btn-sheet-cancel');
  
  const previewArea = document.getElementById('photo-preview-area');
  const previewImg = document.getElementById('photo-preview-img');
  const clearPhotoBtn = document.getElementById('btn-clear-photo');
  
  // Open bottom sheet
  photoTrigger.addEventListener('click', () => {
    photoPickerSheet.classList.add('active');
  });
  
  // Close bottom sheet helper
  function closeSheet() {
    photoPickerSheet.classList.remove('active');
  }
  
  sheetCancelBtn.addEventListener('click', closeSheet);
  photoPickerSheet.addEventListener('click', (e) => {
    if (e.target === photoPickerSheet) closeSheet();
  });
  
  // Handle action triggers
  sheetCameraBtn.addEventListener('click', () => {
    closeSheet();
    cameraInput.click();
  });
  
  sheetGalleryBtn.addEventListener('click', () => {
    closeSheet();
    galleryInput.click();
  });
  
  // Handle image files selection
  function handleImageFile(file) {
    if (!file) return;
    
    // Check it's an image
    if (!file.type.startsWith('image/')) {
      alert('Zvolte prosím soubor obrázku.');
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
  
  const systemInstructionText = `Jsi expert na výživu a nutriční hodnoty. Tvým úkolem je analyzovat vstup uživatele (který může být textový popis jídla, obrázek jídla, nebo obojí) a vrátit strukturovaná data o jídlech a jejich nutričních hodnotách v přesném formátu JSON.

Pravidla pro výstup:
1. Musíš vrátit pouze validní JSON objekt. Žádný doprovodný text, žádné markdown obaly (nepoužívej \`\`\`json ... \`\`\`).
2. Pokud uživatel popsal/vyfotil více jídel nebo položek, rozděl je do pole "items".
3. U každé položky uveď:
   - "name": český jasný název suroviny/jídla (např. "Kuřecí prsa grilovaná", "Bramborová kaše", "Banán")
   - "amount": odhadované množství v gramech nebo kusech (např. "150g", "1 střední kus", "200ml")
   - "calories": odhadovaná energetická hodnota v kcal (celé číslo)
   - "protein": bílkoviny v gramech (číslo)
   - "carbs": sacharidy v gramech (číslo)
   - "fat": tuky v gramech (číslo)
4. V objektu musí být také souhrn v klíči "total":
   - "calories": celkový součet kalorií
   - "protein": celkový součet bílkovin
   - "carbs": celkový součet sacharidů
   - "fat": celkový součet tuků
5. Pokud nelze jídlo vůbec identifikovat nebo je vstup nesmyslný, vrať JSON s prázdným polem "items" a nulovými hodnotami v "total".

Formát JSON, který MUSÍŠ přesně dodržet:
{
  "items": [
    {
      "name": "Název jídla",
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
}`;

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
    
    parts.push({ text: "Odhadni názvy, váhy a nutriční hodnoty (bílkoviny, sacharidy, tuky a kalorie) pro všechna jídla zobrazená na fotce." });
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
  tempDetectedItems = geminiData.items || [];
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
  const dashTab = document.querySelector('.tab-btn[data-screen="dashboard"]');
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
      id: Date.now().toString(36),
      time: timeStr,
      name,
      amount,
      calories,
      protein,
      carbs,
      fat
    });
    
    saveState();
    manualForm.reset();
    
    // Go to dashboard
    const dashTab = document.querySelector('.tab-btn[data-screen="dashboard"]');
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
      const dashTab = document.querySelector('.tab-btn[data-screen="dashboard"]');
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
// APPLICATION INITIALIZATION
// ==========================================================================
function init() {
  loadState();
  updateDateLabels();
  initNavigation();
  initPhotoHandlers();
  initFormHandlers();
  
  // Initial Dashboard Render
  renderDashboard();
  
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

// Build trigger v2
