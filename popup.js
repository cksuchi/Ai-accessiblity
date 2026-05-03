// ── Helpers ──────────────────────────────────────────────────────────────────

function sendMessageToActiveTab(message, callback) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs.length) return;
    const tab = tabs[0];

    if (
      tab.url.startsWith("chrome://") ||
      tab.url.startsWith("chrome-extension://") ||
      tab.url.startsWith("edge://") ||
      tab.url.startsWith("about:")
    ) {
      alert("Cannot run on this page.");
      return;
    }

    chrome.tabs.sendMessage(tab.id, message, (response) => {
      if (chrome.runtime.lastError) {
        console.error("Message failed:", chrome.runtime.lastError.message);
        if (callback) callback(null);
      } else if (callback) {
        callback(response);
      }
    });
  });
}

function setStatus(elementId, text, isError = false) {
  const el = document.getElementById(elementId);
  if (!el) return;
  el.textContent = text;
  el.style.color = isError ? "#ff6666" : "#00ffcc";
}

function setButtonLoading(btn, loading, originalText) {
  btn.disabled = loading;
  btn.textContent = loading ? "⏳ Working…" : originalText;
}

// ── Warn on internal pages ────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs.length) return;
    const tab = tabs[0];
    if (
      tab.url.startsWith("chrome://") ||
      tab.url.startsWith("chrome-extension://") ||
      tab.url.startsWith("edge://") ||
      tab.url.startsWith("about:")
    ) {
      const warningDiv = document.createElement("div");
      warningDiv.style.cssText =
        "background:#fff3cd;color:#856404;padding:10px;margin:10px 0;border-radius:5px;font-size:12px;text-align:center;";
      warningDiv.textContent =
        "⚠️ Cannot work on browser internal pages. Navigate to a regular website.";
      document.body.insertBefore(warningDiv, document.body.firstChild);
      document.querySelectorAll("button").forEach((btn) => {
        btn.disabled = true;
        btn.style.opacity = "0.5";
      });
    }
  });
});

// ── 0. Scout Auditor ──────────────────────────────────────────────────────────

document.getElementById("scout-btn").addEventListener("click", () => {
  const btn = document.getElementById("scout-btn");
  setButtonLoading(btn, true, "🔍 Re-run Scout Audit");
  setStatus("scout-status", "Scanning…");
  sendMessageToActiveTab({ action: "runScout" }, (response) => {
    setButtonLoading(btn, false, "🔍 Re-run Scout Audit");
    if (!response) { setStatus("scout-status", "❌ Could not reach page.", true); return; }
    if (response.error) { setStatus("scout-status", "❌ " + response.error, true); return; }
    setStatus("scout-status", "✅ Done — see page highlights");
  });
});

// ── 1. Image Captioning ───────────────────────────────────────────────────────

const captionBtn = document.getElementById("caption-btn");
captionBtn.addEventListener("click", () => {
  setButtonLoading(captionBtn, true, "🤖 Caption All Images");
  setStatus("caption-status", "Finding images…");

  sendMessageToActiveTab({ action: "captionImages" }, (response) => {
    setButtonLoading(captionBtn, false, "🤖 Caption All Images");
    if (!response) {
      setStatus("caption-status", "❌ Could not reach page.", true);
      return;
    }
    if (response.count === 0 && response.error) {
      setStatus("caption-status", "❌ " + response.error, true);
    } else if (response.error) {
      setStatus("caption-status", `⚠️ ${response.count}/${response.total} captioned. ${response.error}`, true);
    } else {
      setStatus("caption-status", `✅ Captioned ${response.count} of ${response.total} image(s)`);
    }
  });
});

// ── 2. Text Simplification ───────────────────────────────────────────────────

let textSimplified = false;
const simplifyBtn = document.getElementById("simplify-btn");
const restoreBtn = document.getElementById("restore-text-btn");

simplifyBtn.addEventListener("click", () => {
  setButtonLoading(simplifyBtn, true, "🧠 Simplify Page Text");
  setStatus("simplify-status", "Extracting text…");

  sendMessageToActiveTab({ action: "simplifyText" }, (response) => {
    setButtonLoading(simplifyBtn, false, "🧠 Simplify Page Text");
    if (!response) {
      setStatus("simplify-status", "❌ Could not reach page.", true);
      return;
    }
    if (response.error) {
      setStatus("simplify-status", "❌ " + response.error, true);
    } else {
      textSimplified = true;
      restoreBtn.style.display = "block";
      setStatus("simplify-status", "✅ Text simplified!");
    }
  });
});

restoreBtn.addEventListener("click", () => {
  sendMessageToActiveTab({ action: "restoreText" }, () => {
    textSimplified = false;
    restoreBtn.style.display = "none";
    setStatus("simplify-status", "↩ Original text restored.");
  });
});

// ── 3. Voice Navigation ──────────────────────────────────────────────────────

let voiceNavActive = false;
const voiceNavBtn = document.getElementById("voice-nav-btn");
const voiceHint = document.getElementById("voice-hint");

