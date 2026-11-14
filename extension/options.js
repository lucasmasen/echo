// Settings page: which Echo the extension opens (chrome.storage.sync `echoSite`, an origin), whether the selection
// pop-up shows (`echoPopup`, on by default), and the line Echo needs to accept the side panel's start message.
(function () {
  "use strict";

  const { DEFAULT_SITE, normalizeSite } = globalThis.EchoLink;
  const form = document.getElementById("site-form");
  const input = document.getElementById("site");
  const status = document.getElementById("status");
  const reset = document.getElementById("reset");
  const popup = document.getElementById("popup");
  const popupStatus = document.getElementById("popup-status");
  const originLine = document.getElementById("origin-line");
  const local = (site) => /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(site);

  function say(message, isError) {
    status.textContent = message;
    status.classList.toggle("error", Boolean(isError));
    input.setAttribute("aria-invalid", isError ? "true" : "false");
  }

  // A deployed Echo with a presenter lock needs its sign-in cookie in the side panel's frame; the browser sends it
  // there only for a site the extension may access. Asked during the Save click (the browser requires a click), and
  // never for localhost. Declining changes nothing else.
  function askForSite(site) {
    if (local(site) || !chrome.permissions?.request) return;
    try {
      chrome.permissions.request({ origins: [`${site}/*`] }).catch(() => {});
    } catch {
      // Not offered by this browser.
    }
  }

  async function save(value) {
    try {
      await chrome.storage.sync.set({ echoSite: value });
      input.value = value;
      say(`Saved. Right-click → Trace with Echo now opens ${value}.`, false);
    } catch {
      say("Could not save the setting. Reload this page and try again.", true);
    }
  }

  chrome.storage.sync.get({ echoSite: DEFAULT_SITE, echoPopup: true }).then(({ echoSite, echoPopup }) => {
    input.value = echoSite;
    popup.checked = echoPopup !== false;
  }, () => {
    input.value = DEFAULT_SITE;
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const site = normalizeSite(input.value);
    if (!site) {
      say("That is not a web address. Use one starting with http:// or https://, for example http://localhost:3000.", true);
      input.focus();
      return;
    }
    askForSite(site);
    void save(site);
  });

  reset.addEventListener("click", () => void save(DEFAULT_SITE));

  popup.addEventListener("change", async () => {
    try {
      await chrome.storage.sync.set({ echoPopup: popup.checked });
      popupStatus.textContent = popup.checked ? "On: select text on a page to see the Echo button." : "Off: the pop-up stays hidden. The right-click menu and the shortcut still work.";
    } catch {
      popupStatus.textContent = "Could not save the setting. Reload this page and try again.";
    }
  });

  // This extension's own origin, for ECHO_EXTENSION_ORIGINS.
  const origin = chrome.runtime?.id ? `chrome-extension://${chrome.runtime.id}` : location.origin;
  originLine.textContent = `ECHO_EXTENSION_ORIGINS=${origin}`;
  document.getElementById("origin-copy").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    try {
      await navigator.clipboard.writeText(originLine.textContent);
      button.textContent = "Copied";
    } catch {
      button.textContent = "Copy failed";
    }
    window.setTimeout(() => { button.textContent = "Copy"; }, 1_600);
  });

  // The shortcut the browser actually assigned (another extension may hold Alt+Shift+E), and where to change it.
  chrome.commands?.getAll?.().then((commands) => {
    const command = commands.find((entry) => entry.name === "trace-selection");
    document.getElementById("shortcut").textContent = command?.shortcut || "not set";
  }, () => {});
  document.getElementById("shortcut-change").addEventListener("click", () => {
    if (chrome.tabs?.create) void chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
  });
})();
