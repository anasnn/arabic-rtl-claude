'use strict';
/**
 * Arabic RTL Fix — Claude.ai | v1.1.0
 *
 * FIXES over v1.0.0:
 *  ✓ SPAN removed from block targets — inline elements can't carry text-align
 *  ✓ nearestBlock() now does two passes: prefers semantic blocks (P/LI/H*) over DIV
 *  ✓ React reconciliation handled: re-applies RTL at 4 intervals after stream done
 *  ✓ Persistent 3-second global rescan catches anything React wiped
 *  ✓ CDS portal divs (data-cds-portal) excluded from streaming watch
 *  ✓ isAssistantContainer() tightened — won't match structural/nav elements
 *  ✓ data-is-streaming attribute removal triggers final scan + retries
 */

// ─── Arabic detection ────────────────────────────────────────────────────────
const ARABIC_RE  = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;
const ARABIC_ALL = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/g;
const THRESHOLD  = 0.25;  // ≥25% Arabic chars → RTL block

function isArabicText(text) {
  const s = text.replace(/\s+/g, '');
  if (s.length < 2) return false;
  const m = s.match(ARABIC_ALL);
  return m ? (m.length / s.length) >= THRESHOLD : false;
}

// ─── Element classification ──────────────────────────────────────────────────
// NOTE: SPAN is deliberately NOT here — spans are inline; text-align on them
// has zero visual effect. Always climb up to a real block element.
const PREFERRED_BLOCKS = new Set([
  'P', 'LI', 'DT', 'DD',
  'TD', 'TH',
  'BLOCKQUOTE',
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'FIGCAPTION'
]);
// Only fall back to these if no preferred block is found above the text node
const FALLBACK_BLOCKS = new Set(['DIV', 'SECTION', 'ARTICLE']);

const SKIP_TAGS = new Set([
  'SCRIPT', 'STYLE', 'NOSCRIPT', 'PRE', 'CODE',
  'SVG', 'MATH',
  'BUTTON', 'INPUT', 'SELECT', 'OPTION', 'TEXTAREA',
  'NAV', 'HEADER', 'FOOTER', 'IMG', 'CANVAS', 'IFRAME', 'A'
]);

// ─── Direction helpers ───────────────────────────────────────────────────────
function setDir(el, dir) {
  if (!el || el.nodeType !== 1) return;
  el.style.setProperty('direction',  dir,                               'important');
  el.style.setProperty('text-align', dir === 'rtl' ? 'right' : 'left', 'important');
  el.setAttribute('dir', dir);
}

/**
 * Walk upward from a text node to find the nearest true block ancestor.
 * Two-pass strategy:
 *  Pass 1 — look for semantic block elements (P, LI, H1-H6, etc.)
 *  Pass 2 — fall back to generic blocks (DIV, SECTION, ARTICLE)
 *
 * This ensures that text inside <p><span>Arabic</span></p> always resolves
 * to the <p>, not the <span>.
 */
function nearestBlock(node) {
  const start = node.nodeType === 3 ? node.parentElement : node;

  // Pass 1: semantic blocks
  let el = start;
  while (el && el !== document.body) {
    if (PREFERRED_BLOCKS.has(el.tagName)) return el;
    el = el.parentElement;
  }

  // Pass 2: generic blocks
  el = start;
  while (el && el !== document.body) {
    if (FALLBACK_BLOCKS.has(el.tagName)) return el;
    el = el.parentElement;
  }

  return start; // last resort
}

// ─── Core processing ─────────────────────────────────────────────────────────
/**
 * Full scan of a subtree.
 * - Finds every text node, determines its nearest block ancestor.
 * - Marks blocks with Arabic content as RTL.
 * - Reverts blocks that lost Arabic content (e.g. regenerated response).
 * - Always authoritative: never short-circuits on existing marks.
 */
