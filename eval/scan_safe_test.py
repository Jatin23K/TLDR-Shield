#!/usr/bin/env python3
# -*- coding: utf-8 -*-
import sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
"""
TLDR Shield — False Positive Benchmark (Grade A + Grade B Services)
====================================================================
Tests whether the system correctly stays SAFE/OKAY on services with
good privacy practices. Measures specificity — the other half of the
benchmark that scan_test.py does not cover.

Services under test:
  Grade A (expect SAFE or OKAY — 0 violations):
  1. Wikipedia     (tosdr.org: Grade A)
  2. DuckDuckGo    (tosdr.org: Grade A)
  3. ProtonMail    (tosdr.org: Grade A)
  4. Mullvad VPN   (tosdr.org: Grade A)
  5. Bitwarden     (tosdr.org: Grade A)

  Grade B (expect OKAY — 0 major violations):
  6. Mozilla       (tosdr.org: Grade B)
  7. Basecamp      (tosdr.org: Grade B)
  8. 1Password     (tosdr.org: Grade B)
  9. Fastmail      (tosdr.org: Grade B)
 10. Tutanota/Tuta (tosdr.org: Grade B)

Primary metric: False Positive Rate
  — How often does the system wrongly flag a violation on a clean policy?
  — Target: FP rate < 20% (i.e. fewer than 1 wrong flag per service)

NOTE: Verify all tosdr.org grades at https://tosdr.org before running.
      Grades change over time as policies are updated.
"""

import requests
import json
import re
import time
from bs4 import BeautifulSoup

# ── API Keys ──────────────────────────────────────────────────────────────────
SCAN_KEYS = [
    "AIzaSyCnIlZgo4s8q7SHwvwwOcqwDhUbMDVwqJM"
]

GEMINI_BASE     = "https://generativelanguage.googleapis.com/v1beta"
PRIMARY_MODEL   = "gemini-2.5-flash"
CORROBORATOR    = "gemini-2.5-flash-lite"
MAX_TOKENS      = 8192
TIMEOUT_S       = 60

# ── Services under test ───────────────────────────────────────────────────────
# For Grade A/B services, known_violations is empty or minimal.
# The system should NOT flag violations on these — any flag is a false positive.
# expected_rating: Grade A → "SAFE", Grade B → "OKAY"
SERVICES = [
    # ── Grade A (expect SAFE — 0 violations) ─────────────────────────────────
    {
        "name": "Wikipedia",
        "tos_url": "https://foundation.wikimedia.org/wiki/Policy:Terms_of_Use",
        "pp_url":  "https://foundation.wikimedia.org/wiki/Policy:Privacy_policy",
        "ground_truth": {
            "tosdr_grade": "A",
            "expected_rating": "SAFE",
            "known_violations": [],
        },
    },
    {
        "name": "DuckDuckGo",
        "tos_url": "https://duckduckgo.com/terms",
        "pp_url":  "https://duckduckgo.com/privacy",
        "ground_truth": {
            "tosdr_grade": "A",
            "expected_rating": "SAFE",
            "known_violations": [],
        },
    },
    {
        "name": "ProtonMail",
        "tos_url": "https://proton.me/legal/terms",
        "pp_url":  "https://proton.me/legal/privacy",
        "ground_truth": {
            "tosdr_grade": "A",
            "expected_rating": "SAFE",
            "known_violations": [],
        },
    },
    {
        "name": "Mullvad VPN",
        "tos_url": "https://mullvad.net/en/help/terms-service",
        "pp_url":  "https://mullvad.net/en/help/privacy-policy",
        "ground_truth": {
            "tosdr_grade": "A",
            "expected_rating": "SAFE",
            "known_violations": [],
        },
    },
    {
        "name": "Bitwarden",
        "tos_url": "https://bitwarden.com/terms/",
        "pp_url":  "https://bitwarden.com/privacy/",
        "ground_truth": {
            "tosdr_grade": "A",
            "expected_rating": "SAFE",
            "known_violations": [],
        },
    },
    # ── Grade B (expect OKAY — 0 major violations) ────────────────────────────
    {
        "name": "Mozilla",
        "tos_url": "https://www.mozilla.org/en-US/about/legal/terms/firefox/",
        "pp_url":  "https://www.mozilla.org/en-US/privacy/firefox/",
        "ground_truth": {
            "tosdr_grade": "B",
            "expected_rating": "OKAY",
            "known_violations": [],
        },
    },
    {
        "name": "Basecamp",
        "tos_url": "https://basecamp.com/about/policies/terms",
        "pp_url":  "https://basecamp.com/about/policies/privacy",
        "ground_truth": {
            "tosdr_grade": "B",
            "expected_rating": "OKAY",
            "known_violations": [],
        },
    },
    {
        "name": "1Password",
        "tos_url": "https://1password.com/legal/terms-of-service/",
        "pp_url":  "https://1password.com/legal/privacy/",
        "ground_truth": {
            "tosdr_grade": "B",
            "expected_rating": "OKAY",
            "known_violations": [],
        },
    },
    {
        "name": "Fastmail",
        "tos_url": "https://www.fastmail.com/about/tos/",
        "pp_url":  "https://www.fastmail.com/about/privacy/",
        "ground_truth": {
            "tosdr_grade": "B",
            "expected_rating": "OKAY",
            "known_violations": [],
        },
    },
    {
        "name": "Tuta",
        "tos_url": "https://tuta.com/terms",
        "pp_url":  "https://tuta.com/privacy",
        "ground_truth": {
            "tosdr_grade": "B",
            "expected_rating": "OKAY",
            "known_violations": [],
        },
    },
]

