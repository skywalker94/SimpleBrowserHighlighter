// content-script.js
// Handles highlights, persistence, and "smart toggle" behavior:
// - If selection contains any un-highlighted text => apply highlight to whole selection.
// - If selection is entirely inside existing highlighted spans => remove (unwrap) all highlight spans that intersect the selection.
// - 'clearAll' message removes all highlights and clears stored records for the page.
// - After any modification, persisted highlights are rebuilt from current span elements.
//
// Safety: only textContent is used, colors validated, storage keys namespaced per origin+pathname.

(function () {
  const STORAGE_PREFIX = 'highlights::'; // key: STORAGE_PREFIX + origin + '::' + pathname
  const HIGHLIGHT_CLASS = '__safe_ext_highlight_v1';
  const MAX_PERSISTED_PER_PAGE = 300; // safety cap

  // hex validator
  function isValidHexColor(c) {
    return /^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/.test(c);
  }

  function genId() {
    return 'h_' + Math.random().toString(36).slice(2, 9);
  }

  // compute storage key for this page
  function storageKey() {
    try {
      return STORAGE_PREFIX + location.origin + '::' + location.pathname;
    } catch (e) {
      return STORAGE_PREFIX + 'unknown';
    }
  }

  // read persisted highlights for this page
  function readHighlightsArray() {
    const key = storageKey();
    return new Promise((resolve) => {
      chrome.storage.local.get(key, (obj) => {
        resolve(obj[key] || []);
      });
    });
  }

  // save persisted highlights for this page
  function saveHighlightsArray(arr) {
    const key = storageKey();
    const payload = {};
    payload[key] = (Array.isArray(arr) ? arr : []).slice(0, MAX_PERSISTED_PER_PAGE);
    return new Promise((resolve) => {
      chrome.storage.local.set(payload, () => resolve());
    });
  }

  // Find whether all text in a Range is contained inside highlight spans
  function selectionIsFullyHighlighted(range) {
    if (!range) return false;
    const walker = document.createTreeWalker(range.commonAncestorContainer, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue) return NodeFilter.FILTER_REJECT;
        // reject nodes that are not inside the selection range
        const nodeRange = document.createRange();
        try {
          nodeRange.selectNodeContents(node.parentNode);
        } catch (e) {
          return NodeFilter.FILTER_REJECT;
        }
        // check if node intersects range
        const nodeStart = { node: node, offset: 0 };
        // We'll rely on range.intersectsNode to check if node is in selection
        if (!range.intersectsNode(node)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    let n;
    while (n = walker.nextNode()) {
      // For each text node included in selection, determine if its portion inside range is within a highlight span
      let cur = n;
      const parent = cur.parentNode;
      if (!parent) return false;
      if (parent.nodeType === Node.ELEMENT_NODE && parent.classList && parent.classList.contains(HIGHLIGHT_CLASS)) {
        // this text node is inside a highlight parent - good
        continue;
      } else {
        // need to check if the part of this node that is within the range is inside a highlight ancestor (rare)
        // simpler check: if any ancestor up to body has the highlight class we treat as highlighted
        let anc = parent;
        let found = false;
        while (anc && anc !== document.body) {
          if (anc.classList && anc.classList.contains(HIGHLIGHT_CLASS)) { found = true; break; }
          anc = anc.parentNode;
        }
        if (found) continue;
        // not inside a highlight span => selection is not fully highlighted
        return false;
      }
    }
    // no non-highlighted text nodes found inside range
    return true;
  }

  // unwrap (remove) all highlight spans that intersect with the given range
  function removeHighlightsIntersectingRange(range) {
    const spans = Array.from(document.querySelectorAll('span.' + HIGHLIGHT_CLASS));
    let removedAny = false;
    spans.forEach(span => {
      try {
        if (range.intersectsNode(span)) {
          // unwrap the span entirely (replace with its text content)
          const parent = span.parentNode;
          if (!parent) return;
          parent.replaceChild(document.createTextNode(span.textContent), span);
          parent.normalize();
          removedAny = true;
        }
      } catch (e) {
        // ignore
      }
    });
    return removedAny;
  }

  // Insert highlight over the selection (text-only span). We try to merge with adjacent spans of same color.
  function insertHighlightForRange(range, color) {
    try {
      const span = document.createElement('span');
      span.className = HIGHLIGHT_CLASS;
      span.style.backgroundColor = color;
      span.style.borderRadius = '2px';
      span.style.whiteSpace = 'pre-wrap';
      span.style.cursor = 'text';
      span.setAttribute('data-ext-id', genId());
      span.setAttribute('data-ext-origin', location.origin || '');
      span.textContent = range.toString();

      // Replace range content with span
      range.deleteContents();
      range.insertNode(span);
      // Normalize: merge adjacent spans of same class+color
      mergeAdjacentSpans(span);
      return true;
    } catch (e) {
      console.error('insertHighlightForRange error', e);
      return false;
    }
  }

  // Merge adjacent highlight spans if they have same color and class
  function mergeAdjacentSpans(span) {
    if (!span || !span.parentNode) return;
    const prev = span.previousSibling;
    const next = span.nextSibling;

    // merge with previous sibling if it's a span with same class and same background color
    if (prev && prev.nodeType === Node.ELEMENT_NODE && prev.classList && prev.classList.contains(HIGHLIGHT_CLASS)) {
      const prevColor = window.getComputedStyle(prev).backgroundColor;
      const spanColor = window.getComputedStyle(span).backgroundColor;
      if (prevColor === spanColor) {
        // merge text
        prev.textContent = prev.textContent + span.textContent;
        span.parentNode.removeChild(span);
        span = prev; // continue merging with next
      }
    }

    // merge with next sibling similarly
    const nxt = span.nextSibling;
    if (nxt && nxt.nodeType === Node.ELEMENT_NODE && nxt.classList && nxt.classList.contains(HIGHLIGHT_CLASS)) {
      const nxtColor = window.getComputedStyle(nxt).backgroundColor;
      const spanColor = window.getComputedStyle(span).backgroundColor;
      if (nxtColor === spanColor) {
        span.textContent = span.textContent + nxt.textContent;
        nxt.parentNode.removeChild(nxt);
      }
    }
  }

  // Persist current highlight spans to storage (rebuild storage from DOM)
  async function persistAllSpans() {
    const spans = Array.from(document.querySelectorAll('span.' + HIGHLIGHT_CLASS));
    const arr = spans.map(s => {
      const colorStyle = (s.style && s.style.backgroundColor) || '';
      // convert rgb(...) to hex? We'll store as computed style if possible
      // But to keep consistent with hex validation we'll try to read a data-hex attribute if present
      const color = s.getAttribute('data-ext-color') || colorStyle || '';
      return {
        id: s.getAttribute('data-ext-id') || genId(),
        text: s.textContent || '',
        prefix: '',
        suffix: '',
        color: color,
        createdAt: Date.now(),
        updatedAt: Date.now()
      };
    }).slice(0, MAX_PERSISTED_PER_PAGE);

    try {
      await saveHighlightsArray(arr);
    } catch (e) {
      console.warn('persistAllSpans save error', e);
    }
  }

  // clear all highlights in DOM and storage for this page
  async function clearAllHighlights() {
    // remove elements inserted by extension
    document.querySelectorAll('span.' + HIGHLIGHT_CLASS).forEach(span => {
      const parent = span.parentNode;
      if (!parent) return;
      parent.replaceChild(document.createTextNode(span.textContent), span);
      parent.normalize();
    });

    // clear storage for this page
    await saveHighlightsArray([]);
    return true;
  }

  // Save helper wrapper
  function saveHighlightsArray(arr) {
    const key = storageKey();
    const payload = {};
    payload[key] = (Array.isArray(arr) ? arr : []).slice(0, MAX_PERSISTED_PER_PAGE);
    return new Promise((resolve) => {
      chrome.storage.local.set(payload, () => resolve());
    });
  }

  // Apply stored highlights on load (best-effort, uses simple text-quote technique)
  async function reapplyOnLoad() {
    try {
      const key = storageKey();
      const arr = await new Promise((resolve) => {
        chrome.storage.local.get(key, (obj) => resolve(obj[key] || []));
      });
      if (!arr || !arr.length) return;
      const kept = [];
      for (const rec of arr) {
        if (!rec || !rec.text || !rec.color) continue;
        // Find the first match of rec.text in the document body that is not inside another highlight
        const found = tryApplyQuote(rec);
        if (found) kept.push(rec);
      }
      // persist kept (clean up stale entries)
      await saveHighlightsArray(kept);
    } catch (e) {
      console.error('reapplyOnLoad error', e);
    }
  }

  // Try to apply a quote using a simple search; returns true if applied
  function tryApplyQuote(rec) {
    try {
      const needle = rec.text;
      if (!needle) return false;
      // naive search via indexOf on body text and then mapping back to node offsets (best-effort)
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
        const txt = node.nodeValue || '';
        nodes.push({ node, start: total, end: total + txt.length });
        total += txt.length;
      }
      if (!nodes.length) return false;
      let combined = '';
      for (const n of nodes) combined += n.node.nodeValue;

      const idx = combined.indexOf(needle);
      if (idx === -1) return false;

      // map index to node/offset
      const startInfo = nodes.find(n => n.start <= idx && n.end > idx);
      const endInfo = nodes.find(n => n.start <= idx + needle.length - 1 && n.end > idx + needle.length - 1);
      if (!startInfo || !endInfo) return false;
      const startOffset = idx - startInfo.start;
      const endOffset = (startInfo === endInfo) ? (startOffset + needle.length) : (idx + needle.length - endInfo.start);

      // build range and insert span
      const range = document.createRange();
      range.setStart(startInfo.node, startOffset);
      range.setEnd(endInfo.node, endOffset);
      insertHighlightForRange(range, rec.color);
      return true;
    } catch (e) {
      return false;
    }
  }

  // Message listener
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

          // Decide whether selection is fully highlighted
          const fullyHighlighted = selectionIsFullyHighlighted(range);

          if (fullyHighlighted) {
            // Remove any highlight spans that intersect the selection
            const removed = removeHighlightsIntersectingRange(range);
            if (removed) {
              await persistAllSpans(); // persist current spanning state
              sel.removeAllRanges();
              return sendResponse({ ok: true, removed: true });
            } else {
              // nothing removed (rare)
              return sendResponse({ ok: false, err: 'nothing_removed' });
            }
          } else {
            // apply highlight to whole selection
            const applied = insertHighlightForRange(range, color);
            if (!applied) return sendResponse({ ok: false, err: 'apply_failed' });
            // persist all spans after modification
            await persistAllSpans();
            sel.removeAllRanges();
            return sendResponse({ ok: true, applied: true });
          }
        } catch (e) {
          console.error('highlight message error', e);
          return sendResponse({ ok: false, err: 'exception' });
        }
      } else if (msg.action === 'clearAll') {
        try {
          await clearAllHighlights();
          return sendResponse({ ok: true });
        } catch (e) {
          console.error('clearAll error', e);
          return sendResponse({ ok: false });
        }
      } else if (msg.action === 'getPrefs') {
        return sendResponse({ ok: true, origin: location.origin, path: location.pathname });
      } else {
        return sendResponse({ ok: false, err: 'unknown_action' });
      }
    })();

    return true; // indicate async sendResponse
  });

  // On load, reapply existing highlights
  reapplyOnLoad();

  // Helper used above
  async function persistAllSpans() {
    const spans = Array.from(document.querySelectorAll('span.' + HIGHLIGHT_CLASS));
    const arr = spans.map(s => {
      const colorAttr = s.getAttribute('data-ext-color') || s.style.backgroundColor || '';
      return {
        id: s.getAttribute('data-ext-id') || genId(),
        text: s.textContent || '',
        prefix: '',
        suffix: '',
        color: colorAttr,
        createdAt: Date.now(),
        updatedAt: Date.now()
      };
    }).slice(0, MAX_PERSISTED_PER_PAGE);
    await saveHighlightsArray(arr);
  }

})();
