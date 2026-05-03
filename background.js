// ── AI Accessibility — Background Service Worker v4 ──────────────────────────
//
// Two jobs:
//   1. RELAY — proxy /caption and /classify calls from content.js to the
//              FastAPI backend. Service workers bypass restrictive CORS
//              headers that block content-script fetch on some sites.
//   2. NAV   — track tabs with active voice nav; auto-restart after
//              page navigation destroys the content script.

const BACKEND = "http://localhost:5000";
const voiceNavTabs = new Set();

async function callBackend(path, body) {
  const resp = await fetch(`${BACKEND}${path}`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify(body),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.detail || `HTTP ${resp.status}`);
  }
  return resp.json();
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {

  if (request.action === "startVoiceNavigation" && sender.tab)
    voiceNavTabs.add(sender.tab.id);
  if (request.action === "stopVoiceNavigation" && sender.tab)
    voiceNavTabs.delete(sender.tab.id);

  // ── Relay: image captioning ──────────────────────────────────────────────
  if (request.action === "bgCaption") {
    callBackend("/caption", { image_url: request.imageUrl })
      .then(d  => sendResponse({ caption: d.caption, source: d.source }))
      .catch(e => sendResponse({ error: e.message }));
    return true;
  }

  // ── Relay: complexity classify ───────────────────────────────────────────
  if (request.action === "bgClassify") {
    callBackend("/classify", { text: request.text })
      .then(d  => sendResponse(d))
      .catch(e => sendResponse({ error: e.message, label: "simple", confidence: 0 }));
    return true;
  }

  // ── Health check ─────────────────────────────────────────────────────────
  if (request.action === "bgHealth") {
    fetch(`${BACKEND}/health`)
      .then(r  => r.json())
      .then(d  => sendResponse({ ok: true, ...d }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  return false;
});

// ── Auto-restart voice nav after navigation ───────────────────────────────────
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete")   return;
  if (!voiceNavTabs.has(tabId))           return;
  if (!tab.url || tab.url.startsWith("chrome://") || tab.url.startsWith("about:")) {
    voiceNavTabs.delete(tabId); return;
  }
  const attempt = (delay) => setTimeout(() => {
    chrome.tabs.sendMessage(
      tabId,
      { action: "startVoiceNavigation", resumedAfterNav: true },
      (resp) => {
        if (chrome.runtime.lastError && delay < 3500) attempt(delay + 1500);
        if (resp && resp.error) voiceNavTabs.delete(tabId);
      }
    );
  }, delay);
  attempt(1000);
});

chrome.tabs.onRemoved.addListener(tabId => voiceNavTabs.delete(tabId));
