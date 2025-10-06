// popup.js - Persisted lastColor; recents only updated on applied highlights.
// Uses messaging to the content script for highlight / clearAll actions.

const originEl = document.getElementById('origin');
const msgEl = document.getElementById('msg');
const colorInput = document.getElementById('color');
const recentsContainer = document.getElementById('recents');
const vibgyorContainer = document.getElementById('vibgyor');

const PREF_KEY = 'highlighter_prefs_v1';
const MAX_RECENTS = 5;
const DEFAULT_COLOR = '#fff176';
const VIBGYOR = ['#ff1744','#ff9100','#ffd600','#76ff03','#00e5ff','#2979ff','#d500f9'];

// ---------- utilities ----------
function showMsg(text, isError = true) {
  if (!msgEl) return;
  msgEl.textContent = text || '';
  msgEl.style.color = isError ? 'red' : 'green';
  if (text) setTimeout(() => { msgEl.textContent = ''; }, 3500);
}

function isValidHexColor(c) {
  return /^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/.test(c);
}

function storageGet(key) {
  return new Promise((resolve) => {
    chrome.storage.local.get(key, (obj) => {
      resolve(obj[key]);
    });
  });
}
function storageSet(obj) {
  return new Promise((resolve) => {
    chrome.storage.local.set(obj, () => resolve());
  });
}

// ---------- prefs (load/save) ----------
async function loadPrefs() {
  const data = await storageGet(PREF_KEY);
  if (!data) return { lastColor: DEFAULT_COLOR, recents: [] };
  const lastColor = isValidHexColor(data.lastColor) ? data.lastColor : DEFAULT_COLOR;
  const recents = Array.isArray(data.recents) ? data.recents.filter(c => isValidHexColor(c)).slice(0, MAX_RECENTS) : [];
  return { lastColor, recents };
}

async function savePrefs(prefs) {
  const payload = {};
  payload[PREF_KEY] = {
    lastColor: prefs.lastColor,
    recents: (prefs.recents || []).slice(0, MAX_RECENTS)
  };
  await storageSet(payload);
}

// add color to recents (called only after a highlight is applied)
async function addToRecents(color) {
  if (!isValidHexColor(color)) return;
  const prefs = await loadPrefs();
  prefs.lastColor = color; // keep lastColor in sync
  prefs.recents = prefs.recents || [];
  prefs.recents = [color, ...prefs.recents.filter(c => c.toLowerCase() !== color.toLowerCase())].slice(0, MAX_RECENTS);
  await savePrefs(prefs);
  renderRecents(prefs.recents);
}

// set lastColor only (do NOT touch recents) — used when user changes picker or clicks a swatch but hasn't applied highlight yet
async function setLastColorOnly(color) {
  if (!isValidHexColor(color)) return;
  const prefs = await loadPrefs();
  prefs.lastColor = color;
  // keep recents untouched
  await savePrefs(prefs);
}

// ---------- UI renderers ----------
function renderRecents(recents) {
  if (!recentsContainer) return;
  recentsContainer.innerHTML = '';
  if (!recents || !recents.length) return;
  recents.forEach(c => {
    const d = document.createElement('div');
    d.className = 'swatch';
    d.style.backgroundColor = c;
    d.title = c;
    d.style.width = '28px';
    d.style.height = '28px';
    d.style.borderRadius = '4px';
    d.style.border = '1px solid #ccc';
    d.style.cursor = 'pointer';
    d.addEventListener('click', async () => {
      colorInput.value = c;
      // user clicked a recent swatch — make it the current color but DO NOT modify recents again
      await setLastColorOnly(c);
    });
    recentsContainer.appendChild(d);
  });
}

function renderVibgyor() {
  if (!vibgyorContainer) return;
  vibgyorContainer.innerHTML = '';
  VIBGYOR.forEach(c => {
    const d = document.createElement('div');
    d.className = 'swatch';
    d.style.backgroundColor = c;
    d.title = c;
    d.style.width = '28px';
    d.style.height = '28px';
    d.style.borderRadius = '4px';
    d.style.border = '1px solid #ccc';
    d.style.cursor = 'pointer';
    d.addEventListener('click', async () => {
      colorInput.value = c;
      // set lastColor only; do not add to recents until user applies highlight
      await setLastColorOnly(c);
    });
    vibgyorContainer.appendChild(d);
  });
}


// ---------- active tab helpers ----------
async function showActiveTabInfo() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tabs || !tabs[0]) {
    if (originEl) originEl.textContent = 'No active tab';
    return null;
  }
  const url = tabs[0].url || '';
  try {
    const u = new URL(url);
    if (originEl) originEl.textContent = u.origin;
    return { tabId: tabs[0].id, origin: u.origin, url: url };
  } catch (e) {
    if (originEl) originEl.textContent = url || 'Unknown';
    return { tabId: tabs[0].id, origin: null, url: url };
  }
}

// send a message to content script on active tab
async function sendMessageToActiveTab(message) {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tabs || !tabs[0]) return { ok: false, err: 'no_tab' };
  const tab = tabs[0];

  if (!tab.url || (!tab.url.startsWith('http://') && !tab.url.startsWith('https://'))) {
    return { ok: false, err: 'bad_scheme' };
  }

  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tab.id, message, (resp) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, err: 'no_listener', message: chrome.runtime.lastError.message });
      } else resolve(resp || { ok: false, err: 'no_resp' });
    });
  });
}

// ---------- event handlers (use messaging so content script handles logic & persistence) ----------
document.getElementById('highlight').addEventListener('click', async () => {
  const color = colorInput.value || DEFAULT_COLOR;
  if (!isValidHexColor(color)) {
    showMsg('Selected color is invalid.');
    return;
  }

  const res = await sendMessageToActiveTab({ action: 'highlight', color });
  if (!res || !res.ok) {
    // handle known error cases
    if (res && res.err === 'no_selection') showMsg('Please select text on the page first.');
    else if (res && res.err === 'invalid_color') showMsg('Invalid color.');
    else showMsg('Highlight failed (page may block messages).');
    return;
  }

  // success: add to recents
  await addToRecents(color);
  showMsg('Highlighted ✓', false);
});

document.getElementById('clear').addEventListener('click', async () => {
  // confirm intent
  const confirmed = confirm('Clear ALL highlights on this page? This will remove every saved highlight for this page.');
  if (!confirmed) return;

  const res = await sendMessageToActiveTab({ action: 'clearAll' });
  if (res && res.ok) {
    showMsg('All highlights cleared', false);
    // also update UI recents/prefs if desired (we keep recents)
  } else {
    showMsg('Clear failed.');
  }
});

// when user changes color in picker, persist it as lastColor only (do NOT add to recents)
colorInput.addEventListener('input', async () => {
  const c = colorInput.value;
  if (isValidHexColor(c)) await setLastColorOnly(c);
});

// ---------- init ----------
(async function init() {
  // show origin
  showActiveTabInfo();

  // load prefs and set UI
  const prefs = await loadPrefs();
  if (colorInput) colorInput.value = prefs.lastColor || DEFAULT_COLOR;
  renderRecents(prefs.recents || []);
  renderVibgyor();

  // small UX: when popup opens, also request latest tab origin again (some pages load slowly)
  setTimeout(showActiveTabInfo, 250);
})();