# ── Scoring (mirrors shared/scoring.ts) ──────────────────────────────────────
PENALTIES = {
    "ai_training":       {"HIGH": 30, "MEDIUM": 30, "LOW": 15},
    "data_selling":      {"HIGH": 30, "MEDIUM": 30, "LOW": 15},
    "data_retention":    {"HIGH": 30, "MEDIUM": 30, "LOW": 15},
    "content_ownership": {"HIGH": 30, "MEDIUM": 30, "LOW": 15},
    "dark_patterns":     {"HIGH": 40, "MEDIUM": 40, "LOW": 20},
    "transparency":      {"HIGH": 20, "MEDIUM": 20, "LOW":  5},
}

def compute_score(pillars: dict) -> tuple[int, str]:
    score = 100
    for name, p in pillars.items():
        if p.get("violation"):
            conf = p.get("confidence", "HIGH")
            score -= PENALTIES.get(name, {}).get(conf, 30)
    score = max(0, score)
    if score >= 90:
        rating = "SAFE"
    elif score >= 50:
        rating = "OKAY"
    else:
        rating = "RISKY"
    return score, rating

# ── Prompts (identical to scan_test.py) ──────────────────────────────────────
QUICK_SYSTEM = """You are a privacy attorney giving an instant verdict. Apply the NULL HYPOTHESIS: flag a violation ONLY when the text contains explicit, verbatim evidence. Do not infer violations from silence or common industry practices.

VIOLATIONS TO DETECT:
- ai_training: Explicit AI/ML MODEL TRAINING using user data. The cited text MUST contain the word "train", "fine-tune", "training data", or "build AI/ML model" applied directly to user content. REQUIRED (at least one must appear verbatim): "train our models", "fine-tune", "training data for AI", "generative AI trained on user data". BANNED TRIGGERS — these words alone are NEVER sufficient: "analyze", "store", "host", "process", "improve", "personalize", "recommendations", "enhance", "Affiliates". A broad license grant containing "Affiliates" or "store and host" WITHOUT the word "train" is NOT an ai_training violation. DIRECTION CHECK: Only flag if the SERVICE trains on user data. If the clause PROHIBITS users from doing something (e.g., "you may not use automated means", "prohibited uses include AI scraping"), it is NOT an ai_training violation — it is a usage restriction on users, not the service training on your data.
- data_selling: Personal data explicitly shared with/sold to third parties (advertisers, brokers, marketing partners) for THEIR commercial benefit. Internal service use is NOT a violation. REQUIRED keywords for violation: "advertiser", "data broker", or "marketing partner for their own commercial use". "Service providers", "vendors", or "partners helping us operate" are NOT violations.
- transparency: Deliberately self-contradictory language — policy says minimal data use then immediately permits unlimited use. Vague-but-not-contradictory = no violation. NOT a contradiction: opt-out rights with limited scope, clauses that apply only in specific jurisdictions, or cross-references to other documents. Requires two statements that directly oppose each other.
- data_retention: An EXPLICIT retention period over 1 year (12 months) post-account-deletion, regardless of stated reason. Silence on retention timelines is NOT a violation — only flag when an explicit duration over 12 months appears verbatim in the text.
- content_ownership: Worldwide sublicensable license "for any purpose" beyond displaying content on the platform (look for: sublicense, royalty-free, for any purpose, modify/adapt/distribute). NOT a violation: "license to host/display on our platform" — platform-scoped licenses are required to operate the service. NOT a violation: licensing of feedback, suggestions, ideas, or comments voluntarily submitted. Only flag when the license applies to user-generated content published on the platform (posts, photos, videos, files, messages).
- dark_patterns: Liability cap <$1000, class action waiver, forced individual arbitration, statute of limitations <2 years.

Output ONLY valid JSON — no markdown, no extra text:
{"tldr":"2-sentence plain-English verdict. Name the biggest risk if any.","ai_training":boolean,"data_selling":boolean,"transparency":boolean,"data_retention":boolean,"content_ownership":boolean,"dark_patterns":boolean}"""

