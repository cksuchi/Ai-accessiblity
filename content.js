// ── AI Accessibility Assistant — Content Script v4 ───────────────────────────
'use strict';

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

// ── Form filler state ─────────────────────────────────────────────────────────
let recognition       = null;
let currentInputIndex = 0;
let inputs            = [];
let isListening       = false;
let retryCount        = 0;
let _fillingLocked    = false;
let _silenceTimer     = null;
const SILENCE_MS      = 1400;
const MAX_RETRIES     = 3;

// ── Injected stylesheet ───────────────────────────────────────────────────────
const _styleEl = document.createElement("style");
_styleEl.textContent = `
  html.accessibility-high-contrast,
  body.accessibility-high-contrast {
    filter: contrast(180%) brightness(130%) !important;
    background-color: black !important; color: white !important;
  }
  html.accessibility-high-contrast * {
    background-color: black !important; color: white !important; border-color: white !important;
  }
  img.ai-scout-missing-alt  { outline: 3px solid #ff3b30 !important; outline-offset: 2px; }
  .ai-scout-complex-text    { background: rgba(255,200,0,0.18) !important; border-left: 4px solid #ffcc00 !important; padding-left: 6px !important; }
  .ai-caption-overlay       { position:absolute; bottom:0; left:0; right:0; background:rgba(0,0,0,0.78); color:#fff; font-size:11px; padding:4px 6px; z-index:9999; pointer-events:none; line-height:1.4; border-radius:0 0 4px 4px; font-family:Arial,sans-serif; }
  .ai-scout-badge           { position:absolute; top:4px; left:4px; background:#ff3b30; color:#fff; font-size:10px; padding:2px 5px; border-radius:4px; font-family:Arial,sans-serif; font-weight:bold; z-index:9999; pointer-events:none; }
`;
document.head.appendChild(_styleEl);

// ── Background relay helpers ──────────────────────────────────────────────────
function bgCaption(imageUrl) {
  return new Promise((res, rej) => {
    chrome.runtime.sendMessage({ action: "bgCaption", imageUrl }, (r) => {
      if (chrome.runtime.lastError) return rej(new Error(chrome.runtime.lastError.message));
      if (r && r.error) return rej(new Error(r.error));
      res(r);
    });
  });
}

