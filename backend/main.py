"""
AI Accessibility Backend  —  FastAPI v4
========================================
Endpoints
  GET  /health     liveness probe
  POST /caption    image → alt-text  (HF Inference API → local BLIP fallback)
  POST /simplify   text  → plain-English rewrite  (T5-small)
  POST /classify   text  → {label, confidence, features, should_simplify}
                   powered by a locally TRAINED Random Forest

Crash-proof import strategy
  Every package that may not be installed (httpx, numpy, sklearn, torch,
  transformers, bitsandbytes) is imported LAZILY inside functions, wrapped
  in try/except where optional.  Only the stdlib + fastapi + pydantic are
  imported at module level — these are guaranteed by requirements.txt.
  This means `uvicorn main:app` ALWAYS starts successfully regardless of
  which optional packages are present.
"""

from __future__ import annotations

# ── Stdlib only at module level ───────────────────────────────────────────────
import asyncio
import base64
import io
import json
import logging
import re
import time
import urllib.error
import urllib.request

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

logging.basicConfig(level=logging.INFO,
                    format="%(levelname)s  %(name)s  %(message)s")
logger = logging.getLogger("accessibility")

app = FastAPI(title="AI Accessibility API", version="4.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)

# ─────────────────────────────────────────────────────────────────────────────
# SCHEMAS
# ─────────────────────────────────────────────────────────────────────────────

class CaptionRequest(BaseModel):
    image_url: str

class CaptionResponse(BaseModel):
    caption: str
    image_url: str
    source: str   # "hf_api" | "local_blip_int8" | "local_blip_fp32"

class SimplifyRequest(BaseModel):
    text: str
    max_length: int = 130

class SimplifyResponse(BaseModel):
    simplified: str
    original_length: int
    simplified_length: int

class ClassifyRequest(BaseModel):
    text: str

class ClassifyResponse(BaseModel):
    label: str
    confidence: float
    features: dict
    should_simplify: bool

# ─────────────────────────────────────────────────────────────────────────────
# COMPLEXITY CLASSIFIER  —  locally trained Random Forest
# ─────────────────────────────────────────────────────────────────────────────

_rf_classifier = None


def _count_syllables(word: str) -> int:
    word = word.lower().strip(".,!?;:'\"()-")
    if not word:
        return 0
    count, prev_v = 0, False
    for ch in word:
        v = ch in "aeiouy"
        if v and not prev_v:
            count += 1
        prev_v = v
    if word.endswith("e") and count > 1:
        count -= 1
    return max(1, count)


def _extract_features(text: str) -> dict:
    sentences = [s.strip() for s in re.split(r"[.!?]+", text) if s.strip()]
    words     = re.findall(r"\b\w+\b", text)
    if not words:
        return {k: 0.0 for k in [
            "avg_syllables","avg_word_len","avg_sent_len",
            "flesch_kincaid_grade","type_token_ratio",
            "long_word_ratio","punct_density","passive_ratio"]}
    syls  = [_count_syllables(w) for w in words]
    ns    = max(len(sentences), 1)
    nw    = len(words)
    avg_syl  = sum(syls) / nw
    avg_wlen = sum(len(w) for w in words) / nw
    avg_slen = nw / ns
    fk       = 0.39 * avg_slen + 11.8 * avg_syl - 15.59
    ttr      = len(set(w.lower() for w in words)) / nw
    long_r   = sum(1 for s in syls if s >= 3) / nw
    punc     = sum(1 for c in text if c in ".,;:()[]{}\"'—–-") / max(len(text), 1)
    passive  = sum(
        1 for s in sentences
        if re.search(r"\b(was|were|been|is|are|be)\b.{0,30}\b\w+ed\b", s, re.I)
    ) / ns
    return {
        "avg_syllables":        round(avg_syl,  3),
        "avg_word_len":         round(avg_wlen, 3),
        "avg_sent_len":         round(avg_slen, 3),
        "flesch_kincaid_grade": round(fk,       3),
        "type_token_ratio":     round(ttr,      3),
        "long_word_ratio":      round(long_r,   3),
        "punct_density":        round(punc,     4),
        "passive_ratio":        round(passive,  3),
    }


def _fvec(f: dict) -> list:
    return [f["avg_syllables"], f["avg_word_len"], f["avg_sent_len"],
            f["flesch_kincaid_grade"], f["type_token_ratio"],
            f["long_word_ratio"], f["punct_density"], f["passive_ratio"]]


_SIMPLE_CORPUS = [
    "The cat sat on the mat.",
    "She went to the store to buy milk.",
    "Dogs are friendly animals.",
    "He ran fast and won the race.",
    "The sun rises in the east every morning.",
    "We ate dinner together last night.",
    "The child smiled at the camera.",
    "It rained all day on Sunday.",
    "Turn left at the traffic light.",
    "The book was very interesting to read.",
    "She called her friend on the phone.",
    "They played football in the park.",
    "The bus arrives at eight every day.",
    "He fixed the broken chair quickly.",
    "We need more time to finish the work.",
    "The dog barked loudly at the door.",
    "She smiled when she heard the news.",
    "The shop opens at nine in the morning.",
    "He drove to work in his car.",
    "The baby laughed at the funny face.",
    "Please write your name here.",
    "The water was cold and clear.",
    "They built a sandcastle on the beach.",
    "She loves reading books before bed.",
    "The train was late by ten minutes.",
] * 4

_COMPLEX_CORPUS = [
    "The pathophysiological mechanisms underlying idiopathic pulmonary fibrosis remain incompletely elucidated.",
    "Epistemological frameworks that privilege empirical verification have been scrutinised by post-positivist philosophers.",
    "The asymmetric distribution of information between contracting parties constitutes the primary source of adverse selection.",
    "Quantum chromodynamics describes the strong interaction mediated by gluons between quarks confined within hadronic matter.",
    "The legislative framework governing cross-jurisdictional data transfers was substantially amended following the invalidation of Privacy Shield.",
    "Multivariate regression analysis was performed to identify independent predictors of thirty-day all-cause mortality.",
    "The rhetorical construction of political identity through discursive practices has been extensively theorised.",
    "Stochastic gradient descent with adaptive learning rate scheduling was employed to optimise the neural network.",
    "The pharmacokinetic profile exhibited non-linear dose-response characteristics attributable to saturable protein binding.",
    "Neoliberal fiscal consolidation policies have been critiqued for their disproportionate impact on marginalised cohorts.",
    "The mitochondrial electron transport chain couples oxidative phosphorylation to an electrochemical gradient.",
    "Consequentialist normative theories evaluate actions solely on aggregate welfare-maximising outcomes.",
    "The sedimentation rate of colloidal particles is governed by the balance between gravitational and Brownian forces.",
    "Postcolonial readings of canonical texts have problematised the Eurocentric assumptions within the humanist tradition.",
    "Econometric estimation of treatment effects in the presence of endogenous selection requires instrumental variable methods.",
    "Allosteric modulation of G-protein-coupled receptors alters the conformational ensemble sampled by the receptor.",
    "Bayesian hierarchical models allow partial pooling of information across experimental units.",
    "The tectonic uplift of orogenic belts drives the long-term carbon cycle through silicate weathering.",
    "Immunosenescence refers to the gradual deterioration of the adaptive immune response associated with ageing.",
    "Thermodynamic irreversibility arises from microscopic time-asymmetry in dissipative stochastic processes.",
    "The constitutional validity of delegated legislative instruments is contingent on conformity with the enabling statute.",
    "Synthetic lethality exploits the genetic dependency of tumour cells harbouring loss-of-function mutations.",
    "The discounted cash flow model estimates intrinsic value by summing the present value of projected free cash flows.",
    "Heteroskedasticity-consistent standard errors are required when residual variance is not constant across covariates.",
    "The anthropogenic perturbation of the global nitrogen cycle through industrial fertiliser production has profound ecological consequences.",
] * 4


def _train_classifier() -> None:
    global _rf_classifier
    try:
        # Lazy import — sklearn is optional
        import numpy as np
        from sklearn.ensemble import RandomForestClassifier
        from sklearn.preprocessing import StandardScaler
        from sklearn.pipeline import Pipeline
    except ImportError as e:
        logger.warning(f"sklearn/numpy not available ({e}) — /classify uses rule-based fallback.")
        return

    logger.info("Training complexity classifier (Random Forest, 200 trees)…")
    t0 = time.time()
    corpus = _SIMPLE_CORPUS + _COMPLEX_CORPUS
    X = np.array([_fvec(_extract_features(s)) for s in corpus], dtype=np.float32)
    y = np.array([0]*len(_SIMPLE_CORPUS) + [1]*len(_COMPLEX_CORPUS), dtype=np.int32)

    _rf_classifier = Pipeline([
        ("scaler", StandardScaler()),
        ("rf", RandomForestClassifier(
            n_estimators=200, max_depth=8, min_samples_leaf=2,
            class_weight="balanced", random_state=42, n_jobs=-1,
        )),
    ])
    _rf_classifier.fit(X, y)
    logger.info(f"Classifier ready in {time.time()-t0:.2f}s  samples={len(y)}")


_train_classifier()   # < 1 s; safe because sklearn is imported lazily inside

# ─────────────────────────────────────────────────────────────────────────────
# IMAGE CAPTIONING
#   Tier 1  HuggingFace free Inference API — stdlib urllib, zero extra deps
#   Tier 2  Local BLIP  — INT8 if bitsandbytes+CUDA, FP32 otherwise
# ─────────────────────────────────────────────────────────────────────────────

HF_CAPTION_URL = (
    "https://api-inference.huggingface.co/models/Salesforce/blip-image-captioning-base"
)
_blip_processor = None
_blip_model     = None
_blip_mode      = None


async def _fetch_image_bytes(image_url: str) -> bytes:
    """Download image bytes; handles data URIs and http(s) URLs."""
    if image_url.startswith("data:image"):
        _, encoded = image_url.split(",", 1)
        return base64.b64decode(encoded)
    # Use asyncio + stdlib to avoid httpx dependency
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, _fetch_url_bytes, image_url)