DEEP_SYSTEM = """You are a senior privacy attorney and data protection expert. Apply the NULL HYPOTHESIS: default every pillar to violation: false and only change it to true when you can copy-paste a verbatim sentence from the text that proves the violation.

Analyze the legal text against these privacy pillars:
1. ai_training      — User content or data EXPLICITLY used to train, fine-tune, or build AI/ML MODELS. REQUIRED: the word "train", "fine-tune", "training data", or "build AI model" MUST appear verbatim in your citation. NOT violations: "improve our services", "store and host", "Affiliates" without "train", "analyze text", broad license grants without "train". DIRECTION CHECK: Only flag if the SERVICE trains on user data. If the clause PROHIBITS users from doing something (e.g., "you may not use automated means", "prohibited uses include AI scraping"), it is NOT an ai_training violation — it is a usage restriction on users.
2. data_selling     — Personal data explicitly shared with or sold to named THIRD PARTIES (advertisers, data brokers, marketing partners) for their own commercial benefit. REQUIRED keywords for violation: "advertiser", "data broker", or "marketing partner for their own commercial use". "Service providers", "vendors", or "partners helping us operate the service" are NOT violations.
3. transparency     — Language that is SELF-CONTRADICTORY within the same policy. NOT a contradiction: opt-out rights with limited scope, clauses that apply only in specific jurisdictions, or cross-references to other documents. Requires two statements in the same paragraph that directly oppose each other.
4. data_retention   — An EXPLICIT retention period over 1 year (12 months) post-account-deletion. Silence on retention is NOT a violation.
5. content_ownership — Broad IP rights beyond what is needed to show your content on the platform. NOT a violation: licensing of feedback, suggestions, ideas, or comments voluntarily submitted. Only flag when the license applies to user-generated content published on the platform (posts, photos, videos, files, messages).
6. dark_patterns    — Liability cap <$1000, class action waiver, forced individual arbitration, statute of limitations <2 years.

CITATION RULE — VERBATIM COPY-PASTE ONLY:
The 'citation' field must be a verbatim copy-paste of 15-60 consecutive words taken directly from the text.
If the pillar has no violation and the document is SILENT, write exactly: '[NOT_FOUND]'
If the document explicitly PROTECTS the user, quote the verbatim protective sentence.

BANNED PATTERNS (automatic fail):
✗ Any citation starting with: "The policy", "The terms", "No mention", "No explicit", "There is no"
✗ Any paraphrase, summary, or interpretation

NULL HYPOTHESIS: Default to violation: false. Only set violation: true if you can copy-paste verbatim proof.

Output ONLY valid JSON — no markdown fences, no text outside the JSON:
{
  "tldr": "<2-3 sentence plain-English summary. Name specific risks.>",
  "pillars": {
    "ai_training":       { "violation": boolean, "citation": "string", "confidence": "HIGH"|"MEDIUM"|"LOW" },
    "data_selling":      { "violation": boolean, "citation": "string", "confidence": "HIGH"|"MEDIUM"|"LOW" },
    "transparency":      { "violation": boolean, "citation": "string", "confidence": "HIGH"|"MEDIUM"|"LOW" },
    "data_retention":    { "violation": boolean, "citation": "string", "confidence": "HIGH"|"MEDIUM"|"LOW" },
    "content_ownership": { "violation": boolean, "citation": "string", "confidence": "HIGH"|"MEDIUM"|"LOW" },
    "dark_patterns":     { "violation": boolean, "citation": "string", "confidence": "HIGH"|"MEDIUM"|"LOW" }
  }
}

CONFIDENCE RULES:
- HIGH: explicit, unambiguous clause found verbatim
- MEDIUM: ambiguous OR pillar is silent (citation is '[NOT_FOUND]')
- LOW: inferred from indirect language"""

PP_DATA_SELLING_SYSTEM = """You are a privacy attorney scanning a Privacy Policy for commercial data sharing.

TASK: Does this Privacy Policy indicate that the company shares personal user data with THIRD PARTIES for THEIR OWN commercial benefit?

VIOLATION = true when the PP:
- Shares with advertising partners, ad networks, data brokers, or marketing companies
- Allows third parties to use your data for THEIR OWN targeted ads or commercial purposes
- Uses language like: "advertising partners", "personalized ads", "marketing partners for their own use", "data brokers", "ad partners", "tailored advertising", "targeted content from partners", "interest-based advertising", "third parties may use your data"
- Sells or licenses personal data to other companies

NOT a violation = false when the PP:
- Only shares with service providers / vendors that process data ON BEHALF OF the company (cloud hosting, payment processing, analytics working for them)
- Only shares for legal compliance, safety, or fraud prevention
- Only shares within affiliates/subsidiaries of the same corporate family
- The company serves its own first-party ads without sharing underlying user data with external parties

Output ONLY valid JSON:
{"data_selling": boolean, "reason": "one sentence citing the specific language or absence that determined the verdict"}"""

