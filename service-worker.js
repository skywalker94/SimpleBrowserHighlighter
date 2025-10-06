// service-worker.js
// Robust handling for the "highlight-selection" command.
// 1) Try messaging the content script (preferred — it handles persistence).
// 2) If messaging fails, fallback to executeScript flow that:
//    - extracts the quote (text + prefix/suffix),
//    - inserts a safe text-only span with the selected color,
//    - persists the highlight record to chrome.storage.local,
//    - updates recents (only when highlight applied).
//
// This preserves safety: we never insert raw HTML, color is validated, and
// stored records are plain-text quotes + metadata.

const PREF_KEY = 'highlighter_prefs_v1';
const HIGHLIGHT_PREFIX = 'highlights::';
const MAX_RECENTS = 5;

function isValidHexColor(c) {
  return /^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/.test(c);
}

function genId() {
  return 'h_' + Math.random().toString(36).slice(2, 9);
}

// storage helpers
function getLocal(key) {
  return new Promise(resolve => chrome.storage.local.get(key, obj => resolve(obj[key])));
}
function setLocal(obj) {
  return new Promise(resolve => chrome.storage.local.set(obj, () => resolve()));
}

// compute storage key for a tab URL
function storageKeyForUrl(url) {
  try {
    const u = new URL(url);
    return HIGHLIGHT_PREFIX + u.origin + '::' + u.pathname;
  } catch (e) {
    return HIGHLIGHT_PREFIX + 'unknown';
  }
}

// fallback: extract quote from page (selection -> {text,prefix,suffix})
async function extractQuoteFromPage(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      // create a small quote object from the current selection
      try {
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed) return null;
        const text = sel.toString();
        if (!text) return null;

        const range = sel.getRangeAt(0);

        // prefix: last 60 chars before range start
        const beforeRange = range.cloneRange();
        beforeRange.collapse(true);
        beforeRange.setStart(document.body, 0);
        const prefixText = beforeRange.toString().slice(-60);

        // suffix: first 60 chars after range end
        const afterRange = range.cloneRange();
        afterRange.collapse(false);
        afterRange.setEnd(document.body, document.body.childNodes.length);
        const suffixText = afterRange.toString().slice(0, 60);

        return { text, prefix: prefixText, suffix: suffixText };
      } catch (e) {
        return null;
      }
    }
  });

  if (!results || !results[0] || !results[0].result) return null;
  return results[0].result;
}

// fallback: insert a safe span with color and return success
async function insertSpanOnPage(tabId, color) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (highlightColor) => {
      // validate color inside page too (defense in depth)
      const isHex = /^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/;
      if (!isHex.test(highlightColor)) return { ok: false, err: 'invalid_color' };

      try {
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed) return { ok: false, err: 'no_selection' };
        const text = sel.toString();
        if (!text) return { ok: false, err: 'empty_text' };

        // insert a text-only span to avoid injecting HTML/script
        const span = document.createElement('span');
        span.className = '__simple_ext_highlight_safe';
        span.setAttribute('data-ext-origin', location.origin || '');
        span.style.backgroundColor = highlightColor;
        span.style.borderRadius = '2px';
        span.style.whiteSpace = 'pre-wrap';
        span.style.cursor = 'text';
        span.textContent = text;

        const range = sel.getRangeAt(0).cloneRange();
        range.deleteContents();
        range.insertNode(span);
        sel.removeAllRanges();

        return { ok: true };
      } catch (e) {
        return { ok: false, err: 'exception', message: String(e) };
      }
    },
    args: [color]
  });

  if (!results || !results[0]) return { ok: false, err: 'no_result' };
  return results[0].result || { ok: false, err: 'no_result' };
}

// persist a highlight record to storage under the page key
async function persistHighlightForUrl(url, rec) {
  const key = storageKeyForUrl(url);
  const existing = await getLocal(key) || [];
  const arr = Array.isArray(existing) ? existing : [];
  arr.push(rec);
  await setLocal({ [key]: arr });
}

// update recents (add color at front, dedupe, limit)
async function addColorToRecents(color) {
  if (!isValidHexColor(color)) return;
  const prefs = (await getLocal(PREF_KEY)) || { lastColor: '#fff176', recents: [] };
  const recents = Array.isArray(prefs.recents) ? prefs.recents : [];
  const updated = [color, ...recents.filter(c => c.toLowerCase() !== color.toLowerCase())].slice(0, MAX_RECENTS);
  prefs.lastColor = color;
  prefs.recents = updated;
  await setLocal({ [PREF_KEY]: prefs });
}

// main handler
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'highlight-selection') return;

  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tabs || !tabs[0]) return;
    const tab = tabs[0];
    if (!tab.url || (!tab.url.startsWith('http://') && !tab.url.startsWith('https://'))) return;

    // read prefs (prefer local)
    const prefs = (await getLocal(PREF_KEY)) || { lastColor: '#fff176', recents: [] };
    const color = (prefs && typeof prefs.lastColor === 'string' && isValidHexColor(prefs.lastColor)) ? prefs.lastColor : '#fff176';

    // 1) Preferred path: message the content script (so it performs the highlight + persistence)
    let usedPreferred = false;
    await new Promise((resolve) => {
      chrome.tabs.sendMessage(tab.id, { action: 'highlight', color }, async (resp) => {
        if (chrome.runtime.lastError) {
          // no listener or error — fallback below
          resolve();
          return;
        }
        // if content script handled it successfully, update recents (content script already persisted highlights)
        if (resp && resp.ok) {
          try { await addColorToRecents(color); } catch (e) { /* best-effort */ }
          usedPreferred = true;
        }
        resolve();
      });
    });

    if (usedPreferred) return; // success via content script

    // 2) Fallback: use scripting.executeScript to extract quote, insert span, and persist ourselves
    // extract quote first
    const quote = await extractQuoteFromPage(tab.id);
    if (!quote || !quote.text) {
      // nothing selected or extraction failed; nothing to do
      return;
    }

    // insert the span
    const ins = await insertSpanOnPage(tab.id, color);
    if (!ins || !ins.ok) {
      // couldn't insert (maybe selection changed); abort
      return;
    }

    // persist the highlight record locally (id, text, prefix, suffix, color, createdAt, updatedAt)
    const rec = {
      id: genId(),
      text: quote.text,
      prefix: quote.prefix || '',
      suffix: quote.suffix || '',
      color,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    try {
      await persistHighlightForUrl(tab.url, rec);
    } catch (e) {
      // persist failed — best-effort; do not interrupt user
      console.warn('persistHighlightForUrl failed', e);
    }

    // update recents
    try {
      await addColorToRecents(color);
    } catch (e) {
      // ignore
    }
  } catch (e) {
    console.error('service-worker onCommand error', e);
  }
});
