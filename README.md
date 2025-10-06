# 🖍️ Safe Persistent Highlighter (Chrome Extension)

A privacy-friendly Chrome extension that lets you **highlight text**, **persist highlights across page reloads**, and **quickly highlight via keyboard shortcut (`Ctrl+Shift+H`)**.  
It remembers your **last-used color**, offers **recent colors**, and includes a **VIBGYOR color palette** for quick access — all while being **secure and sandboxed** (no external scripts, no data collection).

---

## ✨ Features

### 1. Highlight selected text
- Select any text on a web page.
- Open the popup (via toolbar icon) or press **`Ctrl+Shift+H`** to highlight instantly with your last-used color.
- Highlights are inserted safely as `<span>` elements with inline background color.

### 2. Persistent highlights
- Highlights are automatically saved in Chrome’s `chrome.storage.local`.
- When you reload or revisit the same page (same URL), your highlights are restored.
- Stored data is local to your browser — never leaves your device.

### 3. Color memory and palette
- Your **last used color** is saved automatically.
- A **recents bar** (up to 5 recent colors) appears below the color picker.
- A set of **VIBGYOR color tiles** (Violet, Indigo, Blue, Green, Yellow, Orange, Red) gives you one-click quick choices.

### 4. Clear highlights
- Click **“Clear highlights”** in the popup to remove all highlights from the current page and clear them from storage.

### 5. Keyboard shortcut (`Ctrl+Shift+H`)
- Default shortcut: **Ctrl+Shift+H**
- Works on Windows, Linux, and ChromeOS.  
  On macOS, you can manually set it to **Command+Shift+H**.
- This runs the “highlight last selection” action without needing the popup.

---

## ⚙️ Installation

1. Clone or download this repository.
2. Open Chrome and navigate to `chrome://extensions/`
3. Enable **Developer mode** (top right corner).
4. Click **“Load unpacked”** and select the extension folder.
5. The “Safe Persistent Highlighter” icon will appear in your toolbar.

---

## 🎨 Usage

**From the popup:**
1. Select text on any regular webpage (HTTP/HTTPS only).
2. Click the extension icon.
3. Pick a color or one of the VIBGYOR tiles.
4. Click **“Highlight selection”** — your selection is highlighted and stored.
5. To remove highlights, click **“Clear highlights.”**

**Using the keyboard shortcut:**
1. Select text.
2. Press **`Ctrl+Shift+H`** (or `Command+Shift+H` on Mac if configured).
3. The selected text is highlighted instantly with your last-used color.

---

## 🧠 Persistence Details

Highlights are stored per-URL in `chrome.storage.local` as an array of simple range and text data (not raw HTML).  
On page load, the **content script** (`content-script.js`) reads the saved ranges and reapplies highlights safely.

The stored format avoids any injection or unsafe re-insertion of HTML, and the highlight spans are always inserted in the **extension’s isolated world** for security.

---

## 🛡️ User Privacy & Data Guarantees

#### Core Trust Principles
This extension is built on a foundation of maximum transparency and minimal intrusion. I guarantee that the code running in your browser is only what you installed, and it does not compromise your browsing data.

- ✅ **No remote code, analytics, or network requests.** The extension operates entirely offline once installed. It contains no external tracking scripts or analytics beacons, and it does not connect to any third-party servers to send or receive data, ensuring **zero data leakage**.


- ✅ Uses **only `activeTab`, `scripting`, and `storage` permissions.**  In adherence to the principle of least privilege. The extension only asks for the bare minimum permissions required to function: applying highlights to the current tab, and saving your data locally. It has **no permission to read your history, cookies, or activity on other tabs**.


- ✅ **Sanitizes all inputs (color, text).** User-provided inputs, such as custom highlight colors or text, are strictly validated and cleaned before being processed. This critical measure prevents the introduction of malicious data that could be exploited by an attacker.


- ✅ **Refuses to run on non-HTTP(S) pages (like `chrome://` or the Web Store).** For your protection, the extension is intentionally blocked from executing its code on browser-internal pages or protected domains. This sandboxing prevents potential interactions with sensitive system information.


- ✅ **Highlights are added as plain text (no HTML re-insertion) to avoid XSS risks.** When applying a highlight to a webpage, we ensure the process is strictly text-based. This avoids manipulating the page's underlying HTML structure, eliminating the most common vector for **Cross-Site Scripting (XSS)** vulnerabilities.


- ✅ All data (highlights, recents) stays **local in `chrome.storage.local`**. Your saved highlights, recent colors, and settings are stored only on your machine within the secure, private storage area managed by your browser. **No data ever leaves your device**.


<details>
<summary>Why is your <b>Data Stored Locally?</b> (No Cloud Sync)</summary>

