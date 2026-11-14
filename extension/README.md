# Trace with Echo (browser extension)

**Selection pop-up.** Select a sentence on any web page (8 characters or more, not in a text field) and a small **echo. Trace** button appears at the end of the selection. Click it and Echo opens in Chrome's side panel, next to the page, and traces that sentence right away. When the selection covers links (written out, or as `<a>` links), the pop-up also offers **Check N links**, which checks those links in the side panel. The pop-up goes away when you scroll, click elsewhere or press Escape. **Alt+Shift+E** (Option+Shift+E on a Mac) does the same as **Trace** for the current selection.

**Right-click menu.** Select text and choose **Trace with Echo** to open it in a new Echo tab with the claim filled in. Select an answer with its links and choose **Check links with Echo** to open Echo's **Check these sources** panel filled with the links written in the selection and its cited sentence; right-click one link for **Check this link with Echo**. Right-click a page or link for **Find claims in this page with Echo**. Nothing is traced from a menu until you press the button in Echo.

## Set it up (about two minutes)

1. Start Echo: `npm run build` once, then `npm start` (serves `http://localhost:3000`; `npm run dev` also works for development).
2. Allow this extension in Echo. Add this line to Echo's `.env.local` and restart Echo (stop `npm start`, start it again):

   ```
   ECHO_EXTENSION_ORIGINS=chrome-extension://binkgignaekgeoklkoplgpddepbefabb
   ```

   The id is fixed by the `key` in `manifest.json`, so it is the same on every computer. The options page shows the same line with a **Copy** button. Without it, Echo refuses to appear in the side panel (the panel says "Echo did not open here" and offers **Open in a tab instead**); the right-click menu works either way.
3. Load the extension: open `chrome://extensions` (Edge: `edge://extensions`, Brave: `brave://extensions`), switch on **Developer mode** (top right), click **Load unpacked** and pick this `extension/` folder. If an older copy is loaded, click its **Reload** arrow instead.
4. Pin it: click the puzzle-piece icon in the toolbar, then the pin next to **Trace with Echo**.
5. Another Echo address (a deployed one, or another port): right-click the pinned icon → **Options**, enter the address (for example `https://echo.example`) and press **Save**. For a deployed address the browser asks once to allow that site: allow it, so the side panel's Echo has your presenter sign-in.
6. The shortcut: if Alt+Shift+E is taken, the options page says "not set"; choose one at `chrome://extensions/shortcuts`.
7. Try it: select a sentence on any page and click **echo. Trace**.

Turn the pop-up off on the options page ("Show the Echo button when I select text"); the menu and the shortcut keep working.

## Why a click can start a run, and nothing else can

The pop-up's click (or the shortcut) is the only thing that starts a run without a press in Echo itself.

- The pop-up script sends only a real click (`event.isTrusted`) from its own button, inside a closed shadow root; a page's script cannot press it. The background script takes messages only from this extension, opens the side panel and leaves one job in `chrome.storage.session` (extension pages only), good for two minutes.
- The side panel frames Echo's `/embed` page with the job filled into its address. Like every Echo address, that only fills a box: no link, bookmark or reload runs anything.
- Echo's `/embed` page posts a one-time random nonce to its parent, addressed only to the extension origins in `ECHO_EXTENSION_ORIGINS`, so only this extension's page can receive it. It runs exactly one job, from a message that comes from its parent frame, from a listed origin, with that nonce. A website that frames `/embed` is refused by its `frame-ancestors` header (only the listed extensions may frame it, and with none listed nobody may); a website or another extension that posts messages to it has the wrong origin and no nonce.
- The run itself is Echo's ordinary run: a JSON request from Echo's own page, under the presenter lock and the daily cap. No key ever reaches the extension.

`npm run check:links` forges start messages at `/embed` (wrong origins, no or wrong nonce, another window, replays, unlisted or unframed pages) and expects no run, then exactly one for the real message. `npm run smoke:ui` runs the pop-up on a real page, the side panel's handshake against a stand-in Echo, the background script against a stand-in `chrome` API, and `/embed` at 360–480 px through a mocked live run.

## What it can see

The pop-up script runs on http(s) pages and reads the selection only to place its button and to count its links; nothing leaves the page until you click. It sends the selected text (at most 500 characters) and the links in it to your Echo only. It stores the Echo address and the pop-up switch in extension storage, and the last click's job for two minutes in session storage. Permissions: `contextMenus`, `storage`, `sidePanel`; host access is optional and asked for one deployed Echo address at a time.

Where the side panel is unavailable (older Chromium), the same page opens in a tab next to yours. Firefox is not supported.

## Files

`manifest.json`; `background.js` (menus, pop-up clicks, the shortcut); `content.js` (the selection pop-up); `sidepanel.html`, `sidepanel.js`, `sidepanel.css` (the side panel and its handshake with Echo); `echo-link.js` (the links and jobs it builds, shared and tested); `options.html`, `options.js`, `options.css`; `icons/`. Echo's side: `src/app/embed/page.tsx`, `src/app/embed-bridge.ts`, `src/app/embed-view.tsx`, `src/proxy.ts`, `src/app/api/embed/route.ts`, `src/lib/echo/extension-origins.ts`.
