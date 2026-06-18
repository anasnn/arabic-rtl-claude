# Arabic RTL Fix — Claude.ai Chrome Extension

> **Automatically fixes Arabic right-to-left text direction on [Claude.ai](https://claude.ai) — no page refresh needed.**

---

## ✨ What It Does

Claude.ai renders all text left-to-right by default. When a response contains Arabic, the text
appears broken — letters run the wrong way, punctuation is misplaced, and lists look backwards.

This extension watches Claude's DOM in real-time and:

- **Detects Arabic text** in every new response as it streams in
- **Sets `direction: rtl`** on each Arabic block element automatically
- **Handles streaming** — applies RTL while Claude is still typing, confirmed when the response is stable
- **Never misses a response** — a root-level MutationObserver + attribute watcher catches every new bubble
- **Preserves code blocks** — `<pre>` and `<code>` are always kept LTR
- **Syncs the input box** — the textarea switches direction as you type
- **Handles SPA navigation** — detects when you switch chats and re-scans

---

## 🚀 Installation (Developer Mode)

1. Clone or download this repo
2. Open Chrome → `chrome://extensions`
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked** and select the `arabic-rtl-claude` folder
5. Navigate to [claude.ai](https://claude.ai) — done ✓

---

## 🛠 How It Works

### Detection
Text nodes are walked with `TreeWalker`. A block is marked RTL when ≥ 25 % of its
non-whitespace characters fall in Unicode Arabic ranges:

| Range | Block |
|-------|-------|
| `U+0600–U+06FF` | Arabic |
| `U+0750–U+077F` | Arabic Supplement |
| `U+08A0–U+08FF` | Arabic Extended-A |
| `U+FB50–U+FDFF` | Arabic Presentation Forms-A |
| `U+FE70–U+FEFF` | Arabic Presentation Forms-B |

### Streaming
Each assistant response container gets a dedicated `MutationObserver` that:
- Fires a live scan on every mutation (so RTL appears while Claude is still writing)
- Resets a 600 ms stability timer on each new mutation
- Disconnects after 600 ms of silence → does a final authoritative scan
- Has a 30 s absolute safety timeout for very long responses

An additional `attrObserver` watches for the `data-is-streaming` attribute being
removed — triggering a final scan the moment Claude marks a response complete.

### SPA Navigation
A 500 ms interval polls `location.href`. When the URL changes (new chat), the
extension re-scans and re-attaches all input watchers after 800 ms.

---

## 📁 Files

```
arabic-rtl-claude/
├── manifest.json   — Extension manifest (Manifest V3)
├── content.js      — Main logic (detection, MutationObserver, input sync)
├── styles.css      — RTL CSS rules (injected into claude.ai)
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

---

## 🔒 Permissions

| Permission | Reason |
|---|---|
| `https://claude.ai/*` | Only runs on Claude.ai |
| None | No other permissions required |

No external network requests. No data collection. No background service worker.

---

## 📝 Changelog

### v1.0.0
- Full rewrite: robust streaming detection, no refresh needed
- Root `MutationObserver` + `attrObserver` for `data-is-streaming`
- Per-container streaming watchers with 30 s safety timeout
- Live RTL application while Claude is still typing
- SPA navigation detection
- Deferred re-scans at 1 s, 3 s, 6 s for lazy-rendered content
- Full revert of blocks that switch from Arabic → non-Arabic on regeneration

### v0.3.2 (legacy)
- Streaming watcher with 8 s safety timeout
- Delayed rescan at 2 s and 5 s

---

## License

MIT
