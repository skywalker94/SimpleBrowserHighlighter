// popup.js - Hardened + persisted lastColor; recents updated ONLY when highlight is applied

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
  if (text) setTimeout(() => { msgEl.textContent = ''; }, 4000);
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

async function runOnActiveTab(func, args = []) {
  const tabInfo = await showActiveTabInfo();
  if (!tabInfo) return;
  // Only allow http(s) pages to run
  if (!tabInfo.url.startsWith('http://') && !tabInfo.url.startsWith('https://')) {
    showMsg('Extension runs only on regular web pages (http/https).');
    return;
  }

  try {
    const result = await chrome.scripting.executeScript({
      target: { tabId: tabInfo.tabId },
      func: func,
      args: args
    });
    return result;
  } catch (e) {
    console.error('script inject failed', e);
    showMsg('Could not run on this page.');
  }
}

// ---------- injected helper functions (unsafe-to-page logic is safe) ----------
function injectedHighlightFunction(highlightColor) {
  const isHex = /^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/;
  if (!isHex.test(highlightColor)) return { ok: false, err: 'invalid_color' };

  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) return { ok: false, err: 'no_selection' };

  try {
    const text = sel.toString();
    if (!text) return { ok: false, err: 'empty_text' };

    const span = document.createElement('span');
    span.className = '__simple_ext_highlight_safe';
    span.textContent = text;
    span.style.backgroundColor = highlightColor;
    span.style.borderRadius = '2px';
    span.setAttribute('data-ext-origin', location.origin || '');

    const range = sel.getRangeAt(0).cloneRange();
    range.deleteContents();
    range.insertNode(span);

    sel.removeAllRanges();
    return { ok: true };
  } catch (e) {
    return { ok: false, err: 'exception', message: String(e) };
  }
}

function injectedClearHighlightsFunction() {
  try {
    const list = document.querySelectorAll('span.__simple_ext_highlight_safe');
    list.forEach(span => {
      const parent = span.parentNode;
      if (!parent) return;
      parent.insertBefore(document.createTextNode(span.textContent), span);
      parent.removeChild(span);
      parent.normalize();
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, err: 'exception', message: String(e) };
  }
}

// ---------- event handlers ----------
document.getElementById('highlight').addEventListener('click', async () => {
  const color = colorInput.value || DEFAULT_COLOR;
  if (!isValidHexColor(color)) {
    showMsg('Selected color is invalid.');
    return;
  }

  const res = await runOnActiveTab(injectedHighlightFunction, [color]);
  if (!res || !res[0] || !res[0].result) {
    showMsg('Failed to highlight on page.');
    return;
  }
  const resultObj = res[0].result;
  if (!resultObj.ok) {
    if (resultObj.err === 'no_selection') showMsg('Please select text on the page first.');
    else if (resultObj.err === 'invalid_color') showMsg('Invalid color.');
    else showMsg('Highlight failed.');
    return;
  }

  // success: add to recents (only now)
  await addToRecents(color);
  showMsg('Highlighted ✓', false);
});

document.getElementById('clear').addEventListener('click', async () => {
  const res = await runOnActiveTab(injectedClearHighlightsFunction, []);
  if (res && res[0] && res[0].result && res[0].result.ok) {
    showMsg('Cleared highlights', false);
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
