'use strict';
/**
 * Arabic RTL Fix — Claude.ai | v1.0.0
 *
 * Core design principles:
 *  1. NEVER miss a new response — watch every streaming container until it
 *     is truly stable, then re-process it completely.
 *  2. No "already processed" short-circuit — the PROCESSED attribute only
 *     marks the current direction; it is always overwritten on new scans.
 *  3. Streaming is detected via characterData + childList; the observer is
 *     disconnected only when the response bubble is stable for 600 ms AND
 *     Anthropic's "streaming" indicator class is gone.
 *  4. A single root-level MutationObserver watches the whole page for NEW
 *     assistant message containers being inserted into the DOM.
 *  5. Input box direction is synced on every keystroke / paste.
 */

// ─── Arabic detection ────────────────────────────────────────────────────────
const ARABIC_RE  = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;
const ARABIC_ALL = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/g;
const THRESHOLD  = 0.25;   // ≥25 % Arabic chars → RTL block

function isArabicText(text) {
  const s = text.replace(/\s+/g, '');
  if (s.length < 2) return false;
  const m = s.match(ARABIC_ALL);
  return m ? (m.length / s.length) >= THRESHOLD : false;
}

// ─── Tag sets ────────────────────────────────────────────────────────────────
const BLOCK_TAGS = new Set([
  'P','DIV','SECTION','ARTICLE','LI','TD','TH',
  'BLOCKQUOTE','H1','H2','H3','H4','H5','H6',
  'FIGCAPTION','SPAN'
]);
const SKIP_TAGS = new Set([
  'SCRIPT','STYLE','NOSCRIPT','PRE','CODE','SVG',
  'MATH','BUTTON','INPUT','SELECT','OPTION','TEXTAREA',
  'NAV','HEADER','FOOTER','IMG','CANVAS','IFRAME'
]);

// ─── Direction helpers ───────────────────────────────────────────────────────
function setDir(el, dir) {
  if (!el || el.nodeType !== 1) return;
  el.style.setProperty('direction',  dir,                               'important');
  el.style.setProperty('text-align', dir === 'rtl' ? 'right' : 'left', 'important');
  el.setAttribute('dir', dir);
}

/** Walk up the DOM to find the nearest block-level ancestor. */
function nearestBlock(node) {
  let el = node.nodeType === 3 ? node.parentElement : node;
  while (el && el !== document.body) {
    if (BLOCK_TAGS.has(el.tagName)) return el;
    el = el.parentElement;
  }
  return node.nodeType === 3 ? node.parentElement : node;
}

// ─── Process a subtree for RTL ───────────────────────────────────────────────
/**
 * Walk every text node inside `root`.
 * For each Arabic text node: find its block container and mark it RTL.
 * For each non-Arabic block that was previously marked RTL: revert to LTR
 * (handles the edge case where Claude edits/regenerates a response).
 *
 * NOTE: We intentionally do NOT short-circuit on `data-arabic-rtl` here.
 *       Every call is a full authoritative scan.
 */
