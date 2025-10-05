// popup.js - Hardened version

const originEl = document.getElementById('origin');
const msgEl = document.getElementById('msg');

function showMsg(text, isError = true) {
  msgEl.textContent = text || '';
  msgEl.style.color = isError ? 'red' : 'green';
  if (text) setTimeout(() => { msgEl.textContent = ''; }, 4000);
}

// Strict hex color validator (#RGB or #RRGGBB)
function isValidHexColor(c) {
  return /^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/.test(c);
}

// Display active tab origin
async function showActiveTabInfo() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tabs || !tabs[0]) {
    originEl.textContent = 'No active tab';
    return null;
  }
  const url = tabs[0].url || '';
  try {
    const u = new URL(url);
    originEl.textContent = u.origin;
    return { tabId: tabs[0].id, origin: u.origin, url: url };
  } catch (e) {
    // non-http(s) schemes
    originEl.textContent = url || 'Unknown';
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

// Injected function: uses ONLY plain text to avoid re-inserting HTML/scripts
function injectedHighlightFunction(highlightColor) {
  // sanitize color again inside injected func (defense in depth)
  const isHex = /^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/;
  if (!isHex.test(highlightColor)) {
    // don't use alert(); return status to popup
    return { ok: false, err: 'invalid_color' };
  }

  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) {
    return { ok: false, err: 'no_selection' };
  }

  try {
    // Use the selection's plain text only — escape any HTML/scripts
    const text = sel.toString();
    if (!text) return { ok: false, err: 'empty_text' };

    const span = document.createElement('span');
    span.className = '__simple_ext_highlight_safe';
    // use textContent so any markup is escaped
    span.textContent = text;
    // inline style only for background color (we already validated format)
    span.style.backgroundColor = highlightColor;
    span.style.borderRadius = '2px';
    span.setAttribute('data-ext-origin', location.origin || '');

    // Replace the selection with a text node in the span.
    // We will collapse the range and insert the span at the range start.
    const range = sel.getRangeAt(0).cloneRange();
    range.deleteContents();
    range.insertNode(span);

    sel.removeAllRanges();
    return { ok: true };
  } catch (e) {
    // swallow errors and return status to popup
    return { ok: false, err: 'exception', message: String(e) };
  }
}

// Injected function to clear highlights safely
function injectedClearHighlightsFunction() {
  try {
    const list = document.querySelectorAll('span.__simple_ext_highlight_safe');
    list.forEach(span => {
      const parent = span.parentNode;
      if (!parent) return;
      // replace span with its text content (safe)
      parent.insertBefore(document.createTextNode(span.textContent), span);
      parent.removeChild(span);
      parent.normalize();
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, err: 'exception', message: String(e) };
  }
}

// Event handlers
document.getElementById('highlight').addEventListener('click', async () => {
  const color = document.getElementById('color').value || '#ffff00';
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

// show origin on load
showActiveTabInfo();