# ── Helpers (identical to scan_test.py) ──────────────────────────────────────

def fetch_tos_text(url: str, max_chars: int = 120000) -> str:
    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/124.0.0.0 Safari/537.36"
        ),
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
    }
    r = requests.get(url, headers=headers, timeout=20)
    r.raise_for_status()
    soup = BeautifulSoup(r.text, "html.parser")
    for tag in soup(["script", "style", "nav", "header", "footer", "noscript"]):
        tag.decompose()
    text = soup.get_text(separator="\n", strip=True)
    text = re.sub(r'\n{3,}', '\n\n', text)
    return text[:max_chars]


def call_gemini(system_prompt: str, user_text: str, model: str, keys: list) -> dict:
    body = {
        "systemInstruction": {"parts": [{"text": system_prompt}]},
        "contents": [{"role": "user", "parts": [{"text": user_text}]}],
        "generationConfig": {
            "temperature": 0,
            "maxOutputTokens": MAX_TOKENS,
            "responseMimeType": "application/json",
        },
        "safetySettings": [
            {"category": "HARM_CATEGORY_HARASSMENT",        "threshold": "BLOCK_NONE"},
            {"category": "HARM_CATEGORY_HATE_SPEECH",       "threshold": "BLOCK_NONE"},
            {"category": "HARM_CATEGORY_SEXUALLY_EXPLICIT", "threshold": "BLOCK_NONE"},
            {"category": "HARM_CATEGORY_DANGEROUS_CONTENT", "threshold": "BLOCK_NONE"},
        ],
    }
    last_err = None
    for attempt, key in enumerate(keys * 2):
        url = f"{GEMINI_BASE}/models/{model}:generateContent?key={key}"
        try:
            r = requests.post(url, json=body, timeout=TIMEOUT_S)
            if r.status_code == 429:
                wait = 20 + attempt * 10
                print(f"    ⏳ Rate limited (429) — waiting {wait}s before retry…")
                time.sleep(wait)
                last_err = "HTTP 429"
                continue
            if r.status_code in (500, 503):
                wait = 15 + attempt * 5
                print(f"    ⏳ Server error ({r.status_code}) — waiting {wait}s before retry…")
                time.sleep(wait)
                last_err = f"HTTP {r.status_code}"
                continue
            r.raise_for_status()
            data = r.json()
            parts = data.get("candidates", [{}])[0].get("content", {}).get("parts", [])
            text_parts = [p for p in parts if not p.get("thought", False) and "text" in p]
            content = text_parts[-1].get("text", "{}") if text_parts else "{}"
            finish = data.get("candidates", [{}])[0].get("finishReason", "")
            if finish not in ("STOP", ""):
                print(f"    ⚠️  finishReason={finish} — response may be truncated")
            usage = data.get("usageMetadata", {})
            return {
                "content": content,
                "input_tokens": usage.get("promptTokenCount", 0),
                "output_tokens": usage.get("candidatesTokenCount", 0),
                "model": model,
            }
        except Exception as e:
            last_err = str(e)
            continue
    raise RuntimeError(f"All keys failed for {model}: {last_err}")


def extract_json(text: str) -> dict | None:
    try:
        m = re.search(r'\{[\s\S]*\}', text)
        return json.loads(m.group(0)) if m else None
    except Exception:
        return None


def progress_sleep(seconds: int, label: str = "Waiting"):
    bar_width = 30
    for elapsed in range(seconds * 2 + 1):
        secs = elapsed / 2
        frac = min(secs / seconds, 1.0)
        filled = int(bar_width * frac)
        bar = "█" * filled + "░" * (bar_width - filled)
        remaining = max(0, seconds - int(secs))
        print(f"\r  ⏸  {label} [{bar}] {int(frac*100):3d}%  {remaining:2d}s left ", end="", flush=True)
        if elapsed < seconds * 2:
            time.sleep(0.5)
    print()


def chunk_text(text: str, chunk_size: int = 35000) -> list[str]:
    return [text[:chunk_size]]