function bgClassify(text) {
  return new Promise((res, rej) => {
    chrome.runtime.sendMessage({ action: "bgClassify", text }, (r) => {
      if (chrome.runtime.lastError) return rej(new Error(chrome.runtime.lastError.message));
      if (r && r.error) return rej(new Error(r.error));
      res(r);
    });
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// SCOUT AUDITOR  — runs on page load, flags accessibility issues proactively
// ═════════════════════════════════════════════════════════════════════════════
let _scoutRan = false;

async function runScoutAuditor() {
  if (_scoutRan) return;
  _scoutRan = true;

  // Flag images with missing/trivial alt text
  let flaggedImgs = 0;
  document.querySelectorAll("img").forEach(img => {
    const alt     = (img.alt || "").trim().toLowerCase();
    const trivial = !alt || ["image","photo","img","picture","figure"].includes(alt);
    if (!trivial || img.width < 30 || img.height < 30) return;

    img.classList.add("ai-scout-missing-alt");
    const parent = img.parentElement;
    if (window.getComputedStyle(parent).position === "static") {
      parent.style.position = "relative";
      parent.style.display  = "inline-block";
    }
    const badge = document.createElement("div");
    badge.className   = "ai-scout-badge";
    badge.textContent = "⚠ No Alt";
    parent.appendChild(badge);
    flaggedImgs++;
  });

  // Classify paragraphs, highlight complex ones
  let flaggedParas = 0;
  const paras = Array.from(document.querySelectorAll("p, li, blockquote"))
    .filter(el => {
      const t = (el.innerText || "").trim();
      return t.length > 80 && !el.closest("nav, footer, header, script, style");
    })
    .slice(0, 20);

  for (const el of paras) {
    try {
      const result = await bgClassify((el.innerText || "").trim());
      if (result && result.should_simplify) {
        el.classList.add("ai-scout-complex-text");
        el.title = `⚙ AI: ${result.label} (${(result.confidence*100).toFixed(0)}%) | FK: ${result.features.flesch_kincaid_grade}`;
        flaggedParas++;
      }
    } catch (_) { /* backend not running — skip */ }
  }

  _showToast(
    `🔍 Scout: ${flaggedImgs} image(s) missing alt · ${flaggedParas} complex paragraph(s) flagged`,
    7000, "#1a1a2e", "#e2b96f"
  );
}

if (document.readyState === "complete") setTimeout(runScoutAuditor, 2000);
else window.addEventListener("load", () => setTimeout(runScoutAuditor, 2000));

// ═════════════════════════════════════════════════════════════════════════════
// IMAGE CAPTIONING
// ═════════════════════════════════════════════════════════════════════════════
async function captionAllImages() {
  const images = Array.from(document.querySelectorAll("img")).filter(img => {
    if (!img.src || img.width < 30 || img.height < 30) return false;
    const cs = window.getComputedStyle(img);
    return cs.display !== "none" && cs.visibility !== "hidden";
  });

  if (!images.length)
    return { count: 0, total: 0, error: "No visible images found on this page." };

  let captioned = 0, errors = 0;

  for (let i = 0; i < images.length; i += 3) {
    await Promise.all(images.slice(i, i + 3).map(async img => {
      try {
        const url = new URL(img.src, location.href).href;
        if (url.startsWith("data:") && url.length > 1_000_000) return;
        if (!url.startsWith("http") && !url.startsWith("data:"))  return;

        const result  = await bgCaption(url);   // routed via background.js
        const caption = result.caption;
        if (!caption) return;

        // Dynamic DOM Injection — heal the page
        img.alt = caption;
        img.classList.remove("ai-scout-missing-alt");
        img.parentElement.querySelector(".ai-scout-badge")?.remove();
        _injectCaptionOverlay(img, caption, result.source);

        // Inject semantic <figcaption> if inside a <figure>
        if (img.parentElement.tagName === "FIGURE"
            && !img.parentElement.querySelector("figcaption")) {
          const fc = document.createElement("figcaption");
          fc.textContent = "🤖 " + caption;
          fc.style.cssText = "font-size:12px;color:#555;font-style:italic;margin-top:4px;";
          img.parentElement.appendChild(fc);
        }

        captioned++;
      } catch (e) {
        console.warn("[Caption]", img.src?.slice(0, 60), e.message);
        errors++;
      }
    }));
  }

  if (captioned === 0 && errors > 0)
    return { count: 0, total: images.length,
             error: `All ${images.length} image(s) failed. Is the backend running?` };
  return { count: captioned, total: images.length };
}

function _injectCaptionOverlay(img, caption, source) {
  img.parentElement.querySelector(".ai-caption-overlay")?.remove();
  const ov = document.createElement("div");
  ov.className   = "ai-caption-overlay";
  ov.textContent = `🤖 ${caption}` + (source ? ` [${source}]` : "");
  const ps = window.getComputedStyle(img.parentElement);
  if (ps.position === "static") {
    img.parentElement.style.position = "relative";
    img.parentElement.style.display  = "inline-block";
  }
  img.parentElement.appendChild(ov);
}

// ═════════════════════════════════════════════════════════════════════════════
// TEXT SIMPLIFICATION
// ═════════════════════════════════════════════════════════════════════════════
const _origMap = new WeakMap();

async function simplifyPageText() {
  const BACKEND = "http://localhost:5000";
  const candidates = Array.from(
    document.querySelectorAll("p, h1, h2, h3, h4, article, [role='main'] p")
  ).filter(el => {
    const t = (el.innerText || "").trim();
    return t.length > 60 && !el.closest("nav, footer, header, script, style");
  });
  if (!candidates.length) return { error: "No substantial text found." };

  let simplified = 0;
  for (const el of candidates.slice(0, 10)) {
    try {
      const orig = (el.innerText || "").trim();
      if (!_origMap.has(el)) _origMap.set(el, el.innerHTML);
      const r = await fetch(`${BACKEND}/simplify`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: orig, max_length: 130 }),
      });
      if (!r.ok) continue;
      const d = await r.json();
      if (d.simplified && d.simplified !== orig) {
        el.innerHTML = `<span style="border-left:3px solid #00bfff;padding-left:6px;font-style:italic;">`
                     + _esc(d.simplified) + `</span>`;
        simplified++;
      }
    } catch (_) {}
  }
  return { count: simplified };
}

