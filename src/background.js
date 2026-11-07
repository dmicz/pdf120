// Service worker: routes PDFs to the viewer.
//
// Two interception paths:
//  1. declarativeNetRequest redirects top-level navigations to http(s) URLs
//     whose path ends in ".pdf" before any bytes are downloaded.
//  2. content.js runs at document_start everywhere (including file://) and
//     reports documents whose contentType is application/pdf, which catches
//     PDFs served from URLs without a .pdf extension and local files.
//
// "Open in Chrome's viewer" adds a per-tab bypass (a session DNR allow rule
// plus a flag the content-script path checks).

const VIEWER = chrome.runtime.getURL("viewer.html");
const REDIRECT_RULE_ID = 1;
const BYPASS_RULE_BASE = 1000;

async function installRules() {
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [REDIRECT_RULE_ID],
    addRules: [
      {
        id: REDIRECT_RULE_ID,
        priority: 1,
        action: {
          type: "redirect",
          // The original URL goes in the fragment so its own query string
          // survives untouched.
          redirect: { regexSubstitution: `${VIEWER}#\\0` },
        },
        condition: {
          regexFilter: "^https?://[^?#]*\\.pdf(?:[?#].*)?$",
          isUrlFilterCaseSensitive: false,
          resourceTypes: ["main_frame"],
        },
      },
    ],
  });
}

chrome.runtime.onInstalled.addListener(installRules);
chrome.runtime.onStartup.addListener(installRules);

const bypassKey = (tabId) => `bypass:${tabId}`;

async function isBypassed(tabId) {
  const key = bypassKey(tabId);
  return !!(await chrome.storage.session.get(key))[key];
}

async function setBypass(tabId) {
  await chrome.storage.session.set({ [bypassKey(tabId)]: true });
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [BYPASS_RULE_BASE + tabId],
    addRules: [
      {
        id: BYPASS_RULE_BASE + tabId,
        priority: 2,
        action: { type: "allow" },
        condition: { tabIds: [tabId], resourceTypes: ["main_frame"] },
      },
    ],
  });
}

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove(bypassKey(tabId));
  chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [BYPASS_RULE_BASE + tabId] });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender.tab?.id;
  if (tabId == null) return;
  if (msg?.type === "pdf-detected") {
    // From content.js: a top-level document turned out to be a PDF.
    isBypassed(tabId).then((bypassed) => {
      sendResponse({ redirect: !bypassed });
      if (!bypassed) chrome.tabs.update(tabId, { url: `${VIEWER}#${msg.url}` });
    });
    return true;
  }
  if (msg?.type === "open-native") {
    // From the viewer: show this URL in Chrome's built-in viewer instead.
    setBypass(tabId).then(() => chrome.tabs.update(tabId, { url: msg.url }));
  }
});

// Toolbar button opens an empty viewer (drop or pick a local file).
chrome.action.onClicked.addListener(() => chrome.tabs.create({ url: VIEWER }));