def post_process_pillars(pillars: dict) -> dict:
    processed = dict(pillars)

    ai = processed.get("ai_training", {})
    if ai.get("violation"):
        citation = (ai.get("citation") or "").lower()
        has_train = "train" in citation or "fine-tune" in citation or "fine tune" in citation
        is_ban = any(w in citation for w in [
            "prohibited", "not permitted", "you may not", "you must not", "do not", "forbidden",
            "automated means", "engage in any of",
        ])
        if not has_train:
            print(f"     🔧 D1: ai_training cleared — citation lacks 'train'/'fine-tune': \"{citation[:60]}\"")
            processed["ai_training"] = {**ai, "violation": False, "confidence": "MEDIUM"}
        elif is_ban:
            print(f"     🔧 D2: ai_training cleared — citation is a ban clause: \"{citation[:60]}\"")
            processed["ai_training"] = {**ai, "violation": False, "confidence": "MEDIUM"}

    transp = processed.get("transparency", {})
    if transp.get("violation"):
        citation = (transp.get("citation") or "").lower()
        scope_words = ["opt-out", "solely applies", "limited to", "only applies",
                       "applies solely", "does not apply to"]
        if any(w in citation for w in scope_words):
            print(f"     🔧 D3: transparency cleared — scoping language: \"{citation[:60]}\"")
            processed["transparency"] = {**transp, "violation": False, "confidence": "MEDIUM"}

    co = processed.get("content_ownership", {})
    if co.get("violation"):
        citation = (co.get("citation") or "").lower()
        feedback_words   = ["feedback", "ideas", "suggestions", "comments", "input"]
        incoming_markers = ["you send", "send us", "send to us", "communicate to us",
                            "you submit", "submit to us", "provided to us", "sent to us",
                            "communication you", "you communicate"]
        published_words  = ["post", "photo", "video", "image", "file", "upload", "creat"]
        has_feedback  = any(w in citation for w in feedback_words)
        has_incoming  = any(w in citation for w in incoming_markers)
        has_published = (
            any(w in citation for w in published_words) or
            bool(re.search(r'\bcontents?\b', citation))
        )
        if (has_feedback or has_incoming) and not has_published:
            reason = "feedback" if has_feedback else "incoming-submission"
            print(f"     🔧 D4: content_ownership cleared — {reason} clause: \"{citation[:60]}\"")
            processed["content_ownership"] = {**co, "violation": False, "confidence": "MEDIUM"}

    return processed


def scan_pp_for_data_selling(pp_url: str, keys: list) -> bool:
    try:
        print(f"  🔎 Fetching Privacy Policy: {pp_url}")
        pp_text = fetch_tos_text(pp_url, max_chars=60000)
        print(f"     ✅ Fetched {len(pp_text):,} chars")
        pp_lower = pp_text.lower()
        service_provider_only = all(
            kw not in pp_lower
            for kw in ["advertis", "broker", "marketing partner", "targeted", "personaliz",
                       "personalis", "commercial partner", "third-party partner"]
        )
        if service_provider_only and not any(kw in pp_lower for kw in ["third party", "third-party", "share your"]):
            print(f"     ✅ data_selling clear (no commercial-sharing language — D5 pre-filter)")
            return False
        progress_sleep(2, "Rate-limit cooldown before Privacy Policy scan")
        result = call_gemini(PP_DATA_SELLING_SYSTEM, pp_text[:55000], PRIMARY_MODEL, keys)
        parsed = extract_json(result.get("content", "{}")) or {}
        found = bool(parsed.get("data_selling", False))
        if parsed.get("reason"):
            print(f"     📝 PP reason: {parsed['reason'][:100]}")
        print(f"     {'🚨 data_selling FOUND in Privacy Policy' if found else '✅ data_selling clear in Privacy Policy'}")
        return found
    except Exception as e:
        print(f"     ⚠️  Privacy Policy scan failed (non-fatal): {e}")
        return False


def apply_pp_data_selling(result_dict: dict, pp_found: bool) -> dict:
    if not pp_found:
        return result_dict
    parsed = extract_json(result_dict.get("content", "{}")) or {}
    if "pillars" in parsed:
        if not parsed["pillars"].get("data_selling", {}).get("violation"):
            parsed["pillars"]["data_selling"] = {
                "violation": True,
                "citation": "[Found in Privacy Policy]",
                "confidence": "MEDIUM",
            }
    else:
        parsed["data_selling"] = parsed.get("data_selling", False) or True
    return {**result_dict, "content": json.dumps(parsed)}


def merge_quick_results(results: list[dict]) -> dict:
    merged = {}
    for r in results:
        parsed = extract_json(r.get("content", "{}")) or {}
        for k, v in parsed.items():
            if k == "tldr":
                if "tldr" not in merged:
                    merged["tldr"] = v
            elif isinstance(v, bool):
                merged[k] = merged.get(k, False) or v
    return {"content": json.dumps(merged),
            "input_tokens": sum(r.get("input_tokens", 0) for r in results),
            "output_tokens": sum(r.get("output_tokens", 0) for r in results),
            "model": results[0]["model"] if results else ""}


