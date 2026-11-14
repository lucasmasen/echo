// The selection pop-up: select a sentence (8 characters or more) on a web page and a small Echo button appears at the
// end of the selection. "Trace" sends the selected text, "Check N links" the links it covers, to the background
// script, which opens Echo in the side panel. Only a real click on the button (event.isTrusted) or the keyboard
// shortcut sends anything; the page cannot press it (a closed shadow root, and synthetic clicks are ignored).
// Nothing is read from the page until a selection is made, and nothing leaves the page until the button is clicked.
// Turn it off on the extension's options page ("Show the Echo button when I select text").
(function () {
  "use strict";

  if (globalThis.__echoSelectionPopup) return;
  globalThis.__echoSelectionPopup = true;

  const { linksIn, MAX_LINKS } = globalThis.EchoLink;
  const MIN_SELECTION = 8;
  const GAP = 8;
  const EDGE = 8;
  let enabled = true;
  let host = null;
  let shadow = null;
  let panel = null;
  let current = null; // { text, links } of the selection the pop-up is showing for

  // ---- The setting -------------------------------------------------------------------------------------------------
  try {
    chrome.storage.sync.get({ echoPopup: true }).then(({ echoPopup }) => { enabled = echoPopup !== false; if (!enabled) hide(); }, () => {});
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "sync" && changes.echoPopup) { enabled = changes.echoPopup.newValue !== false; if (!enabled) hide(); }
    });
  } catch {
    // No extension storage (the page was reloaded under an old copy of the extension): keep the default.
  }

  // ---- What is selected ----------------------------------------------------------------------------------------------
  // True inside a text field, password field, select or editable area: the pop-up never shows there.
  function isEditable(node) {
    const element = node && (node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement);
    if (!element) return false;
    if (element.closest("input, textarea, select, [contenteditable=''], [contenteditable='true'], [contenteditable='plaintext-only']")) return true;
    return Boolean(element.isContentEditable);
  }

  // The http(s) links the selection covers: its <a href>s (shown as words or buttons, not written out) and a link the
  // whole selection sits inside. Written-out addresses are found in the text by linksIn.
  function linksInRange(range) {
    const found = [];
    const add = (href) => {
      try {
        const url = new URL(href, document.baseURI);
        if (url.protocol === "http:" || url.protocol === "https:") found.push(url.href);
      } catch {
        // Not an address.
      }
    };
    try {
      for (const anchor of range.cloneContents().querySelectorAll("a[href]")) add(anchor.getAttribute("href"));
      const start = range.commonAncestorContainer;
      const inside = (start.nodeType === Node.ELEMENT_NODE ? start : start.parentElement)?.closest("a[href]");
      if (inside) add(inside.getAttribute("href"));
    } catch {
      // A range the page changed under us: the written-out links still count.
    }
    return found.slice(0, MAX_LINKS * 2);
  }

  // The selection the pop-up (or the shortcut) would send, or null: too short, collapsed, or in an editable field.
  function readSelection() {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
    if (isEditable(selection.anchorNode) || isEditable(selection.focusNode) || isEditable(document.activeElement && document.activeElement !== document.body ? document.activeElement : null)) return null;
    const raw = selection.toString();
    if (raw.replace(/\s+/g, " ").trim().length < MIN_SELECTION) return null;
    const range = selection.getRangeAt(selection.rangeCount - 1);
    const pageLinks = linksInRange(range);
    const links = linksIn(`${raw}\n${pageLinks.join("\n")}`);
    return { text: raw.slice(0, 20_000), pageLinks, links, range, backward: isBackward(selection) };
  }

  function isBackward(selection) {
    if (!selection.anchorNode || !selection.focusNode) return false;
    if (selection.anchorNode === selection.focusNode) return selection.focusOffset < selection.anchorOffset;
    return Boolean(selection.anchorNode.compareDocumentPosition(selection.focusNode) & Node.DOCUMENT_POSITION_PRECEDING);
  }

  // ---- The pop-up ----------------------------------------------------------------------------------------------------
  function build() {
    host = document.createElement("echo-selection-popup");
    // Fixed, on top, out of the page's flow (no layout shift); every page style reset on the host itself.
    host.setAttribute("style", "all: initial !important; position: fixed !important; z-index: 2147483647 !important; top: 0 !important; left: 0 !important; display: none !important;");
    shadow = host.attachShadow({ mode: "closed" });
    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        .bar { display: flex; align-items: stretch; gap: 2px; padding: 3px; border: 1px solid #c9dcd0; border-radius: 9px; background: #fffefa; box-shadow: 0 6px 22px rgba(24, 51, 49, 0.18); font: 600 12px/1 Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; color: #183331; }
        button { all: unset; display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 10px; border-radius: 6px; cursor: pointer; white-space: nowrap; color: #183331; font: inherit; }
        button:hover { background: #dcece5; }
        button:focus-visible { outline: 2px solid #4d8982; outline-offset: 1px; }
        .trace { color: #fff; background: #2e6f68; }
        .trace:hover { background: #24605a; }
        .mark { font-weight: 800; letter-spacing: -0.5px; }
        .mark span { color: #b9e0d6; }
        [hidden] { display: none; }
      </style>
      <div class="bar" role="toolbar" aria-label="Echo">
        <button class="trace" type="button" data-action="trace" title="Trace this claim with Echo, in the side panel"><span class="mark">echo<span>.</span></span> Trace</button>
        <button class="links" type="button" data-action="links" title="Check the links in this selection with Echo, in the side panel" hidden>Check links</button>
      </div>`;
    panel = shadow.querySelector(".bar");
    // Keep the page's selection when the button is pressed (no focus move, no collapse).
    panel.addEventListener("mousedown", (event) => { event.preventDefault(); event.stopPropagation(); });
    panel.addEventListener("click", (event) => {
      const button = event.target instanceof Element ? event.target.closest("button[data-action]") : null;
      // Only a person's click: a page script's el.click() or dispatchEvent() is not trusted.
      if (!button || !event.isTrusted || !current) return;
      event.preventDefault();
      event.stopPropagation();
      send(button.dataset.action === "links" ? "links" : "trace", current);
      hide();
    });
    document.documentElement.appendChild(host);
  }

  function send(action, selection) {
    try {
      chrome.runtime.sendMessage({ type: "echo:popup", action, text: selection.text, pageLinks: selection.pageLinks }).catch(() => {});
    } catch {
      // The extension was reloaded or removed; this page's copy of the script can no longer reach it.
    }
  }

  function show(selection) {
    if (!host || !host.isConnected) build();
    current = selection;
    const linkButton = shadow.querySelector(".links");
    linkButton.hidden = !selection.links.length;
    linkButton.textContent = selection.links.length === 1 ? "Check 1 link" : `Check ${selection.links.length} links`;
    host.style.setProperty("display", "block", "important");
    host.style.setProperty("visibility", "hidden", "important");
    const rects = [...selection.range.getClientRects()].filter((rect) => rect.width || rect.height);
    const box = rects.length ? (selection.backward ? rects[0] : rects[rects.length - 1]) : selection.range.getBoundingClientRect();
    const { width, height } = panel.getBoundingClientRect();
    const viewWidth = document.documentElement.clientWidth || window.innerWidth;
    const viewHeight = document.documentElement.clientHeight || window.innerHeight;
    // At the selection's end (its start, for a selection made right to left), just below it; above it when there is
    // no room below; always inside the viewport.
    const x = selection.backward ? box.left : box.right - width;
    let top = box.bottom + GAP;
    if (top + height > viewHeight - EDGE) top = box.top - height - GAP;
    const left = Math.min(Math.max(EDGE, x), Math.max(EDGE, viewWidth - width - EDGE));
    top = Math.min(Math.max(EDGE, top), Math.max(EDGE, viewHeight - height - EDGE));
    host.style.setProperty("left", `${Math.round(left)}px`, "important");
    host.style.setProperty("top", `${Math.round(top)}px`, "important");
    host.style.setProperty("visibility", "visible", "important");
  }

  function hide() {
    current = null;
    if (host) host.style.setProperty("display", "none", "important");
  }

  const fromPopup = (event) => Boolean(host && event.composedPath().includes(host));

  // After a mouse or keyboard selection ends: show for a usable selection, hide otherwise.
  function update(event) {
    if (event && fromPopup(event)) return;
    window.setTimeout(() => {
      if (!enabled) return hide();
      const selection = readSelection();
      if (selection) show(selection); else hide();
    }, 0);
  }

  document.addEventListener("mouseup", update, true);
  document.addEventListener("keyup", (event) => { if (event.key === "Shift" || event.shiftKey) update(event); }, true);
  document.addEventListener("mousedown", (event) => { if (!fromPopup(event)) hide(); }, true);
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") hide(); }, true);
  document.addEventListener("selectionchange", () => { if (current && !readSelection()) hide(); });
  window.addEventListener("scroll", hide, true);
  window.addEventListener("resize", hide);
  window.addEventListener("blur", hide);

  // The keyboard shortcut (background.js asks): the current selection, by the same rules as the pop-up.
  try {
    chrome.runtime.onMessage.addListener((message, _sender, reply) => {
      if (message?.type !== "echo:get-selection") return;
      const selection = readSelection();
      hide();
      reply(selection ? { text: selection.text, pageLinks: selection.pageLinks, links: selection.links.length } : null);
    });
  } catch {
    // As above: an orphaned copy of the script.
  }

})();
