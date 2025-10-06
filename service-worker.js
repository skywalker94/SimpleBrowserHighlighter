// service-worker.js - reads persisted lastColor and forwards highlight command to content script

chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'highlight-selection') {
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tabs || !tabs[0]) return;
      const tab = tabs[0];
      // only http(s)
      if (!tab.url || (!tab.url.startsWith('http://') && !tab.url.startsWith('https://'))) return;

      const PREF_KEY = 'highlighter_prefs_v1';
      // read prefs from local storage via callback wrapper
      const prefs = await new Promise((resolve) => {
        chrome.storage.local.get(PREF_KEY, (obj) => {
          resolve(obj && obj[PREF_KEY] ? obj[PREF_KEY] : { lastColor: '#fff176' });
        });
      });

      const color = (prefs && typeof prefs.lastColor === 'string' && /^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/.test(prefs.lastColor)) ? prefs.lastColor : '#fff176';

      // send a message to the content script to highlight selection with that color
      chrome.tabs.sendMessage(tab.id, { action: 'highlight', color }, (resp) => {
        if (chrome.runtime.lastError) {
          // content script not present on this page or cannot be reached
          console.warn('Could not send highlight message:', chrome.runtime.lastError.message);
        } else {
          // response handling optional
        }
      });
    } catch (e) {
      console.error('onCommand error', e);
    }
  }
});
