// Echo's right-click menu, its selection pop-up and its keyboard shortcut.
// Menu: selected text opens in a new Echo tab as ?claim=…, which only fills the claim box; a selection's links (or
// one right-clicked link) open as ?urls=…&claim=…, which only fills the Check these sources panel. Nothing is traced
// (and nothing is spent) until the reader presses the button in Echo.
// Pop-up and shortcut (content.js): a click on the pop-up's button, or the shortcut, opens Echo in the side panel
// and hands it one job; the side panel (sidepanel.js) asks Echo for that one run. The job lives in
// chrome.storage.session (extension pages only; a web page or content script cannot write it) for two minutes, and
// the side panel takes it once.
importScripts("echo-link.js");

const { DEFAULT_SITE, claimLink, pageLink, sourcesLink, linkSourcesLink, popupJob } = globalThis.EchoLink;
const JOB_KEY = "echoJob";
const WEB_PAGES = ["http://*/*", "https://*/*"];

chrome.runtime.onInstalled.addListener(() => {
  // onInstalled also fires on update and reload, so clear first: a duplicate id would fail.
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: "echo-trace-selection", title: "Trace with Echo", contexts: ["selection"] });
    chrome.contextMenus.create({ id: "echo-check-links", title: "Check links with Echo", contexts: ["selection"] });
    chrome.contextMenus.create({ id: "echo-check-link", title: "Check this link with Echo", contexts: ["link"], targetUrlPatterns: WEB_PAGES });
    chrome.contextMenus.create({ id: "echo-read-link", title: "Find claims in the linked page with Echo", contexts: ["link"], targetUrlPatterns: WEB_PAGES });
    chrome.contextMenus.create({ id: "echo-read-page", title: "Find claims in this page with Echo", contexts: ["page"], documentUrlPatterns: WEB_PAGES });
  });
});

async function echoSite() {
  try {
    const { echoSite: site } = await chrome.storage.sync.get({ echoSite: DEFAULT_SITE });
    return site;
  } catch {
    return DEFAULT_SITE;
  }
}

async function openInEcho(url, tab) {
  // Next to the tab the reader was on, when the browser says which one that was.
  const placement = tab && tab.id !== undefined && tab.id >= 0 ? { index: tab.index + 1, openerTabId: tab.id } : {};
  try {
    await chrome.tabs.create({ url, ...placement });
  } catch {
    await chrome.tabs.create({ url });
  }
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const site = await echoSite();
  if (info.menuItemId === "echo-trace-selection") await openInEcho(claimLink(site, info.selectionText), tab);
  else if (info.menuItemId === "echo-check-links") await openInEcho(sourcesLink(site, info.selectionText), tab);
  else if (info.menuItemId === "echo-check-link") await openInEcho(linkSourcesLink(site, info.linkUrl), tab);
  else if (info.menuItemId === "echo-read-link") await openInEcho(pageLink(site, info.linkUrl), tab);
  else if (info.menuItemId === "echo-read-page") await openInEcho(pageLink(site, info.pageUrl), tab);
});

// The toolbar button opens Echo itself, empty.
chrome.action.onClicked.addListener(async (tab) => {
  await openInEcho(claimLink(await echoSite(), ""), tab);
});

// ---- The selection pop-up and the shortcut: Echo in the side panel -------------------------------------------------

// The side panel page itself, in a tab: where the browser has no side panel (or would not open it).
async function openPanelTab(tab) {
  await openInEcho(chrome.runtime.getURL("sidepanel.html?tab=1"), tab);
}

// Opens the side panel next to `tab`. Called first, with nothing awaited before it: the browser allows
// sidePanel.open() only while the reader's click or key press is being handled.
function openPanel(tab) {
  let opening = null;
  try {
    if (chrome.sidePanel?.open && tab?.windowId !== undefined) opening = chrome.sidePanel.open({ windowId: tab.windowId });
  } catch {
    opening = null;
  }
  if (!opening) return openPanelTab(tab);
  return Promise.resolve(opening).catch(() => openPanelTab(tab));
}

// The job the side panel takes once; "none" (the shortcut with nothing selected) shows a hint instead of a run.
async function handOver(job) {
  const record = { ...(job ?? { kind: "none" }), id: crypto.randomUUID(), at: Date.now() };
  try {
    await chrome.storage.session.set({ [JOB_KEY]: record });
  } catch {
    // No session storage: the side panel opens Echo empty.
  }
}

// A click on the pop-up's Trace or Check links button (content.js sends it only for a trusted click).
chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type !== "echo:popup" || !sender.tab || sender.id !== chrome.runtime.id) return;
  const job = popupJob(message.action === "links" ? "links" : "trace", message.text, message.pageLinks);
  if (!job) return;
  void openPanel(sender.tab);
  void handOver(job);
});

// The shortcut (Alt+Shift+E by default): the selection on the current page, as the pop-up's Trace would send it.
chrome.commands?.onCommand.addListener((command, tab) => {
  if (command !== "trace-selection" || !tab || tab.id === undefined) return;
  void openPanel(tab);
  void (async () => {
    let selection = null;
    try {
      selection = await chrome.tabs.sendMessage(tab.id, { type: "echo:get-selection" });
    } catch {
      // No pop-up script on this page (a browser page, or a tab opened before the extension was installed).
    }
    await handOver(selection ? popupJob("trace", selection.text, selection.pageLinks) : null);
  })();
});