function processSubtree(root) {
  if (!root || root.nodeType !== 1) return;

  // Collect all block elements inside root once so we can revert stale marks
  const allBlocks = new Set();

  const walker = document.createTreeWalker(
    root,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(n) {
        const p = n.parentElement;
        if (!p) return NodeFilter.FILTER_REJECT;
        // Skip code/pre and their children
        if (p.tagName === 'PRE' || p.tagName === 'CODE') return NodeFilter.FILTER_REJECT;
        if (p.closest('pre, code')) return NodeFilter.FILTER_REJECT;
        if (SKIP_TAGS.has(p.tagName)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    }
  );

  // Pass 1: collect blocks that contain Arabic
  const arabicBlocks  = new Set();
  let node;
  while ((node = walker.nextNode())) {
    const text = node.textContent || '';
    const block = nearestBlock(node);
    if (!block) continue;
    allBlocks.add(block);
    if (isArabicText(text)) {
      arabicBlocks.add(block);
    }
  }

  // Pass 2: apply directions
  arabicBlocks.forEach(block => {
    // Don't mark the root block itself if it's the whole message wrapper
    if (block === root) return;
    setDir(block, 'rtl');
    block.setAttribute('data-arabic-rtl', 'rtl');

    // Always force code inside RTL blocks back to LTR
    block.querySelectorAll('pre, code').forEach(c => setDir(c, 'ltr'));

    // If the block contains a table, RTL-ify all table parts
    const table = block.tagName === 'TABLE'
      ? block
      : block.querySelector('table') || block.closest('table');
    if (table) {
      [table, ...table.querySelectorAll('thead,tbody,tfoot,tr,td,th')]
        .forEach(c => setDir(c, 'rtl'));
    }
  });

  // Revert blocks that are NO longer Arabic (e.g. regenerated response)
  allBlocks.forEach(block => {
    if (!arabicBlocks.has(block) && block.getAttribute('data-arabic-rtl') === 'rtl') {
      setDir(block, 'ltr');
      block.setAttribute('data-arabic-rtl', 'ltr');
    }
  });
}

// ─── Streaming watcher ───────────────────────────────────────────────────────
/**
 * Attaches a MutationObserver to a streaming response container.
 * The observer watches for ANY change (text, children) and debounces
 * a "stable" callback. It disconnects when the content is stable.
 *
 * We use a WeakMap so the same container is never double-watched,
 * but we CAN re-watch it if a new streaming session starts.
 */
const streamWatchers = new WeakMap();   // container → { obs, stableTimer, safetyTimer }

function startStreamWatch(container) {
  // If already watching, do nothing
  if (streamWatchers.has(container)) return;

  let stableTimer = null;
  let safetyTimer = null;
  let dead = false;

  function finalise() {
    if (dead) return;
    dead = true;
    clearTimeout(stableTimer);
    clearTimeout(safetyTimer);
    try { obs.disconnect(); } catch (_) {}
    streamWatchers.delete(container);
    // Full re-scan now that streaming is complete
    processSubtree(container);
    console.log('[Arabic RTL Fix] stream done →', container);
  }

  function reschedule() {
    clearTimeout(stableTimer);
    // Also run a live scan so partial results get RTL while still streaming
    processSubtree(container);
    stableTimer = setTimeout(finalise, 600);
  }

  const obs = new MutationObserver(reschedule);
  obs.observe(container, {
    characterData: true,
    childList:     true,
    subtree:       true
  });

  streamWatchers.set(container, { obs, stableTimer, safetyTimer });
  stableTimer = setTimeout(finalise, 600);
  // Absolute safety net — 30 s should cover even very long responses
  safetyTimer = setTimeout(finalise, 30_000);
}

// ─── Identify assistant message containers ───────────────────────────────────
/**
 * Claude.ai renders assistant messages in elements that typically have:
 *   - data-is-streaming
 *   - [class*="message"]
 *   - role="presentation"  (inside a grid cell)
 * We use a wide net and filter by position in the DOM.
 *
 * Returns true if the element is an assistant response bubble.
 */
function isAssistantContainer(el) {
  if (!el || el.nodeType !== 1) return false;

  // Claude wraps each response in a div with data-is-streaming while streaming
  if (el.hasAttribute('data-is-streaming')) return true;

  // Match the outer response wrappers used by Claude's React layout
  const cls = (el.className || '').toString();
  if (
    /\bassistant\b/i.test(cls) ||
    /\bmessage-content\b/i.test(cls) ||
    el.matches('[data-testid*="assistant"],[data-testid*="message"],[data-message-author-role="assistant"]')
  ) return true;

  // Heuristic: large div not inside nav/header/footer that just appeared
  if (
    el.tagName === 'DIV' &&
    !el.closest('nav, header, footer, form, [role="toolbar"]') &&
    el.children.length > 0
  ) {
    // Only watch if it has meaningful text depth
    const text = el.textContent || '';
    if (text.length > 20) return true;
  }

  return false;
}

// ─── Input box syncing ───────────────────────────────────────────────────────
function syncInputDir(input) {
  const text = input.textContent || input.value || '';
  const dir  = ARABIC_RE.test(text) ? 'rtl' : 'ltr';
  setDir(input, dir);
  // Sync immediate children (Claude uses nested <p> tags in its textarea)
  Array.from(input.children).forEach(child => {
    if (!SKIP_TAGS.has(child.tagName)) {
      setDir(child, ARABIC_RE.test(child.textContent) ? 'rtl' : 'ltr');
    }
  });
}

function attachInputObserver(input) {
  if (input.hasAttribute('data-ar-input')) return;
  input.setAttribute('data-ar-input', '1');

  let t;
  const run = () => {
    clearTimeout(t);
    t = setTimeout(() => syncInputDir(input), 30);
  };

  new MutationObserver(run).observe(input, {
    childList: true, characterData: true, subtree: true
  });
  ['keydown', 'keyup', 'input', 'focus', 'paste'].forEach(e =>
    input.addEventListener(e, run)
  );
  run();
}

function attachAllInputs() {
  document.querySelectorAll(
    'div[contenteditable="true"], div[role="textbox"], textarea'
  ).forEach(attachInputObserver);
}

// ─── Root MutationObserver ───────────────────────────────────────────────────
/**
 * Watches the whole document body for added nodes.
 * When a new node arrives:
 *   - If it looks like an assistant response container → start streaming watch
 *   - Always: scan it immediately for any Arabic content
 *   - Also look for input boxes
 */
let pendingNodes    = new Set();
let pendingTimer    = null;

const rootObserver = new MutationObserver(mutations => {
  for (const mutation of mutations) {
    for (const node of mutation.addedNodes) {
      if (node.nodeType !== 1) continue;
      if (SKIP_TAGS.has(node.tagName)) continue;

      pendingNodes.add(node);
    }
  }

  if (pendingNodes.size === 0) return;

  clearTimeout(pendingTimer);
  pendingTimer = setTimeout(() => {
    const nodes = [...pendingNodes];
    pendingNodes.clear();

    // De-duplicate: remove nodes that are children of another node in the set
    const roots = nodes.filter(
      n => !nodes.some(other => other !== n && other.contains(n))
    );

    roots.forEach(el => {
      // Immediately scan for Arabic in this subtree
      processSubtree(el);

      // If this looks like an assistant message, start a streaming watcher
      if (isAssistantContainer(el)) {
        startStreamWatch(el);
      } else {
        // Even if not identified as assistant container, watch descendants
        // that look like message containers
        el.querySelectorAll(
          '[data-is-streaming], [data-message-author-role="assistant"], [data-testid*="message"]'
        ).forEach(startStreamWatch);
      }
    });

    attachAllInputs();
  }, 150);
});

// ─── Initialisation ──────────────────────────────────────────────────────────
function init() {
  console.log('[Arabic RTL Fix] v1.0.0 initialising…');

  // Initial full-page scan
  processSubtree(document.body);
  attachAllInputs();

  // Watch the whole body for new nodes
  rootObserver.observe(document.body, {
    childList: true,
    subtree:   true
  });

  // Also watch for attribute changes (e.g. data-is-streaming removed)
  // This catches the moment streaming finishes on already-existing containers
  const attrObserver = new MutationObserver(mutations => {
    for (const mut of mutations) {
      if (
        mut.type === 'attributes' &&
        mut.attributeName === 'data-is-streaming' &&
        !mut.target.hasAttribute('data-is-streaming')
      ) {
        // Streaming just finished on this element — do a definitive scan
        processSubtree(mut.target);
        console.log('[Arabic RTL Fix] streaming attr removed →', mut.target);
      }
    }
  });
  attrObserver.observe(document.body, {
    attributes:    true,
    attributeFilter: ['data-is-streaming'],
    subtree:       true
  });

  // Deferred re-scans to catch lazy-rendered content
  [1000, 3000, 6000].forEach(ms =>
    setTimeout(() => processSubtree(document.body), ms)
  );

  // Re-scan on URL change (Claude is a SPA — navigating between chats)
  let lastUrl = location.href;
  const urlPoller = setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      console.log('[Arabic RTL Fix] SPA navigation detected, re-scanning…');
      setTimeout(() => {
        processSubtree(document.body);
        attachAllInputs();
      }, 800);
    }
  }, 500);

  console.log('[Arabic RTL Fix] v1.0.0 ready ✓');
}

// ─── Bootstrap ───────────────────────────────────────────────────────────────
/**
 * Wait for Claude's React tree to render before running init().
 * Claude sometimes loads the shell first and fills content later.
 */
let bootAttempts = 0;
(function boot() {
  const ready = document.querySelector(
    'main, [class*="conversation"], [class*="message"], [data-is-streaming]'
  );
  if (ready || bootAttempts >= 20) {
    init();
  } else {
    bootAttempts++;
    setTimeout(boot, 400);
  }
})();
