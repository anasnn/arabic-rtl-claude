# Arabic RTL Fix — Claude.ai Chrome Extension

> **Automatically fixes Arabic right-to-left text direction on [Claude.ai](https://claude.ai) — no page refresh needed.**

---

## ⬇️ Direct Download

**[⬇ Download arabic-rtl-claude.zip](https://github.com/anasnn/arabic-rtl-claude/archive/refs/heads/main.zip)**

> After downloading, unzip the file. You'll get a folder called `arabic-rtl-claude-main` — load **that folder** in Chrome (see Installation below).

---

## 🚀 Installation (Developer Mode)

1. **[⬇ Download the ZIP](https://github.com/anasnn/arabic-rtl-claude/archive/refs/heads/main.zip)** and unzip it
2. Open Chrome → go to **`chrome://extensions`**
3. Enable **Developer mode** (toggle in the top-right corner)
4. Click **Load unpacked**
5. Select the **`arabic-rtl-claude-main`** folder inside the unzipped archive
6. Navigate to [claude.ai](https://claude.ai) — done ✓

---

## ✨ What It Does

Claude.ai renders all text left-to-right by default. When a response contains Arabic, the text
appears broken — letters run the wrong way, punctuation is misplaced, and lists look backwards.

This extension watches Claude's DOM in real-time and:

- **Detects Arabic text** in every new response as it streams in
- **Sets `direction: rtl`** on each Arabic block element automatically
- **Handles streaming** — applies RTL while Claude is still typing, re-confirmed when the response is stable
- **Never misses a response** — root MutationObserver + `data-is-streaming` attribute watcher
- **Handles React reconciliation** — re-applies RTL at 120ms / 400ms / 900ms / 2000ms after each response
- **Persistent 3s rescan** — catches anything React quietly cleared
- **Preserves code blocks** — `<pre>` and `<code>` are always kept LTR
- **Syncs the input box** — the textarea switches direction as you type
- **Handles SPA navigation** — detects when you switch chats and re-scans

---

## 🛠 How It Works

### Detection
Text nodes are walked with `TreeWalker`. A block is marked RTL when ≥ 25% of its
non-whitespace characters fall in Unicode Arabic ranges:

| Range | Block |
|-------|-------|
| `U+0600–U+06FF` | Arabic |
| `U+0750–U+077F` | Arabic Supplement |
| `U+08A0–U+08FF` | Arabic Extended-A |
| `U+FB50–U+FDFF` | Arabic Presentation Forms-A |
| `U+FE70–U+FEFF` | Arabic Presentation Forms-B |

### Block Targeting (two-pass strategy)
For each Arabic text node, `nearestBlock()` runs two passes:
1. **Pass 1** — climb upward looking for semantic block elements: `P`, `LI`, `H1-H6`, `BLOCKQUOTE`, `TD`, `TH`, etc.
2. **Pass 2** — if no semantic block found, fall back to generic blocks: `DIV`, `SECTION`, `ARTICLE`

Inline elements (`SPAN` etc.) are intentionally excluded — `text-align: right` has no visual effect on them.

### Streaming
Each assistant response container gets a dedicated `MutationObserver` that:
- Fires a live scan on every mutation (RTL appears while Claude is still writing)
- Resets a 600ms stability timer on each new mutation
- Disconnects after 600ms of silence → does final scan + retries at 120ms / 400ms / 900ms / 2000ms
- Has a 30s absolute safety timeout for very long responses

An `attrObserver` also watches for `data-is-streaming` being removed, triggering a final scan + 4 retries the moment Claude marks a response complete.

### Persistent Safety Net
A global `setInterval` re-scans the entire page every 3 seconds. This catches any RTL styling that React's virtual DOM reconciliation silently cleared after a re-render.

### SPA Navigation
A 500ms interval polls `location.href`. When the URL changes (new chat), the extension re-scans and re-attaches all input watchers after 800ms.

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

### v1.1.0
- **Fix**: `SPAN` removed from block targets — inline elements can't carry `text-align`
- **Fix**: `nearestBlock()` two-pass strategy: prefers semantic blocks over `DIV`
- **Fix**: React reconciliation retries at 120ms / 400ms / 900ms / 2000ms after stream done
- **Fix**: `data-is-streaming` removal triggers scan + 4 retries
- **Fix**: CDS portal divs (`data-cds-portal`) excluded from stream watchers
- **New**: Persistent 3-second global rescan as a continuous safety net
- **New**: Live RTL applied while Claude is still typing

### v1.0.0
- Full rewrite: robust streaming detection, no refresh needed
- Root `MutationObserver` + `attrObserver` for `data-is-streaming`
- Per-container streaming watchers with 30s safety timeout
- SPA navigation detection

### v0.3.2 (legacy)
- Streaming watcher with 8s safety timeout

---

## License

MIT