def merge_deep_results(results: list[dict]) -> dict:
    conf_order = {"HIGH": 3, "MEDIUM": 2, "LOW": 1}
    merged_pillars: dict = {}
    tldr = ""
    for r in results:
        parsed = extract_json(r.get("content", "{}")) or {}
        if not tldr:
            tldr = parsed.get("tldr", "")
        for k, v in parsed.get("pillars", {}).items():
            existing = merged_pillars.get(k)
            if not existing or (v.get("violation") and not existing.get("violation")):
                merged_pillars[k] = v
            elif existing.get("violation") and v.get("violation"):
                if conf_order.get(v.get("confidence","LOW"),0) > conf_order.get(existing.get("confidence","LOW"),0):
                    merged_pillars[k] = v
    return {"content": json.dumps({"tldr": tldr, "pillars": merged_pillars}),
            "input_tokens": sum(r.get("input_tokens", 0) for r in results),
            "output_tokens": sum(r.get("output_tokens", 0) for r in results),
            "model": results[0]["model"] if results else ""}


def ensemble_merge(primary: dict, corroborator: dict) -> dict:
    p_json = extract_json(primary["content"])
    c_json = extract_json(corroborator["content"])
    if not p_json or not c_json:
        return primary
    if "pillars" not in p_json or "pillars" not in c_json:
        return primary
    conf_order = {"HIGH": 3, "MEDIUM": 2, "LOW": 1}
    merged = dict(p_json["pillars"])
    for key, c in c_json["pillars"].items():
        p = merged.get(key)
        if not p or (c.get("violation") and not p.get("violation")):
            if c.get("violation") and c.get("confidence") != "HIGH":
                continue
            merged[key] = c
        elif p.get("violation") and c.get("violation"):
            if conf_order.get(c.get("confidence","LOW"),0) > conf_order.get(p.get("confidence","LOW"),0):
                merged[key] = c
    return {
        "content": json.dumps({**p_json, "pillars": merged}),
        "input_tokens": primary["input_tokens"] + corroborator["input_tokens"],
        "output_tokens": primary["output_tokens"] + corroborator["output_tokens"],
        "model": f"{primary['model']} + {corroborator['model']} (ensemble)",
        "ensemble": True,
    }


# ── Report helpers ────────────────────────────────────────────────────────────

PILLAR_ICONS = {
    "ai_training": "🤖",
    "data_selling": "💰",
    "transparency": "🔍",
    "data_retention": "📅",
    "content_ownership": "©️",
    "dark_patterns": "⚠️",
}

def rating_emoji(r: str) -> str:
    return {"SAFE": "🟢", "OKAY": "🟡", "RISKY": "🔴"}.get(r, "⚪")

def accuracy_check(result_pillars: dict, ground_truth: dict) -> dict:
    known    = set(ground_truth.get("known_violations", []))
    detected = {k for k, v in result_pillars.items() if v.get("violation")}
    true_pos  = known & detected
    false_neg = known - detected
    false_pos = detected - known
    return {
        "true_positives":  sorted(true_pos),
        "false_negatives": sorted(false_neg),
        "false_positives": sorted(false_pos),
        # For clean services: precision = 0/0 case handled, recall = 1.0 (nothing to miss)
        "precision": len(true_pos) / len(detected) if detected else 1.0,
        "recall":    len(true_pos) / len(known)    if known    else 1.0,
        "fp_count":  len(false_pos),
    }