function restoreOriginalText() {
  document.querySelectorAll("p, h1, h2, h3, h4, article").forEach(el => {
    if (_origMap.has(el)) el.innerHTML = _origMap.get(el);
  });
}

function _esc(t) {
  return t.replace(/&/g,"&amp;").replace(/</g,"&lt;")
          .replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

// ═════════════════════════════════════════════════════════════════════════════
// VIDEO CONTROLS
// ═════════════════════════════════════════════════════════════════════════════
function controlVideos(cmd) {
  document.querySelectorAll("video").forEach(v => {
    if      (cmd === "play")    v.play();
    else if (cmd === "pause")   v.pause();
    else if (cmd === "rewind")  v.currentTime = Math.max(0, v.currentTime - 10);
    else if (cmd === "forward") v.currentTime = Math.min(v.duration || 0, v.currentTime + 10);
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// VOICE NAVIGATION
// ═════════════════════════════════════════════════════════════════════════════
let _navRecognition = null;
let _navActive      = false;
let _currentZoom    = 1.0;

const NAV_COMMANDS = [
  { p: /scroll down/i,         f: () => window.scrollBy({ top:  300, behavior:"smooth" }) },
  { p: /scroll up/i,           f: () => window.scrollBy({ top: -300, behavior:"smooth" }) },
  { p: /scroll (to )?top/i,    f: () => window.scrollTo({ top: 0,    behavior:"smooth" }) },
  { p: /scroll (to )?bottom/i, f: () => window.scrollTo({ top: document.body.scrollHeight, behavior:"smooth" }) },
  { p: /go back/i,             f: () => history.back() },
  { p: /go forward/i,          f: () => history.forward() },
  { p: /zoom in/i,             f: () => { _currentZoom = Math.min(2, _currentZoom+0.1); document.body.style.zoom = _currentZoom; } },
  { p: /zoom out/i,            f: () => { _currentZoom = Math.max(.5,_currentZoom-0.1); document.body.style.zoom = _currentZoom; } },
  { p: /read page/i,           f: () => { speechSynthesis.cancel(); const u=new SpeechSynthesisUtterance(document.body.innerText.slice(0,3000)); u.lang="en-US"; speechSynthesis.speak(u); } },
  { p: /stop reading/i,        f: () => speechSynthesis.cancel() },
  { p: /fill form/i,           f: () => startVoiceFormFilling() },
  { p: /stop/i,                f: () => stopVoiceNavigation() },
];

function _handleNavCommand(transcript) {
  const lower = transcript.toLowerCase().trim();
  const click = lower.match(/^click (.+)$/i);
  if (click) {
    const txt    = click[1].trim();
    const target = Array.from(document.querySelectorAll("a,button"))
                        .find(el => (el.textContent||"").toLowerCase().includes(txt));
    if (target) { target.scrollIntoView({ behavior:"smooth", block:"center" }); target.click(); _navFeedback(`Clicked: ${target.textContent.trim().slice(0,40)}`); }
    else         { _navFeedback(`No element: "${txt}"`); }
    return;
  }
  for (const cmd of NAV_COMMANDS) {
    if (cmd.p.test(lower)) { cmd.f(); _navFeedback(`✔ ${lower}`); return; }
  }
  _navFeedback(`? "${transcript}" — not recognised`);
}

function _navFeedback(msg) { _showToast("🎤 " + msg, 2500, "rgba(0,0,0,0.82)", "#00ffcc"); }

function _navCreateAndStart() {
  if (!_navActive) return;
  if (_navRecognition) {
    try { _navRecognition.onresult = _navRecognition.onerror = _navRecognition.onend = null; } catch(_){}
    try { _navRecognition.abort(); } catch(_){}
    _navRecognition = null;
  }
  _navRecognition = new SpeechRecognition();
  _navRecognition.lang = "en-US"; _navRecognition.continuous = true;
  _navRecognition.interimResults = false; _navRecognition.maxAlternatives = 1;
  _navRecognition.onresult = e => _handleNavCommand(e.results[e.results.length-1][0].transcript);
  _navRecognition.onerror  = e => {
    if (!_navActive) return;
    if (e.error === "not-allowed" || e.error === "service-not-allowed") { _navActive = false; _navFeedback("Mic denied."); return; }
    setTimeout(_navCreateAndStart, 1000);
  };
  _navRecognition.onend = () => { if (_navActive) setTimeout(_navCreateAndStart, 500); };
  try { _navRecognition.start(); } catch(e) { if (_navActive) setTimeout(_navCreateAndStart, 1000); }
}

function startVoiceNavigation(resumedAfterNav = false) {
  if (!SpeechRecognition) return { error: "Speech Recognition not supported." };
  if (_navActive)          return { status: "already active" };
  _navActive = true;
  _navCreateAndStart();
  _navFeedback(resumedAfterNav ? "🔄 Voice nav resumed" : "Voice navigation active");
  return { status: "Voice navigation started" };
}

function stopVoiceNavigation() {
  _navActive = false;
  if (_navRecognition) {
    try { _navRecognition.onresult = _navRecognition.onerror = _navRecognition.onend = null; } catch(_){}
    try { _navRecognition.stop(); } catch(_){}
    _navRecognition = null;
  }
  speechSynthesis.cancel();
  _navFeedback("Voice navigation stopped");
}

// ═════════════════════════════════════════════════════════════════════════════
// VOICE FORM FILLING  (silence-detection, classifier-guided prompt)
// ═════════════════════════════════════════════════════════════════════════════
const FIELD_PATTERNS = {
  email:   ["email","e-mail","mail"],
  phone:   ["phone","tel","mobile"],
  name:    ["name","first","last","full"],
  address: ["address","street","city","zip","postal"],
  date:    ["date","birth","dob","birthday"],
  password:["password","pass","pwd"],
  comment: ["comment","message","note","feedback"],
};

const VOICE_CORRECTIONS = {
  "at":"@","dot":".","dash":"-","underscore":"_",
  "zero":"0","one":"1","two":"2","three":"3","four":"4",
  "five":"5","six":"6","seven":"7","eight":"8","nine":"9",
};

function startVoiceFormFilling() {
  if (!SpeechRecognition) { alert("Speech Recognition not supported."); return; }
  inputs = Array.from(document.querySelectorAll("input,textarea,select")).filter(el =>
    !el.disabled && el.offsetParent !== null &&
    !["hidden","submit","button"].includes(el.type) &&
    window.getComputedStyle(el).display !== "none"
  );
  if (!inputs.length) { alert("No form inputs found."); return; }
  currentInputIndex = 0; retryCount = 0; _fillingLocked = false;
  if (recognition) { try { recognition.abort(); } catch(_){} recognition = null; }
  _showVoiceStatus(`🎙 Starting — ${inputs.length} field(s) found`);
  setTimeout(() => startListeningForField(), 1000);
}

function _setupRecognition() {
  recognition = new SpeechRecognition();
  recognition.lang = "en-US"; recognition.continuous = true;
  recognition.interimResults = true; recognition.maxAlternatives = 1;
  let _lastInterim = "";

  recognition.onstart = () => {
    isListening = true; _lastInterim = "";
    const inp = inputs[currentInputIndex];
    inp.style.outline = "3px solid #007bff";
    inp.style.boxShadow = "0 0 10px rgba(0,123,255,0.5)";
    _showVoiceStatus(`🎤 Listening for: ${_fieldLabel(currentInputIndex)}`);
  };

  recognition.onresult = e => {
    if (_fillingLocked) return;
    let interim = "", finals = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const t = e.results[i][0].transcript;
      e.results[i].isFinal ? (finals += t) : (interim += t);
    }
    const cur = (finals || interim).trim();
    if (!cur) return;
    _lastInterim = cur;
    _showVoiceStatus(`🎤 Heard: "${cur}" …`);
    clearTimeout(_silenceTimer);
    _silenceTimer = setTimeout(() => {
      if (_fillingLocked) return;
      const committed = _lastInterim.trim();
      if (!committed) return;
      _fillingLocked = true;
      fillCurrentField(_processVoice(committed, inputs[currentInputIndex]));
    }, SILENCE_MS);
  };

  recognition.onerror = e => {
    if (e.error === "no-speech") return;
    isListening = false; clearTimeout(_silenceTimer);
    if (e.error === "audio-capture" && ++retryCount < MAX_RETRIES) {
      _showVoiceStatus(`No mic. Retry ${retryCount}/${MAX_RETRIES}…`);
      _fillingLocked = false; setTimeout(startListeningForField, 1500); return;
    }
    _fillingLocked = false;
    setTimeout(() => { if (currentInputIndex < inputs.length) startListeningForField(); }, 2000);
  };

  recognition.onend = () => {
    isListening = false;
    if (!_fillingLocked && currentInputIndex < inputs.length) {
      try { recognition.start(); } catch(_){}
    }
  };
}

function focusInput(i) {
  if (i < inputs.length) {
    inputs[i].focus();
    inputs[i].scrollIntoView({ behavior:"smooth", block:"center" });
  }
}

function fillCurrentField(value) {
  const inp = inputs[currentInputIndex];
  inp.style.outline = inp.style.boxShadow = "";

  const setter = inp.tagName === "TEXTAREA"
    ? Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")
    : Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value");

  if (inp.tagName === "SELECT") {
    const lo = value.toLowerCase();
    const opt = Array.from(inp.options).find(
      o => o.text.toLowerCase().includes(lo) || o.value.toLowerCase().includes(lo));
    if (opt) inp.value = opt.value;
  } else if (setter) {
    setter.set.call(inp, value);
  } else {
    inp.value = value;
  }
  inp.dispatchEvent(new Event("input",  { bubbles:true }));
  inp.dispatchEvent(new Event("change", { bubbles:true }));
  _showVoiceStatus(`✅ Filled "${_fieldLabel(currentInputIndex)}" → ${value}`);

  currentInputIndex++; retryCount = 0;
  clearTimeout(_silenceTimer);
  try { if (recognition) { recognition.onend = null; recognition.stop(); } } catch(_){}
  recognition = null;

  if (currentInputIndex < inputs.length)
    setTimeout(() => { _fillingLocked = false; startListeningForField(); }, 1200);
  else {
    _fillingLocked = false;
    _completeFormFilling();
  }
}

async function startListeningForField() {
  if (currentInputIndex >= inputs.length) { _completeFormFilling(); return; }
  retryCount = 0; _fillingLocked = false; clearTimeout(_silenceTimer);
  focusInput(currentInputIndex);
  if (recognition) { try { recognition.onend = null; recognition.abort(); } catch(_){} recognition = null; }
  _setupRecognition();

  const rawLabel = _fieldLabel(currentInputIndex);
  let spoken     = rawLabel;

  // Classifier-guided announcement: shorten complex field labels
  try {
    const cls = await bgClassify(rawLabel);
    if (cls && cls.should_simplify) spoken = rawLabel.split(/\s+/).slice(0, 4).join(" ");
  } catch(_) {}

  speakText(`Please say your ${spoken}`).then(() => {
    setTimeout(() => { if (recognition && !isListening) recognition.start(); }, 600);
  }).catch(() => {
    setTimeout(() => { if (recognition && !isListening) recognition.start(); }, 600);
  });
}

function _completeFormFilling() {
  _showVoiceStatus("🎉 Form filling complete!");
  setTimeout(() => {
    if (confirm("Form complete! Submit now?")) {
      const form = inputs[0]?.form;
      if (form) form.submit(); else alert("No <form> wrapper found.");
    }
  }, 1500);
  if (recognition) { try { recognition.stop(); } catch(_){} recognition = null; }
}

function _fieldLabel(idx) {
  const el = inputs[idx];
  if (!el) return `Field ${idx+1}`;
  if (el.id) {
    const lbl = document.querySelector(`label[for="${el.id}"]`);
    if (lbl) return lbl.textContent.trim().replace(/[*:]+$/,"").trim();
  }
  const parent = el.closest("label");
  if (parent) return parent.textContent.replace(el.value||"","").trim();
  const prev = el.previousElementSibling;
  if (prev && (prev.textContent||"").trim()) return prev.textContent.trim();
  return el.placeholder || (el.name||"").replace(/[_-]/g," ") || `Field ${idx+1}`;
}

function _processVoice(text, el) {
  let t = text.toLowerCase();
  for (const [spoken, actual] of Object.entries(VOICE_CORRECTIONS))
    t = t.replace(new RegExp(`\\b${spoken}\\b`,"gi"), actual);
  const all = `${el.id||""} ${el.name||""} ${el.placeholder||""}`.toLowerCase();
  if (FIELD_PATTERNS.email.some(p => all.includes(p)))
    t = t.replace(/\s+at\s+/g,"@").replace(/\s+dot\s+/g,".")
         .replace(/\s*(gmail|yahoo|hotmail|outlook|com|org|net)\s*/g,"$1").replace(/\s/g,"");
  else if (FIELD_PATTERNS.phone.some(p => all.includes(p)))   t = t.replace(/\D/g,"");
  else if (FIELD_PATTERNS.name.some(p  => all.includes(p)))   t = t.replace(/\b\w/g,c=>c.toUpperCase());
  return t;
}

// ─────────────────────────────────────────────────────────────────────────────
// SHARED UI HELPERS
// ─────────────────────────────────────────────────────────────────────────────
function _showToast(msg, duration=3000, bg="rgba(0,0,0,0.82)", color="#fff") {
  let t = document.getElementById("_ai-toast");
  if (!t) {
    t = document.createElement("div"); t.id = "_ai-toast";
    t.style.cssText = "position:fixed;bottom:30px;left:50%;transform:translateX(-50%);"
      + "padding:10px 18px;border-radius:20px;z-index:99999;font-family:Arial,sans-serif;"
      + "font-size:13px;font-weight:bold;pointer-events:none;transition:opacity 0.3s;"
      + "max-width:90vw;text-align:center;";
    document.body.appendChild(t);
  }
  t.style.background = bg; t.style.color = color; t.style.opacity = "1";
  t.textContent = msg;
  clearTimeout(t._tid);
  t._tid = setTimeout(() => { t.style.opacity = "0"; }, duration);
}

function _showVoiceStatus(msg) {
  let d = document.getElementById("voice-filling-status");
  if (!d) {
    d = document.createElement("div"); d.id = "voice-filling-status";
    d.style.cssText = "position:fixed;top:20px;right:20px;"
      + "background:linear-gradient(135deg,#007bff,#0056b3);color:#fff;"
      + "padding:15px 20px;border-radius:12px;z-index:10000;"
      + "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;"
      + "font-size:14px;font-weight:500;max-width:350px;"
      + "box-shadow:0 6px 20px rgba(0,0,0,0.3);text-align:center;backdrop-filter:blur(10px);";
    document.body.appendChild(d);
  }
  d.textContent = msg;
  if (msg.includes("complete") || msg.includes("submitted"))
    setTimeout(() => { d.style.opacity="0"; setTimeout(()=>d.remove(),300); }, 5000);
}

function speakText(text) {
  return new Promise((res, rej) => {
    try {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = "en-US"; u.onend = res; u.onerror = rej;
      speechSynthesis.speak(u);
    } catch(e) { rej(e); }
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// UNIFIED MESSAGE LISTENER
// ═════════════════════════════════════════════════════════════════════════════
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  try {
    switch (request.action) {

      case "ping":
        sendResponse({ status: "Content script v4 ready" }); break;

      case "startVoiceFormFilling":
        startVoiceFormFilling(); sendResponse({ status: "started" }); break;

      case "videoControl": {
        const vids = document.querySelectorAll("video");
        if (!vids.length) { sendResponse({ error: "No videos found" }); break; }
        controlVideos(request.command);
        sendResponse({ status: `${request.command} on ${vids.length} video(s)` }); break;
      }

      case "highContrast":
        document.documentElement.classList.add("accessibility-high-contrast");
        document.body.classList.add("accessibility-high-contrast");
        sendResponse({ status:"applied" }); break;
      case "removeContrast":
        document.documentElement.classList.remove("accessibility-high-contrast");
        document.body.classList.remove("accessibility-high-contrast");
        sendResponse({ status:"removed" }); break;
      case "protanopia":    document.body.style.filter="grayscale(0.3) hue-rotate(-30deg)"; sendResponse({status:"applied"}); break;
      case "deuteranopia":  document.body.style.filter="grayscale(0.3) hue-rotate(30deg)";  sendResponse({status:"applied"}); break;
      case "dyslexia":
        document.body.style.fontFamily="Arial,sans-serif";
        document.body.style.lineHeight="2";
        document.body.style.letterSpacing="0.1em";
        sendResponse({status:"applied"}); break;
      case "bigText": document.body.style.fontSize="20px"; sendResponse({status:"applied"}); break;
      case "removeProtanopia":
      case "removeDeuteranopia": document.body.style.filter=""; sendResponse({status:"removed"}); break;
      case "removeDyslexia":
        document.body.style.fontFamily=document.body.style.lineHeight=document.body.style.letterSpacing="";
        sendResponse({status:"removed"}); break;
      case "removeBigText": document.body.style.fontSize=""; sendResponse({status:"removed"}); break;

      case "captionImages":
        captionAllImages().then(r=>sendResponse(r)).catch(e=>sendResponse({error:e.message}));
        return true;

      case "simplifyText":
        simplifyPageText().then(r=>sendResponse(r)).catch(e=>sendResponse({error:e.message}));
        return true;
      case "restoreText":
        restoreOriginalText(); sendResponse({status:"restored"}); break;

      case "startVoiceNavigation":
        sendResponse(startVoiceNavigation(request.resumedAfterNav === true)); break;
      case "stopVoiceNavigation":
        stopVoiceNavigation(); sendResponse({status:"stopped"}); break;

      case "runScout":
        _scoutRan = false;
        runScoutAuditor().then(()=>sendResponse({status:"scout done"}));
        return true;

      default:
        sendResponse({ error: "Unknown action" });
    }
  } catch (err) {
    console.error("[content.js]", err);
    sendResponse({ error: err.message });
  }
  return true;
});
