// content-script.js
// Runs on http(s) pages (declared in manifest). Responsible for:
// - reapplying stored highlights on load,
// - responding to messages { action: 'highlight' | 'clear' }
// - storing & removing highlights (in chrome.storage.local)
// Security: only inserts textContent (no HTML), validates color (hex), scoped class names

(function () {
  const STORAGE_PREFIX = 'highlights::'; // key: STORAGE_PREFIX + origin + '::' + pathname
  const HIGHLIGHT_CLASS = '__safe_ext_highlight_v1';

  // utility: hex validator
  function isValidHexColor(c) {
    return /^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/.test(c);
  }

  // generate id
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

  // create the highlight span safely using plain text
  function insertHighlightSpanAtRange(range, text, color, id) {
    const span = document.createElement('span');
    span.className = HIGHLIGHT_CLASS;
    span.setAttribute('data-ext-id', id || genId());
    span.setAttribute('data-ext-origin', location.origin || '');
    span.style.backgroundColor = color;
    span.style.borderRadius = '2px';
    span.style.whiteSpace = 'pre-wrap';
    span.style.cursor = 'text';
    span.textContent = text;
    range.deleteContents();
    range.insertNode(span);
    return span;
  }

  // safely replace a text node segment with a span: find the text node and its offset
  function replaceTextNodeSegment(node, startOffset, endOffset, color, id) {
    // node is a Text node
    const text = node.nodeValue || '';
    const before = text.slice(0, startOffset);
    const middle = text.slice(startOffset, endOffset);
    const after = text.slice(endOffset);

    const parent = node.parentNode;
    if (!parent) return null;

    const frag = document.createDocumentFragment();
    if (before) frag.appendChild(document.createTextNode(before));
    const span = document.createElement('span');
    span.className = HIGHLIGHT_CLASS;
    span.setAttribute('data-ext-id', id || genId());
    span.setAttribute('data-ext-origin', location.origin || '');
    span.style.backgroundColor = color;
    span.style.borderRadius = '2px';
    span.style.whiteSpace = 'pre-wrap';
    span.style.cursor = 'text';
    span.textContent = middle;
    frag.appendChild(span);
    if (after) frag.appendChild(document.createTextNode(after));
    parent.replaceChild(frag, node);
    return span;
  }

  // create "quote" record for persistence: text + small context
  function createQuoteFromSelection(sel) {
    const text = sel.toString();
    if (!text) return null;
    // for prefix/suffix context, find surrounding text in the container node(s)
    // We'll try to find the anchor node and take small surrounding substring
    try {
      const range = sel.getRangeAt(0);
      // collapse a copy to before and after to extract prefix/suffix
      const beforeRange = range.cloneRange();
      beforeRange.collapse(true);
      beforeRange.setStart(document.body, 0);
      const prefixText = beforeRange.toString().slice(-60);

      const afterRange = range.cloneRange();
      afterRange.collapse(false);
      afterRange.setEnd(document.body, document.body.childNodes.length);
      const suffixText = afterRange.toString().slice(0, 60);

      return { text, prefix: prefixText, suffix: suffixText };
    } catch (e) {
      return { text, prefix: '', suffix: '' };
    }
  }

  // find a text occurrence matching the quote (using prefix/suffix to disambiguate)
  function findBestMatchForQuote(quote) {
    // naive approach: search for quote.text occurrences in document body textContent
    // but we need to map to actual text node & offsets. We'll walk text nodes.
    const needle = quote.text;
    if (!needle) return null;

    // gather text nodes sequentially and keep running index
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: function(node) {
        // skip script/style and nodes inside our own highlights
        if (!node.nodeValue) return NodeFilter.FILTER_REJECT;
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        if (parent.closest && parent.closest('.' + HIGHLIGHT_CLASS)) return NodeFilter.FILTER_REJECT;
        if (parent.tagName === 'SCRIPT' || parent.tagName === 'STYLE' || parent.isContentEditable) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    // Build an array of text nodes with their cumulative offsets
    const nodes = [];
    let node;
    let total = 0;
    while (node = walker.nextNode()) {
      const txt = node.nodeValue || '';
      nodes.push({ node, start: total, end: total + txt.length });
      total += txt.length;
    }

    if (total === 0) return null;

    // find all indices where needle appears in the concatenated text
    let combined = '';
    for (const n of nodes) combined += n.node.nodeValue;

    const indices = [];
    let idx = combined.indexOf(needle);
    while (idx !== -1) {
      indices.push(idx);
      idx = combined.indexOf(needle, idx + 1);
    }
    if (indices.length === 0) return null;

    // try to choose an index matching prefix/suffix if possible
    // check each candidate for prefix/suffix similarity
    function prefixSuffixScore(i) {
      const prefixOK = quote.prefix ? combined.slice(Math.max(0, i - quote.prefix.length), i) === quote.prefix : true;
      const suffixOK = quote.suffix ? combined.slice(i + needle.length, i + needle.length + quote.suffix.length) === quote.suffix : true;
      let score = 0;
      if (prefixOK) score += 1;
      if (suffixOK) score += 1;
      return score;
    }

    indices.sort((a,b) => prefixSuffixScore(b) - prefixSuffixScore(a)); // best score first

    const bestIndex = indices[0];

    // map bestIndex back to text node + offsets
    // find node such that node.start <= bestIndex < node.end
    let startNodeInfo = nodes.find(n => n.start <= bestIndex && n.end > bestIndex);
    if (!startNodeInfo) return null;
    let endIndexInCombined = bestIndex + needle.length - 1;
    let endNodeInfo = nodes.find(n => n.start <= endIndexInCombined && n.end > endIndexInCombined);
    if (!endNodeInfo) return null;

    // compute offsets relative to nodes
    const startOffset = bestIndex - startNodeInfo.start;
    const endOffset = (startNodeInfo === endNodeInfo) ? (startOffset + needle.length) : (endNodeInfo ? (endIndexInCombined - endNodeInfo.start + 1) : null);

    // If start and end in same node, simple; otherwise handle multi-node (we'll select contiguous nodes and replace with a single span)
    return { startNode: startNodeInfo.node, startOffset, endNode: endNodeInfo.node, endOffset, text: needle };
  }

  // apply a quote highlight (wrap the matching text)
  function applyQuoteHighlight(quote, color, id) {
    if (!quote || !quote.text) return false;
    const match = findBestMatchForQuote(quote);
    if (!match) return false;

    try {
      if (match.startNode === match.endNode) {
        // single node replacement
        replaceTextNodeSegment(match.startNode, match.startOffset, match.endOffset, color, id);
      } else {
        // multiple nodes -- we will create a range that spans them and replace with a single span of text
        const range = document.createRange();
        range.setStart(match.startNode, match.startOffset);
        range.setEnd(match.endNode, match.endOffset);
        const span = insertHighlightSpanAtRange(range, quote.text, color, id);
      }
      return true;
    } catch (e) {
      console.error('applyQuoteHighlight error', e);
      return false;
    }
  }

  // persist an array of highlights for this page
  async function saveHighlightsArray(arr) {
    const key = storageKey();
    const data = {};
    data[key] = arr || [];
    await chrome.storage.local.set(data);
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

  // add a highlight record (quote) to storage
  async function addHighlightRecord(rec) {
    const arr = await readHighlightsArray();
    arr.push(rec);
    await saveHighlightsArray(arr);
  }

  // remove all highlights in DOM and storage for this page
  async function clearHighlights() {
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

  // on load, reapply stored highlights
  (async function reapplyOnLoad() {
    try {
      const arr = await readHighlightsArray();
      if (!arr || !arr.length) return;
      // for each record, attempt to apply highlight; if successful, keep; else remove
      const kept = [];
      for (const rec of arr) {
        // validate rec shape
        if (!rec || !rec.text || !isValidHexColor(rec.color) || !rec.id) continue;
        const ok = applyQuoteHighlight({ text: rec.text, prefix: rec.prefix, suffix: rec.suffix }, rec.color, rec.id);
        if (ok) kept.push(rec);
      }
      // persist only the kept ones (helps remove stale records that couldn't be applied)
      await saveHighlightsArray(kept);
    } catch (e) {
      console.error('reapplyOnLoad error', e);
    }
  })();

  // Message listener
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    (async () => {
      if (!msg || !msg.action) return sendResponse({ ok:false, err:'bad_message' });

      if (msg.action === 'highlight') {
        // validate color
        const color = (msg.color || '').trim();
        if (!isValidHexColor(color)) return sendResponse({ ok:false, err:'invalid_color' });

        // get selection
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed || !sel.toString().trim()) return sendResponse({ ok:false, err:'no_selection' });

        try {
          // create quote metadata
          const quote = createQuoteFromSelection(sel);
          if (!quote) return sendResponse({ ok:false, err:'quote_failed' });

          // insert span at selection safely using plain-text content
          // we need to replace actual selection range with a span
          const range = sel.getRangeAt(0).cloneRange();
          const id = genId();
          insertHighlightSpanAtRange(range, quote.text, color, id);
          sel.removeAllRanges();

          // persist record (id, text, prefix, suffix, color, createdAt)
          const rec = { id, text: quote.text, prefix: quote.prefix, suffix: quote.suffix, color, createdAt: Date.now() };
          await addHighlightRecord(rec);

          return sendResponse({ ok:true, rec });
        } catch (e) {
          console.error('highlight error', e);
          return sendResponse({ ok:false, err:'exception' });
        }
      } else if (msg.action === 'clear') {
        try {
          await clearHighlights();
          return sendResponse({ ok:true });
        } catch (e) {
          console.error('clear error', e);
          return sendResponse({ ok:false });
        }
      } else if (msg.action === 'getPrefs') {
        // small helper if popup asks for something (not used heavily)
        // return page origin & path
        return sendResponse({ ok:true, origin: location.origin, path: location.pathname });
      } else {
        return sendResponse({ ok:false, err:'unknown_action' });
      }
    })();

    // indicate async response
    return true;
  });

})();