voiceNavBtn.addEventListener("click", () => {
  voiceNavActive = !voiceNavActive;

  if (voiceNavActive) {
    voiceNavBtn.textContent = "🛑 Stop Voice Navigation";
    voiceNavBtn.classList.add("active");
    voiceHint.style.display = "block";
    setStatus("voice-nav-status", "🎤 Listening for commands…");
    sendMessageToActiveTab({ action: "startVoiceNavigation" }, (res) => {
      if (!res || res.error) {
        voiceNavActive = false;
        voiceNavBtn.textContent = "🎙 Start Voice Navigation";
        voiceNavBtn.classList.remove("active");
        voiceHint.style.display = "none";
        setStatus("voice-nav-status", "❌ " + ((res && res.error) || "Failed"), true);
      }
    });
  } else {
    voiceNavBtn.textContent = "🎙 Start Voice Navigation";
    voiceNavBtn.classList.remove("active");
    voiceHint.style.display = "none";
    setStatus("voice-nav-status", "Stopped.");
    sendMessageToActiveTab({ action: "stopVoiceNavigation" });
  }
});

// ── 4. Voice Form Filling ────────────────────────────────────────────────────

document.getElementById("voice-fill-btn").addEventListener("click", () => {
  const button = document.getElementById("voice-fill-btn");
  const originalText = button.textContent;
  button.textContent = "🔄 Starting…";
  button.disabled = true;

  sendMessageToActiveTab({ action: "startVoiceFormFilling" }, (response) => {
    if (response && response.status) {
      button.textContent = "✅ Started!";
      button.style.background = "#28a745";
      setTimeout(() => window.close(), 800);
    } else {
      button.textContent = originalText;
      button.disabled = false;
      button.style.background = "";
    }
  });
});

// ── 5. Video Controls ─────────────────────────────────────────────────────────

document.querySelectorAll(".video-btn").forEach((button) => {
  button.addEventListener("click", () => {
    const command = button.getAttribute("data-video-command");
    const originalText = button.textContent;
    button.textContent = "⏳";
    button.disabled = true;

    sendMessageToActiveTab({ action: "videoControl", command }, (response) => {
      if (response && response.status) {
        button.textContent = "✅";
        setTimeout(() => {
          button.textContent = originalText;
          button.disabled = false;
        }, 1200);
      } else {
        button.textContent = originalText;
        button.disabled = false;
        if (response && response.error && response.error.includes("No videos")) {
          alert("No videos found on this page.");
        }
      }
    });
  });
});

// ── 6. Visual Filters — with toggle off (FIX 1) ──────────────────────────────

// High Contrast toggle (was already toggled, kept as-is)
let isContrastOn = false;
document.getElementById("contrast-btn").addEventListener("click", () => {
  isContrastOn = !isContrastOn;
  sendMessageToActiveTab({ action: isContrastOn ? "highContrast" : "removeContrast" });
  document.getElementById("contrast-btn").textContent = isContrastOn
    ? "✅ Disable High Contrast"
    : "🌓 High Contrast";
});

// Protanopia toggle
let isProtanopiaOn = false;
document.getElementById("protanopia-btn").addEventListener("click", () => {
  isProtanopiaOn = !isProtanopiaOn;
  sendMessageToActiveTab({ action: isProtanopiaOn ? "protanopia" : "removeProtanopia" });
  document.getElementById("protanopia-btn").textContent = isProtanopiaOn
    ? "✅ Disable Protanopia"
    : "🔴 Protanopia";
});

// Deuteranopia toggle
let isDeuteranopiaOn = false;
document.getElementById("deuteranopia-btn").addEventListener("click", () => {
  isDeuteranopiaOn = !isDeuteranopiaOn;
  sendMessageToActiveTab({ action: isDeuteranopiaOn ? "deuteranopia" : "removeDeuteranopia" });
  document.getElementById("deuteranopia-btn").textContent = isDeuteranopiaOn
    ? "✅ Disable Deuteranopia"
    : "🟢 Deuteranopia";
});

// Dyslexia mode toggle
let isDyslexiaOn = false;
document.getElementById("dyslexia-btn").addEventListener("click", () => {
  isDyslexiaOn = !isDyslexiaOn;
  sendMessageToActiveTab({ action: isDyslexiaOn ? "dyslexia" : "removeDyslexia" });
  document.getElementById("dyslexia-btn").textContent = isDyslexiaOn
    ? "✅ Disable Dyslexia Mode"
    : "📖 Dyslexia Mode";
});

// Big Text toggle
let isBigTextOn = false;
document.getElementById("text-btn").addEventListener("click", () => {
  isBigTextOn = !isBigTextOn;
  sendMessageToActiveTab({ action: isBigTextOn ? "bigText" : "removeBigText" });
  document.getElementById("text-btn").textContent = isBigTextOn
    ? "✅ Restore Text Size"
    : "🔍 Increase Text";
});