function processSubtree(root) {
  if (!root || root.nodeType !== 1) return;
  // Don't scan portals / overlays / code blocks at root level
  if (root.hasAttribute && root.hasAttribute('data-cds-portal')) return;
  if (root.tagName === 'PRE' || root.tagName === 'CODE') return;

  const walker = document.createTreeWalker(
    root,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(n) {
        const p = n.parentElement;
        if (!p) return NodeFilter.FILTER_REJECT;
        // Skip code/pre subtrees
        if (p.tagName === 'PRE'  || p.tagName === 'CODE')  return NodeFilter.FILTER_REJECT;
        if (p.closest('pre, code'))                         return NodeFilter.FILTER_REJECT;
        if (SKIP_TAGS.has(p.tagName))                       return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    }
  );

  const arabicBlocks = new Set();
  const allBlocks    = new Set();
  let node;

  while ((node = walker.nextNode())) {
    const text = node.textContent || '';
    if (text.trim().length < 2) continue;

    const block = nearestBlock(node);
    if (!block || block === document.body) continue;
    // Don't mark the scan root itself — it may be a layout wrapper
    if (block === root && FALLBACK_BLOCKS.has(root.tagName)) continue;

    allBlocks.add(block);
    if (isArabicText(text)) arabicBlocks.add(block);
  }

  // Apply RTL
  arabicBlocks.forEach(block => {
    setDir(block, 'rtl');
    block.setAttribute('data-arabic-rtl', 'rtl');

    // Code blocks inside RTL content stay LTR
    block.querySelectorAll('pre, code').forEach(c => setDir(c, 'ltr'));

    // Table: RTL every part
    const tbl = block.tagName === 'TABLE'
      ? block
      : block.querySelector('table') || block.closest('table');
    if (tbl) {
      [tbl, ...tbl.querySelectorAll('thead,tbody,tfoot,tr,td,th')]
        .forEach(c => setDir(c, 'rtl'));
    }
  });

  // Revert blocks that are no longer Arabic
  allBlocks.forEach(block => {
    if (!arabicBlocks.has(block) && block.getAttribute('data-arabic-rtl') === 'rtl') {
      setDir(block, 'ltr');
      block.setAttribute('data-arabic-rtl', 'ltr');
    }
  });
}

// ─── Streaming watcher ───────────────────────────────────────────────────────
const streamWatchers = new WeakMap();

function startStreamWatch(container) {
  // Skip portals
  if (container.hasAttribute && container.hasAttribute('data-cds-portal')) return;
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

    // Immediate scan
    processSubtree(container);

    // Re-apply at multiple delays to survive React's post-stream reconciliation.
    // React typically does its final flush within ~300 ms of streaming end.
    [120, 400, 900, 2000].forEach(ms =>
      setTimeout(() => processSubtree(container), ms)
    );
    console.log('[Arabic RTL Fix] stream done →', container);
  }

  function reschedule() {
    clearTimeout(stableTimer);
    // Apply live while still streaming — user sees RTL immediately
    processSubtree(container);
    stableTimer = setTimeout(finalise, 600);
  }

  const obs = new MutationObserver(reschedule);
  obs.observe(container, { characterData: true, childList: true, subtree: true });
  streamWatchers.set(container, obs);

  stableTimer = setTimeout(finalise, 600);
  // 30 s safety — even very long responses finish by then
  safetyTimer = setTimeout(finalise, 30_000);
}

// ─── Identify assistant message containers ───────────────────────────────────
function isAssistantContainer(el) {
  if (!el || el.nodeType !== 1) return false;
  // Hard-exclude CDS portals (tooltips, modals, dropdowns)
  if (el.hasAttribute('data-cds-portal')) return false;
  // Hard-exclude common structural elements
  if (el.closest('nav, header, footer, [role="toolbar"], [role="navigation"]')) return false;
  // Best signal: Anthropic marks streaming responses with this attribute
  if (el.hasAttribute('data-is-streaming')) return true;
  // Secondary: data-testid hints
  if (el.matches('[data-testid*="assistant"],[data-message-author-role="assistant"]')) return true;
  // Tertiary: class name heuristic (avoid false positives by requiring "message")
  const cls = (el.className || '').toString();
  if (/\bassistant\b/i.test(cls) && /\bmessage\b/i.test(cls)) return true;
  return false;
}

// ─── Input box direction syncing ─────────────────────────────────────────────
function syncInputDir(input) {
  const text = input.textContent || input.value || '';
  const dir  = ARABIC_RE.test(text) ? 'rtl' : 'ltr';
  setDir(input, dir);
  // Sync immediate children (Claude nests <p> tags inside the contenteditable)
  Array.from(input.children).forEach(child => {
    if (!SKIP_TAGS.has(child.tagName)) {
      setDir(child, ARABIC_RE.test(child.textContent || '') ? 'rtl' : 'ltr');
    }
  });
}

