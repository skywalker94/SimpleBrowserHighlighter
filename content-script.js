// content-script.js
// Handles highlights, persistence, and "smart toggle" behavior (fixed version).
// - Selection entirely highlighted => unwraps intersecting spans.
// - Selection partially highlighted => applies new highlight to full selection.
// - Selection not highlighted => applies highlight.
// - 'clearAll' removes all highlights and storage.
// - Toggle now works for all highlights, old or new, stable across reloads.

(function () {
  const STORAGE_PREFIX = 'highlights::';
  const HIGHLIGHT_CLASS = '__safe_ext_highlight_v1';
  const MAX_PERSISTED_PER_PAGE = 300;

  function isValidHexColor(c) {
    return /^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/.test(c);
  }

  function genId() {
    return 'h_' + Math.random().toString(36).slice(2, 9);
  }

  function storageKey() {
    return STORAGE_PREFIX + location.origin + '::' + location.pathname;
  }

  function readHighlightsArray() {
    const key = storageKey();
    return new Promise(resolve => chrome.storage.local.get(key, obj => resolve(obj[key] || [])));
  }

  function saveHighlightsArray(arr) {
    const key = storageKey();
    const payload = {};
    payload[key] = (Array.isArray(arr) ? arr : []).slice(0, MAX_PERSISTED_PER_PAGE);
    return new Promise(resolve => chrome.storage.local.set(payload, () => resolve()));
  }

  function selectionIsFullyHighlighted(range) {
    if (!range) return false;
    const walker = document.createTreeWalker(range.commonAncestorContainer, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue) return NodeFilter.FILTER_REJECT;
        if (!range.intersectsNode(node)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    let n;
    while (n = walker.nextNode()) {
      let parent = n.parentNode;
      if (!parent) return false;
      let found = false;
      while (parent && parent !== document.body) {
        if (parent.classList && parent.classList.contains(HIGHLIGHT_CLASS)) { found = true; break; }
        parent = parent.parentNode;
      }
      if (!found) return false;
    }
    return true;
  }

  function removeHighlightsIntersectingRange(range) {
    const spans = Array.from(document.querySelectorAll('span.' + HIGHLIGHT_CLASS));
    let removedAny = false;
    spans.forEach(span => {
      try {
        if (range.intersectsNode(span)) {
          const parent = span.parentNode;
          if (!parent) return;
          parent.replaceChild(document.createTextNode(span.textContent), span);
          parent.normalize();
          removedAny = true;
        }
      } catch (e) {}
    });
    return removedAny;
  }

  function insertHighlightForRange(range, color) {
    try {
      const span = document.createElement('span');
      span.className = HIGHLIGHT_CLASS;
      span.style.backgroundColor = color;
      span.style.borderRadius = '2px';
      span.style.whiteSpace = 'pre-wrap';
      span.style.cursor = 'text';
      span.setAttribute('data-ext-id', genId());
      span.setAttribute('data-ext-color', color);
      span.textContent = range.toString();

      range.deleteContents();
      range.insertNode(span);
      mergeAdjacentSpans(span);
      return true;
    } catch (e) {
      console.error('insertHighlightForRange error', e);
      return false;
    }
  }

  function mergeAdjacentSpans(span) {
    if (!span || !span.parentNode) return;
    const prev = span.previousSibling;
    const next = span.nextSibling;

    if (prev && prev.nodeType === Node.ELEMENT_NODE && prev.classList.contains(HIGHLIGHT_CLASS)
      && prev.dataset.extColor === span.dataset.extColor) {
      prev.textContent += span.textContent;
      span.parentNode.removeChild(span);
      span = prev;
    }

    if (next && next.nodeType === Node.ELEMENT_NODE && next.classList.contains(HIGHLIGHT_CLASS)
      && next.dataset.extColor === span.dataset.extColor) {
      span.textContent += next.textContent;
      next.parentNode.removeChild(next);
    }
  }

  async function persistAllSpans() {
    const spans = Array.from(document.querySelectorAll('span.' + HIGHLIGHT_CLASS));
    const arr = spans.map(s => ({
      id: s.getAttribute('data-ext-id') || genId(),
      text: s.textContent || '',
      color: s.getAttribute('data-ext-color') || s.style.backgroundColor || '#fff176',
      createdAt: Date.now(),
      updatedAt: Date.now()
    })).slice(0, MAX_PERSISTED_PER_PAGE);
    await saveHighlightsArray(arr);
  }

  async function clearAllHighlights() {
    document.querySelectorAll('span.' + HIGHLIGHT_CLASS).forEach(span => {
      const parent = span.parentNode;
      if (!parent) return;
      parent.replaceChild(document.createTextNode(span.textContent), span);
      parent.normalize();
    });
    await saveHighlightsArray([]);
    return true;
  }

  async function reapplyOnLoad() {
    try {
      const highlights = await readHighlightsArray();
      if (!highlights || !highlights.length) return;
      for (const rec of highlights) {
        if (!rec.text || !rec.color) continue;
        applyQuote(rec);
      }
    } catch (e) {
      console.error('reapplyOnLoad error', e);
    }
  }

  function applyQuote(rec) {
    try {
      const needle = rec.text;
      if (!needle) return false;
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          if (!node.nodeValue) return NodeFilter.FILTER_REJECT;
          const parent = node.parentElement;
          if (!parent) return NodeFilter.FILTER_REJECT;
          if (parent.closest && parent.closest('.' + HIGHLIGHT_CLASS)) return NodeFilter.FILTER_REJECT;
          if (parent.tagName === 'SCRIPT' || parent.tagName === 'STYLE') return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
      });

      const nodes = [];
      let node;
      let total = 0;
      while (node = walker.nextNode()) {
        nodes.push({ node, start: total, end: total + node.nodeValue.length });
        total += node.nodeValue.length;
      }
      if (!nodes.length) return false;

      const combined = nodes.map(n => n.node.nodeValue).join('');
      const idx = combined.indexOf(needle);
      if (idx === -1) return false;

      const startInfo = nodes.find(n => n.start <= idx && n.end > idx);
      const endInfo = nodes.find(n => n.start <= idx + needle.length - 1 && n.end > idx + needle.length - 1);
      if (!startInfo || !endInfo) return false;

      const startOffset = idx - startInfo.start;
      const endOffset = startInfo === endInfo ? startOffset + needle.length : idx + needle.length - endInfo.start;
      const range = document.createRange();
      range.setStart(startInfo.node, startOffset);
      range.setEnd(endInfo.node, endOffset);
      insertHighlightForRange(range, rec.color);
      return true;
    } catch (e) {
      return false;
    }
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    (async () => {
      if (!msg || !msg.action) return sendResponse({ ok: false, err: 'bad_message' });

      if (msg.action === 'highlight') {
        const color = (msg.color || '').trim();
        if (!isValidHexColor(color)) return sendResponse({ ok: false, err: 'invalid_color' });

        const sel = window.getSelection();
        if (!sel || sel.isCollapsed || !sel.toString().trim()) return sendResponse({ ok: false, err: 'no_selection' });

        try {
          const range = sel.getRangeAt(0).cloneRange();
          const fullyHighlighted = selectionIsFullyHighlighted(range);

          if (fullyHighlighted) {
            // Remove highlights that intersect the selection
            const removed = removeHighlightsIntersectingRange(range);
            if (removed) {
              await persistAllSpans();
              sel.removeAllRanges();
              return sendResponse({ ok: true, removed: true });
            }
          }

          // Apply highlight to partially or non-highlighted selection
          const applied = insertHighlightForRange(range, color);
          if (applied) await persistAllSpans();
          sel.removeAllRanges();
          return sendResponse({ ok: true, applied: applied });

        } catch (e) {
          console.error('highlight message error', e);
          return sendResponse({ ok: false, err: 'exception' });
        }
      } else if (msg.action === 'clearAll') {
        try {
          await clearAllHighlights();
          return sendResponse({ ok: true });
        } catch (e) {
          return sendResponse({ ok: false });
        }
      } else {
        return sendResponse({ ok: false, err: 'unknown_action' });
      }
    })();
    return true;
  });

  reapplyOnLoad();
})();