def print_scan_result(service: dict, scan_type: str, result: dict, tos_len: int):
    content_json = extract_json(result["content"])
    if not content_json:
        print(f"  ❌ JSON parse failed. Raw: {result['content'][:200]}")
        return

    if scan_type == "BASIC":
        pillars_flags = {
            k: {"violation": v, "confidence": "HIGH", "citation": ""}
            for k, v in content_json.items()
            if k != "tldr"
        }
        score, rating = compute_score(pillars_flags)
        tldr = content_json.get("tldr", "")
    else:
        pillars_flags = content_json.get("pillars", {})
        score, rating = compute_score(pillars_flags)
        tldr = content_json.get("tldr", "")

    acc = accuracy_check(pillars_flags, service["ground_truth"])
    expected = service["ground_truth"]["expected_rating"]

    # For Grade A/B services: pass = SAFE or OKAY (not RISKY)
    rating_pass = rating in ("SAFE", "OKAY")
    rating_match = rating == expected
    pass_icon = "✅" if rating_pass else "❌"

    print(f"\n{'─'*70}")
    print(f"  [{scan_type}] {service['name']}  |  {rating_emoji(rating)} {rating} (score: {score})  {pass_icon} expected {expected}")
    print(f"  Model: {result['model']}  |  Tokens in/out: {result['input_tokens']}/{result['output_tokens']}")
    print(f"  ToS length fetched: {tos_len:,} chars")
    print(f"  TL;DR: {tldr}")

    print(f"\n  Pillar Breakdown:")
    for pillar, data in pillars_flags.items():
        icon = PILLAR_ICONS.get(pillar, "·")
        v    = data.get("violation", False)
        conf = data.get("confidence", "")
        flag = "🚨 FALSE POSITIVE" if v else "✅ clear"
        cit  = data.get("citation", "")
        cit_str = f'  "{cit[:60]}…"' if cit and cit not in ("[NOT_FOUND]", "") and len(cit) > 20 else (f'  [{cit}]' if cit else "")
        print(f"    {icon} {pillar:20s}  {flag}  {conf}{cit_str}")

    print(f"\n  Accuracy vs tosdr.org (Grade {service['ground_truth']['tosdr_grade']}):")
    if acc["false_positives"]:
        print(f"    🚨 False Positives : {', '.join(acc['false_positives'])}  ← wrongly flagged on clean policy")
    else:
        print(f"    ✅ No false positives — system correctly found nothing")
    print(f"    False Positive Count: {acc['fp_count']}  |  Rating correct: {'✅' if rating_match else f'❌ (got {rating}, expected {expected})'}")

    return {
        "service": service["name"],
        "grade": service["ground_truth"]["tosdr_grade"],
        "scan_type": scan_type,
        "score": score,
        "rating": rating,
        "expected_rating": expected,
        "rating_pass": rating_pass,
        "rating_match": rating_match,
        "fp_count": acc["fp_count"],
        "false_positives": acc["false_positives"],
        "model": result["model"],
        "tokens_in": result["input_tokens"],
        "tokens_out": result["output_tokens"],
    }


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    print("=" * 70)
    print("  TLDR SHIELD — False Positive Benchmark (Grade A + B Services)")
    print("  5 Grade A (expect SAFE) + 5 Grade B (expect OKAY)")
    print("  Primary metric: False Positive Rate")
    print("  Models: gemini-2.5-flash (basic) | flash + flash-lite ensemble (deep)")
    print("=" * 70)
    print()
    print("  ⚠️  Verify tosdr.org grades before running:")
    print("      Grade A: Wikipedia, DuckDuckGo, ProtonMail, Mullvad, Bitwarden")
    print("      Grade B: Mozilla, Basecamp, 1Password, Fastmail, Tuta")
    print()

    all_results = []

    for svc in SERVICES:
        print(f"\n{'═'*70}")
        print(f"  📄 Fetching ToS: {svc['name']} (Grade {svc['ground_truth']['tosdr_grade']}) — {svc['tos_url']}")
        try:
            tos_text = fetch_tos_text(svc["tos_url"])
            print(f"  ✅ Fetched {len(tos_text):,} chars")
        except Exception as e:
            print(f"  ❌ Fetch failed: {e}")
            continue

        chunks = chunk_text(tos_text)
        print(f"  📦 Using first {len(chunks[0]):,} chars of {len(tos_text):,} total")

        # Privacy Policy co-scan
        pp_data_selling = False
        if svc.get("pp_url"):
            progress_sleep(2, "Rate-limit cooldown before Privacy Policy fetch")
            pp_data_selling = scan_pp_for_data_selling(svc["pp_url"], SCAN_KEYS)

        # ── BASIC SCAN ────────────────────────────────────────────────────────
        print(f"\n  ⚡ Running BASIC scan (gemini-2.5-flash, 1 chunk = first {len(chunks[0]):,} chars)…")
        t0 = time.time()
        try:
            basic_result = call_gemini(QUICK_SYSTEM, chunks[0], PRIMARY_MODEL, SCAN_KEYS)
            basic_result = merge_quick_results([basic_result])
            basic_result = apply_pp_data_selling(basic_result, pp_data_selling)
            basic_parsed = extract_json(basic_result.get("content", "{}")) or {}
            flat_pillars = {k: {"violation": v, "confidence": "HIGH", "citation": ""} for k, v in basic_parsed.items() if k != "tldr"}
            flat_pillars = post_process_pillars(flat_pillars)
            for k, p in flat_pillars.items():
                basic_parsed[k] = p.get("violation", basic_parsed.get(k, False))
            basic_result = {**basic_result, "content": json.dumps(basic_parsed)}
            basic_result["latency_s"] = round(time.time() - t0, 1)
            print(f"  ✅ Done in {basic_result['latency_s']}s")
            r = print_scan_result(svc, "BASIC", basic_result, len(tos_text))
            if r:
                r["latency_s"] = basic_result["latency_s"]
                all_results.append(r)
        except Exception as e:
            print(f"  ❌ Basic scan failed: {e}")

        progress_sleep(2, "Rate-limit cooldown (basic → deep)")

        # ── DEEP SCAN (ENSEMBLE) ──────────────────────────────────────────────
        print(f"\n  🔬 Running DEEP scan (ensemble: flash + flash-lite, 1 chunk)…")
        t0 = time.time()
        try:
            primary_r = call_gemini(DEEP_SYSTEM, chunks[0], PRIMARY_MODEL, SCAN_KEYS)
            progress_sleep(2, "Rate-limit cooldown (primary → corroborator)")
            corr_r    = call_gemini(DEEP_SYSTEM, chunks[0], CORROBORATOR, SCAN_KEYS)
            primary_result     = merge_deep_results([primary_r])
            corroborate_result = merge_deep_results([corr_r])
            deep_result = ensemble_merge(primary_result, corroborate_result)
            deep_result = apply_pp_data_selling(deep_result, pp_data_selling)
            deep_parsed = extract_json(deep_result.get("content", "{}")) or {}
            if "pillars" in deep_parsed:
                deep_parsed["pillars"] = post_process_pillars(deep_parsed["pillars"])
                deep_result = {**deep_result, "content": json.dumps(deep_parsed)}
            deep_result["latency_s"] = round(time.time() - t0, 1)
            print(f"  ✅ Done in {deep_result['latency_s']}s (ensemble merged)")
            r = print_scan_result(svc, "DEEP", deep_result, len(tos_text))
            if r:
                r["latency_s"] = deep_result["latency_s"]
                all_results.append(r)
        except Exception as e:
            print(f"  ❌ Deep scan failed: {e}")

        progress_sleep(2, "Rate-limit cooldown (next service)")

    # ── SUMMARY ───────────────────────────────────────────────────────────────
    print(f"\n\n{'═'*70}")
    print("  SUMMARY — False Positive Benchmark Results")
    print(f"{'═'*70}")

    basic_results = [r for r in all_results if r["scan_type"] == "BASIC"]
    deep_results  = [r for r in all_results if r["scan_type"] == "DEEP"]

    for group_name, group in [("BASIC (gemini-2.5-flash alone)", basic_results),
                               ("DEEP (ensemble: flash + flash-lite)", deep_results)]:
        if not group:
            continue
        print(f"\n  {group_name}:")
        passed       = sum(1 for r in group if r["rating_pass"])
        exact_match  = sum(1 for r in group if r["rating_match"])
        total_fp     = sum(r["fp_count"] for r in group)
        avg_fp       = total_fp / len(group) if group else 0
        avg_latency  = sum(r["latency_s"] for r in group) / len(group) if group else 0

        print(f"    Not RISKY        : {passed}/{len(group)}  (system did not over-flag as RISKY)")
        print(f"    Exact match      : {exact_match}/{len(group)}  (SAFE vs OKAY precision)")
        print(f"    Total false flags: {total_fp} across {len(group)} services")
        print(f"    Avg false flags  : {avg_fp:.1f} per service")
        print(f"    Avg Latency      : {avg_latency:.1f}s")
        print()

        grade_a = [r for r in group if r["grade"] == "A"]
        grade_b = [r for r in group if r["grade"] == "B"]

        print(f"    Grade A services (expect SAFE):")
        for r in grade_a:
            pass_icon = "✅" if r["rating_pass"] else "❌"
            fp_str = f"  🚨 wrongly flagged: {', '.join(r['false_positives'])}" if r["false_positives"] else "  ✅ clean"
            print(f"      {pass_icon} {r['service']:15s} → {r['rating']:5s} (exp {r['expected_rating']}){fp_str}")

        print(f"    Grade B services (expect OKAY):")
        for r in grade_b:
            pass_icon = "✅" if r["rating_pass"] else "❌"
            fp_str = f"  🚨 wrongly flagged: {', '.join(r['false_positives'])}" if r["false_positives"] else "  ✅ clean"
            print(f"      {pass_icon} {r['service']:15s} → {r['rating']:5s} (exp {r['expected_rating']}){fp_str}")

    # ── Combined view with scan_test.py results ───────────────────────────────
    print(f"\n{'─'*70}")
    print("  COMBINED BENCHMARK PICTURE")
    print(f"{'─'*70}")
    deep = [r for r in all_results if r["scan_type"] == "DEEP"]
    if deep:
        total_fp    = sum(r["fp_count"] for r in deep)
        not_risky   = sum(1 for r in deep if r["rating_pass"])
        avg_fp_rate = total_fp / (len(deep) * 6)  # 6 pillars per service
        print(f"  Deep scan on clean policies:")
        print(f"    Services not over-flagged as RISKY : {not_risky}/{len(deep)}")
        print(f"    Total wrong flags across all pillars: {total_fp}")
        print(f"    False positive rate per pillar      : {avg_fp_rate:.0%}")
        print()
        print(f"  Combined with scan_test.py results (10 RISKY services):")
        print(f"    RISKY services — recall  : 97%  (from scan_test.py)")
        print(f"    RISKY services — precision: 84%  (from scan_test.py)")
        print(f"    SAFE/OKAY services — specificity: see above")
        print(f"    Total benchmark coverage: 20 services across the full grade spectrum")

    print(f"{'═'*70}\n")


if __name__ == "__main__":
    main()