> While the extension supports a potential implementation for cross-device synchronization using `chrome.storage.sync`, the feature has been intentionally omitted to ensure data reliability and consistency. The native sync feature is inherently limited by **strict size and item-count quotas**, meaning large highlight sets would inevitably **fail to sync** and fall back to local storage. This mixed outcome—where some user highlights are synced and others remain local—creates a confusing and unreliable user experience.

> **An added benefit of this decision is enhanced security and privacy:** your highlight data never leaves your device and is never stored on a third-party server. To prevent the frustration of incomplete or partial data transfer, all highlight data is currently kept exclusively within **local storage**.
</details>


---

## 🧰 Permissions Explained

| Permission | Why It’s Needed |
|-------------|----------------|
| `scripting` | To inject the safe highlight/clear functions into the active page when you click or use the shortcut. |
| `activeTab` | Temporarily grants access to the active tab’s content when invoked (no persistent access). |
| `storage` | To store highlights and your color preferences locally. |
| `host_permissions` | Only for `http://*/*` and `https://*/*` so highlights can persist across reloads. |

---

## ⌨️ Shortcut Tips

If `Ctrl+Shift+H` is already taken or blocked:
1. Open `chrome://extensions/shortcuts`
2. Find **“Safe Persistent Highlighter”**
3. Set a custom shortcut for **“Highlight current selection with last-used color.”**
4. You can set different bindings per OS (e.g., `Command+Shift+H` on macOS).

---

## 🧩 File Overview

| File | Purpose |
|------|----------|
| `manifest.json` | Chrome extension manifest (permissions, commands, scripts, etc.) |
| `popup.html` | The popup UI (color picker, recents, vibgyor tiles, buttons). |
| `popup.js` | Handles popup logic, color selection, and calls highlighting scripts. |
| `content-script.js` | Runs in the webpage, restores highlights on load, and applies new ones. |
| `service-worker.js` | Background worker that listens for keyboard shortcuts (`Ctrl+Shift+H`) and triggers highlighting. |
| `README.md` | This documentation file. |

---

## 💡 Tips & Best Practices

- Highlights only work on normal web pages. They **do not work** on Chrome internal pages, PDF viewers, or sites that isolate scripts (like Google Docs).  
- Avoid highlighting very large chunks of text across multiple complex HTML elements — browsers handle smaller highlights more reliably.
- To change your default color quickly, just use the popup and select a new one — it’ll become your new default.
- You can export/import highlights by reading from `chrome.storage.local` in the DevTools console if needed (advanced use).

---

## 🧱 Technical Security & Hardening

* **All highlighting is done using text nodes only (no HTML injection).** This design choice completely bypasses the risks associated with dynamically adding new HTML elements, which is a common source of code execution vulnerabilities.
* **Color values are validated with strict regex (`#RGB` / `#RRGGBB`).** All user-defined color inputs are aggressively scrubbed and matched against strict patterns before use. This prevents attackers from injecting malicious code fragments into style attributes.
* **Each highlight span is tagged with a unique class name (`__simple_ext_highlight_safe`) and optional `data-ext-origin` attribute.** Using a unique, prefixed class ensures the extension's styles and scripts do not interfere with the website's original CSS or functionality (i.e., avoids style collisions).
* **Clearing highlights only removes spans created by the extension.** The cleanup function is narrowly scoped to target only elements bearing the extension's unique class name, guaranteeing that no other content or elements on the page are accidentally deleted or modified.
* **Error messages are shown in the popup UI — no `alert()` calls on the page.** All user feedback, especially error reporting, is contained within the secure extension popup. This prevents using disruptive and often-abused native browser functions like `alert()` on the main webpage, maintaining a clean user experience.

---

## 🧾 License and Usage Rights

This software is distributed under the **MIT License**, which means you are legally granted the freedom to:

* **Use** and **Modify** the code for any purpose.
* **Distribute** and **Sell** the software, either in its original form or as part of a larger, proprietary application.

In short: you are legally **free to do almost anything** with this code.

### 🙏 A Humble Ethical Request

While the license grants you broad freedoms, I **humbly request** that you refrain from:

* **Reselling or redistributing** this work as a standalone product.
* **Bundling it with third-party analytics or trackers** that compromise user privacy.

This request is purely ethical and is made to protect the spirit of this project as a tool focused on user privacy and freedom.

### ⚠️ Important Note for Users

Please be aware that while the original software is free of such practices, **forks or different versions of this software may include analytics or trackers**. It is the subsequent developer’s choice whether to implement these features. Therefore, we urge you to **always be vigilant and exercise caution** when using any modified or derivative versions of this extension.

---



### Author Note

Built with ❤️ for learning secure, privacy-respecting Chrome extension development.
Hope you enjoy using it!
    - skysha