function attachInputObserver(input) {
  if (input.hasAttribute('data-ar-input')) return;
  input.setAttribute('data-ar-input', '1');
  let t;
  const run = () => { clearTimeout(t); t = setTimeout(() => syncInputDir(input), 30); };
  new MutationObserver(run).observe(input, { childList: true, characterData: true, subtree: true });
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
let pendingNodes = new Set();
let pendingTimer = null;

const rootObserver = new MutationObserver(mutations => {
  for (const mut of mutations) {
    for (const node of mut.addedNodes) {
      if (node.nodeType !== 1) continue;
      if (SKIP_TAGS.has(node.tagName)) continue;
      if (node.hasAttribute && node.hasAttribute('data-cds-portal')) continue;
      pendingNodes.add(node);
    }
  }
  if (!pendingNodes.size) return;
  clearTimeout(pendingTimer);
  pendingTimer = setTimeout(() => {
    const nodes = [...pendingNodes];
    pendingNodes.clear();

    // De-duplicate: drop nodes that are descendants of another node in the set
    const roots = nodes.filter(n => !nodes.some(o => o !== n && o.contains(n)));

    roots.forEach(el => {
      // Immediate scan
      processSubtree(el);
      // If it's an assistant response, set up streaming watch
      if (isAssistantContainer(el)) {
        startStreamWatch(el);
      } else {
        // Check inside for streaming elements
        el.querySelectorAll('[data-is-streaming],[data-message-author-role="assistant"]')
          .forEach(startStreamWatch);
      }
    });

    attachAllInputs();
  }, 150);
});

// ─── Initialisation ──────────────────────────────────────────────────────────
function init() {
  console.log('[Arabic RTL Fix] v1.1.0 initialising…');

  // Initial full-page scan
  processSubtree(document.body);
  attachAllInputs();

  // Watch body for new nodes
  rootObserver.observe(document.body, { childList: true, subtree: true });

  // Watch for data-is-streaming attribute being REMOVED (stream finished)
  // This is the most reliable signal that Claude has completed a response.
  new MutationObserver(mutations => {
    for (const mut of mutations) {
      if (
        mut.type === 'attributes' &&
        mut.attributeName === 'data-is-streaming' &&
        !mut.target.hasAttribute('data-is-streaming')
      ) {
        const el = mut.target;
        // Immediate scan + delayed retries to outlast React reconciliation
        processSubtree(el);
        [150, 500, 1100, 2200].forEach(ms =>
          setTimeout(() => processSubtree(el), ms)
        );
        console.log('[Arabic RTL Fix] streaming ended on', el);
      }
    }
  }).observe(document.body, {
    attributes:      true,
    attributeFilter: ['data-is-streaming'],
    subtree:         true
  });

  // ── Persistent safety net ──────────────────────────────────────────────────
  // React reconciliation can silently wipe our inline styles after any re-render.
  // A periodic rescan at 3 s catches any element that lost its RTL styling.
  setInterval(() => processSubtree(document.body), 3000);

  // Deferred initial scans — Claude renders content late
  [1000, 3000, 6000].forEach(ms =>
    setTimeout(() => processSubtree(document.body), ms)
  );

  // ── SPA navigation ─────────────────────────────────────────────────────────
  // Navigating between Claude chats changes the URL without a real page reload.
  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      console.log('[Arabic RTL Fix] SPA nav detected, re-scanning…');
      setTimeout(() => {
        processSubtree(document.body);
        attachAllInputs();
      }, 800);
    }
  }, 500);

  console.log('[Arabic RTL Fix] v1.1.0 ready ✓');
}

// ─── Bootstrap ───────────────────────────────────────────────────────────────
// Wait for Claude's React tree to render before running init().
let bootAttempts = 0;
(function boot() {
  if (
    document.querySelector('main, [class*="conversation"], [class*="message"], [data-is-streaming]') ||
    bootAttempts >= 20
  ) {
    init();
  } else {
    bootAttempts++;
    setTimeout(boot, 400);
  }
})();