def _fetch_url_bytes(url: str) -> bytes:
    """Synchronous stdlib HTTP GET — runs in thread pool."""
    req = urllib.request.Request(url, headers={"User-Agent": "AI-Accessibility/4.0"})
    with urllib.request.urlopen(req, timeout=20) as resp:
        return resp.read()


def _hf_api_post_bytes(image_bytes: bytes) -> bytes:
    """Synchronous HF API POST using stdlib — runs in thread pool."""
    req = urllib.request.Request(
        HF_CAPTION_URL,
        data=image_bytes,
        headers={"Content-Type": "application/octet-stream"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=45) as resp:
        return resp.read()


async def _caption_via_hf_api(image_bytes: bytes) -> str:
    loop = asyncio.get_event_loop()
    try:
        raw = await loop.run_in_executor(None, _hf_api_post_bytes, image_bytes)
    except urllib.error.HTTPError as e:
        if e.code == 503:
            # Model cold-starting on HF servers — wait and retry once
            logger.info("HF model cold-starting, retrying in 15 s…")
            await asyncio.sleep(15)
            raw = await loop.run_in_executor(None, _hf_api_post_bytes, image_bytes)
        else:
            raise RuntimeError(f"HF API HTTP {e.code}: {e.reason}")
    data = json.loads(raw)
    if isinstance(data, list) and data:
        return data[0].get("generated_text", "").strip()
    raise RuntimeError(f"Unexpected HF response: {data}")


def _load_blip_local() -> None:
    """
    Load BLIP locally.
    Attempts INT8 quantization (bitsandbytes) on CUDA first;
    falls back to FP32 silently on CPU-only machines.
    bitsandbytes is imported inside try/except — NEVER at module level.
    """
    global _blip_processor, _blip_model, _blip_mode
    if _blip_model is not None:
        return
    # Lazy — only imported when local fallback is actually needed
    from transformers import BlipProcessor, BlipForConditionalGeneration
    logger.info("Loading BLIP model locally…")
    _blip_processor = BlipProcessor.from_pretrained(
        "Salesforce/blip-image-captioning-base")
    try:
        import bitsandbytes  # type: ignore  # noqa — optional CUDA dep; graceful fallback below
        from transformers import BitsAndBytesConfig
        cfg = BitsAndBytesConfig(load_in_8bit=True)
        _blip_model = BlipForConditionalGeneration.from_pretrained(
            "Salesforce/blip-image-captioning-base",
            quantization_config=cfg, device_map="auto")
        _blip_mode = "int8"
        logger.info("BLIP loaded: INT8 quantization via bitsandbytes.")
    except Exception as e:
        logger.info(f"INT8 not available ({type(e).__name__}). Loading FP32.")
        _blip_model = BlipForConditionalGeneration.from_pretrained(
            "Salesforce/blip-image-captioning-base")
        _blip_model.eval()
        _blip_mode = "fp32"
        logger.info("BLIP loaded: FP32.")


def _run_blip_local(image_bytes: bytes) -> str:
    import torch
    from PIL import Image
    _load_blip_local()
    img    = Image.open(io.BytesIO(image_bytes)).convert("RGB")
    inputs = _blip_processor(img, return_tensors="pt")
    with torch.no_grad():
        out = _blip_model.generate(**inputs, max_new_tokens=60)
    return _blip_processor.decode(out[0], skip_special_tokens=True).strip()


# ─────────────────────────────────────────────────────────────────────────────
# TEXT SIMPLIFICATION  (T5-small)
# ─────────────────────────────────────────────────────────────────────────────

_simplify_pipeline = None


def _load_simplifier():
    global _simplify_pipeline
    if _simplify_pipeline is None:
        from transformers import pipeline   # lazy
        logger.info("Loading T5-small…")
        _simplify_pipeline = pipeline(
            "text2text-generation", model="t5-small", tokenizer="t5-small")
        logger.info("T5-small ready.")
    return _simplify_pipeline


def _run_simplify(text: str, max_length: int) -> str:
    pipe   = _load_simplifier()
    prompt = "simplify: " + " ".join(text.split()[:400])
    result = pipe(prompt, max_length=max_length,
                  min_length=min(20, max_length//3), do_sample=False)
    return result[0]["generated_text"].strip()


# ─────────────────────────────────────────────────────────────────────────────
# ENDPOINTS
# ─────────────────────────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    return {
        "status":             "ok",
        "version":            "4.0",
        "classifier_trained": _rf_classifier is not None,
        "blip_mode":          _blip_mode or "not_loaded_yet",
    }


@app.post("/caption", response_model=CaptionResponse)
async def caption_image(req: CaptionRequest):
    try:
        image_bytes = await _fetch_image_bytes(req.image_url)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Cannot fetch image: {e}")

    # Tier 1 — HF free API (stdlib urllib, no extra deps)
    try:
        caption = await _caption_via_hf_api(image_bytes)
        return CaptionResponse(caption=caption, image_url=req.image_url, source="hf_api")
    except Exception as hf_err:
        logger.warning(f"HF API failed ({hf_err}). Trying local BLIP…")

    # Tier 2 — local BLIP (INT8 or FP32)
    try:
        caption = await asyncio.to_thread(_run_blip_local, image_bytes)
        return CaptionResponse(
            caption=caption, image_url=req.image_url,
            source=f"local_blip_{_blip_mode}")
    except Exception as local_err:
        logger.exception("Local BLIP also failed.")
        raise HTTPException(
            status_code=500,
            detail=f"All backends failed. HF: {hf_err}. Local: {local_err}")


@app.post("/simplify", response_model=SimplifyResponse)
async def simplify_text(req: SimplifyRequest):
    text = req.text.strip()
    if len(text) < 30:
        return SimplifyResponse(simplified=text,
                                original_length=len(text),
                                simplified_length=len(text))
    try:
        simplified = await asyncio.to_thread(_run_simplify, text, req.max_length)
    except Exception as e:
        logger.exception("Simplification failed")
        raise HTTPException(status_code=500, detail=str(e))
    return SimplifyResponse(simplified=simplified,
                            original_length=len(req.text),
                            simplified_length=len(simplified))


@app.post("/classify", response_model=ClassifyResponse)
async def classify_text(req: ClassifyRequest):
    text = req.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="Empty text")

    features = _extract_features(text)
    label, confidence = _predict(features)

    return ClassifyResponse(
        label=label,
        confidence=round(confidence, 4),
        features=features,
        should_simplify=(label == "complex" and confidence >= 0.6),
    )


def _predict(features: dict):
    """Run RF classifier or rule-based fallback."""
    if _rf_classifier is not None:
        try:
            import numpy as np
            vec   = np.array([_fvec(features)], dtype=np.float32)
            proba = _rf_classifier.predict_proba(vec)[0]
            label = "complex" if proba[1] >= 0.5 else "simple"
            return label, float(max(proba))
        except Exception:
            pass  # fall through to rule-based
    # Rule-based fallback
    fk    = features["flesch_kincaid_grade"]
    label = "complex" if fk > 10 else "simple"
    conf  = min(0.95, 0.5 + abs(fk - 10) * 0.04)
    return label, conf
