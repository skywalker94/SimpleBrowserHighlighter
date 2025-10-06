// service-worker.js
// Listens for keyboard command and forwards to active tab to highlight
chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'highlight-selection') {
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tabs || !tabs[0]) return;
      const tab = tabs[0];
      // only http(s)
      if (!tab.url || (!tab.url.startsWith('http://') && !tab.url.startsWith('https://'))) return;
      // get last color from prefs
      const PREF_KEY = 'highlighter_prefs_v1';
      const prefs = (await chrome.storage.local.get(PREF_KEY))[PREF_KEY] || { lastColor: '#fff176' };
      // validate
      const color = (typeof prefs.lastColor === 'string' && /^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/.test(prefs.lastColor)) ? prefs.lastColor : '#fff176';

      // send a message to the content script to highlight selection with that color
      chrome.tabs.sendMessage(tab.id, { action: 'highlight', color }, (resp) => {
        // optionally handle response here. No UI in service worker.
        if (chrome.runtime.lastError) {
          // content script not present on this page or cannot be reached
          console.warn('Could not send highlight message:', chrome.runtime.lastError.message);
        } else {
          // if resp and ok, we could update recents, but content script persists highlights already
        }
      });
    } catch (e) {
      console.error('onCommand error', e);
    }
  }
});
