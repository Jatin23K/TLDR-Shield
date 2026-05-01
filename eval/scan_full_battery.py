#!/usr/bin/env python3
# -*- coding: utf-8 -*-
import sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
"""
TLDR Shield — Full 25-Service Scan Battery
===========================================
Merges scan_test.py (10 original services) + scan_other_tests.py (15 expansion services).

Original 10 (Grades B-F):
  Discord, GitHub, Twitter/X, Google, LinkedIn, PayPal, Spotify, Netflix, TikTok, Zoom

Expansion 15 (Grades A-F):
  DuckDuckGo, Signal, Proton Mail, Wikipedia, Mullvad VPN, Mozilla Firefox,
  Apple, Reddit, Steam, Microsoft, Twitch, Yahoo, Epic Games, Snap, Roblox

Models:
  Basic : gemini-2.5-flash
  Deep  : gemini-2.5-flash (primary) + gemini-2.5-flash-lite (corroborator, ensemble)

Post-processing rules applied: D1-D7
"""

import os
import requests
import json
import re
import time
from bs4 import BeautifulSoup
from dotenv import load_dotenv

# -- API Keys (auto-loaded from .env) ------------------------------------------
# Uses all 6 free keys: 3 scan + 3 utility
# 6 keys x 10 RPM = 60 RPM effective headroom -> 2s sleep is safe
load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), "..", ".env"))

SCAN_KEYS = [
    "AIzaSyBZ8Iow4Ke5e2Te4UZfRJ9-4KlHN4jvPd8",
    "AIzaSyDCaxiuZEq6gO-86EML51-ukfVRNMoVZsA",
    "AIzaSyBPTwaK9XfCWYcX5R1EDRO3ddqjmnDpGLQ",
    "AIzaSyCqbbWHQhojUaF6M-5lUgmAKCzbBFlpXwc",
    "AIzaSyAthejiRxm_UL4uID0D4td4wHDe7RPRuwY",
    "AIzaSyDXw_tZrpdoo7GLmkjLtgp4tpJfIpbZnd0",
    "AIzaSyDQD7BPQ6YqcZOJTi2cqddPyioVk9MBWnk",
    "AIzaSyBOudUGzYDZVZFUDZsGkF8cQzS5JxIhaeQ",
    "AIzaSyAyCAIb_kE01aC-GITTu2Kfqdg5p9fEhLE",
    "AIzaSyD7Uy9p9Dfj7lotSUodVGqC6uol9bt-gnE",
]
SCAN_KEYS = [k for k in SCAN_KEYS if k]  # drop any missing keys

if not SCAN_KEYS:
    raise RuntimeError("No Gemini API keys found in .env — set GEMINI_SCAN_KEY_1..3 and GEMINI_UTIL_KEY_1..3")

GEMINI_BASE    = "https://generativelanguage.googleapis.com/v1beta"
PRIMARY_MODEL  = "gemini-2.5-flash"
CORROBORATOR   = "gemini-2.5-flash-lite"
MAX_TOKENS     = 8192
TIMEOUT_S      = 90
RATE_SLEEP_S   = 2   # 6 free keys x 10 RPM = 60 RPM effective -> 2s sleep is safe

# -- Services - 25 total -------------------------------------------------------

SERVICES = [

    # == ORIGINAL 10 (from scan_test.py) =======================================

    {
        "name": "Discord",
        "tosdr_grade": "D",
        "tos_url": "https://discord.com/terms",
        "pp_url":  "https://discord.com/privacy",
        "ground_truth": {
            "tosdr_grade": "D",
            "expected_rating": "RISKY",
            "known_violations": ["data_selling", "content_ownership", "dark_patterns"],
        },
    },
    {
        "name": "GitHub",
        "tosdr_grade": "B",
        "tos_url": "https://docs.github.com/en/site-policy/github-terms/github-terms-of-service",
        "pp_url":  "https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement",
        "ground_truth": {
            "tosdr_grade": "B",
            "expected_rating": "RISKY",
            "known_violations": ["content_ownership", "ai_training"],
        },
    },
    {
        "name": "Twitter/X",
        "tosdr_grade": "F",
        "tos_url": "https://x.com/en/tos",
        "pp_url":  "https://x.com/en/privacy",
        "ground_truth": {
            "tosdr_grade": "F",
            "expected_rating": "RISKY",
            "known_violations": ["content_ownership", "dark_patterns", "data_selling", "ai_training"],
        },
    },
    {
        "name": "Google",
        "tosdr_grade": "E",
        "tos_url": "https://policies.google.com/terms",
        "pp_url":  "https://policies.google.com/privacy",
        "ground_truth": {
            "tosdr_grade": "E",
            "expected_rating": "RISKY",
            "known_violations": ["data_selling", "content_ownership", "dark_patterns"],
        },
    },
    {
        "name": "LinkedIn",
        "tosdr_grade": "D",
        "tos_url": "https://www.linkedin.com/legal/user-agreement",
        "pp_url":  "https://www.linkedin.com/legal/privacy-policy",
        "ground_truth": {
            "tosdr_grade": "D",
            "expected_rating": "RISKY",
            "known_violations": ["content_ownership", "data_selling", "dark_patterns"],
        },
    },
    {
        "name": "PayPal",
        "tosdr_grade": "D",
        "tos_url": "https://www.paypal.com/us/legalhub/useragreement-full",
        "pp_url":  "https://www.paypal.com/us/webapps/mpp/ua/privacy-full",
        "ground_truth": {
            "tosdr_grade": "D",
            "expected_rating": "RISKY",
            "known_violations": ["dark_patterns", "data_selling"],
        },
    },
    {
        "name": "Spotify",
        "tosdr_grade": "C",
        "tos_url": "https://www.spotify.com/us/legal/end-user-agreement/",
        "pp_url":  "https://www.spotify.com/us/legal/privacy-policy/",
        "ground_truth": {
            "tosdr_grade": "C",
            "expected_rating": "RISKY",
            "known_violations": ["content_ownership", "dark_patterns"],
        },
    },
    {
        "name": "Netflix",
        "tosdr_grade": "D",
        "tos_url": "https://help.netflix.com/legal/termsofuse",
        "pp_url":  "https://help.netflix.com/legal/privacy",
        "ground_truth": {
            "tosdr_grade": "D",
            "expected_rating": "RISKY",
            "known_violations": ["dark_patterns", "data_selling"],
        },
    },
    {
        "name": "TikTok",
        "tosdr_grade": "D",
        "tos_url": "https://www.tiktok.com/legal/page/us/terms-of-service/en",
        "pp_url":  "https://www.tiktok.com/legal/page/us/privacy-policy/en",
        "ground_truth": {
            "tosdr_grade": "D",
            "expected_rating": "RISKY",
            "known_violations": ["content_ownership", "ai_training", "dark_patterns"],
        },
    },
    {
        "name": "Zoom",
        "tosdr_grade": "D",
        "tos_url": "https://zoom.us/terms",
        "pp_url":  "https://zoom.us/privacy",
        "ground_truth": {
            "tosdr_grade": "D",
            "expected_rating": "RISKY",
            "known_violations": ["content_ownership", "data_selling", "dark_patterns"],
        },
    },

    # == EXPANSION 15 (from scan_other_tests.py) ===============================

    # Grade A
    {
        "name": "DuckDuckGo",
        "tosdr_grade": "A",
        "tos_url": "https://duckduckgo.com/terms",
        "pp_url":  "https://duckduckgo.com/privacy",
        "ground_truth": {
            "tosdr_grade": "A",
            "expected_rating": "SAFE",
            "known_violations": [],
        },
    },
    {
        "name": "Signal",
        "tosdr_grade": "A",
        "tos_url": "https://signal.org/legal/",
        "pp_url":  None,
        "ground_truth": {
            "tosdr_grade": "A",
            "expected_rating": "OKAY",
            "known_violations": ["dark_patterns"],
        },
    },
    {
        "name": "Proton Mail",
        "tosdr_grade": "A",
        "tos_url": "https://proton.me/legal/terms",
        "pp_url":  "https://proton.me/legal/privacy",
        "ground_truth": {
            "tosdr_grade": "A",
            "expected_rating": "OKAY",
            "known_violations": ["dark_patterns"],
        },
    },

    # Grade B
    {
        "name": "Wikipedia",
        "tosdr_grade": "B",
        "tos_url": "https://foundation.wikimedia.org/wiki/Policy:Terms_of_Use",
        "pp_url":  "https://foundation.wikimedia.org/wiki/Policy:Privacy_policy",
        "ground_truth": {
            "tosdr_grade": "B",
            "expected_rating": "OKAY",
            "known_violations": ["dark_patterns"],
        },
    },
    {
        "name": "Mullvad VPN",
        "tosdr_grade": "B",
        "tos_url": "https://mullvad.net/en/help/terms-service",
        "pp_url":  "https://mullvad.net/en/help/privacy-policy",
        "ground_truth": {
            "tosdr_grade": "B",
            "expected_rating": "SAFE",
            "known_violations": [],
        },
    },
    {
        "name": "Mozilla Firefox",
        "tosdr_grade": "B",
        "tos_url": "https://www.mozilla.org/en-US/about/legal/terms/firefox/",
        "pp_url":  "https://www.mozilla.org/en-US/privacy/firefox/",
        "ground_truth": {
            "tosdr_grade": "B",
            "expected_rating": "SAFE",
            "known_violations": [],
        },
    },

    # Grade C
    {
        "name": "Apple",
        "tosdr_grade": "C",
        "tos_url": "https://www.apple.com/legal/internet-services/icloud/en/terms.html",
        "pp_url":  "https://www.apple.com/legal/privacy/en-ww/",
        "chunk_size": 120000,
        "ground_truth": {
            "tosdr_grade": "C",
            "expected_rating": "RISKY",
            "known_violations": ["dark_patterns"],
        },
    },
    {
        "name": "Reddit",
        "tosdr_grade": "C",
        "tos_url": "https://old.reddit.com/help/useragreement",
        "pp_url":  "https://web.archive.org/web/20250101000000/https://www.reddit.com/policies/privacy-policy/",
        "chunk_size": 90000,
        "ground_truth": {
            "tosdr_grade": "C",
            "expected_rating": "RISKY",
            "known_violations": ["ai_training", "content_ownership", "dark_patterns"],
        },
    },
    {
        "name": "Steam",
        "tosdr_grade": "C",
        "tos_url": "https://store.steampowered.com/subscriber_agreement/",
        "pp_url":  "https://store.steampowered.com/privacy_agreement/",
        "ground_truth": {
            "tosdr_grade": "C",
            "expected_rating": "RISKY",
            "known_violations": ["content_ownership", "dark_patterns"],
        },
    },

    # Grade D/E
    {
        "name": "Microsoft",
        "tosdr_grade": "E",
        "tos_url": "https://www.microsoft.com/en-us/servicesagreement/",
        "pp_url":  "https://privacy.microsoft.com/en-us/privacystatement",
        "ground_truth": {
            "tosdr_grade": "E",
            "expected_rating": "RISKY",
            "known_violations": ["content_ownership", "data_selling", "dark_patterns"],
        },
    },
    {
        "name": "Twitch",
        "tosdr_grade": "D",
        "tos_url": "https://web.archive.org/web/20250101000000/https://www.twitch.tv/p/en/legal/terms-of-service/",
        "pp_url":  "https://web.archive.org/web/20250101000000/https://www.twitch.tv/p/en/legal/privacy-notice/",
        "ground_truth": {
            "tosdr_grade": "D",
            "expected_rating": "RISKY",
            "known_violations": ["content_ownership", "dark_patterns", "data_selling"],
        },
    },
    {
        "name": "Yahoo",
        "tosdr_grade": "E",
        "tos_url": "https://legal.yahoo.com/us/en/yahoo/terms/otos/index.html",
        "pp_url":  "https://legal.yahoo.com/us/en/yahoo/privacy/index.html",
        "ground_truth": {
            "tosdr_grade": "E",
            "expected_rating": "RISKY",
            "known_violations": ["content_ownership", "data_selling", "dark_patterns"],
        },
    },

    # Grade F
    {
        "name": "Epic Games",
        "tosdr_grade": "F",
        "tos_url": "https://www.epicgames.com/site/en-US/tos",
        "pp_url":  "https://www.epicgames.com/site/en-US/privacypolicy",
        "chunk_size": 83000,
        "ground_truth": {
            "tosdr_grade": "F",
            "expected_rating": "OKAY",
            "known_violations": ["dark_patterns"],
        },
    },
    {
        "name": "Snap",
        "tosdr_grade": "F",
        "tos_url": "https://snap.com/en-US/terms",
        "pp_url":  "https://snap.com/en-US/privacy/privacy-policy",
        "chunk_size": 100000,
        "ground_truth": {
            "tosdr_grade": "F",
            "expected_rating": "RISKY",
            "known_violations": ["ai_training", "content_ownership", "data_selling", "dark_patterns"],
        },
    },
    {
        "name": "Roblox",
        "tosdr_grade": "F",
        "tos_url": "https://en.help.roblox.com/hc/en-us/articles/115004647846-Roblox-Terms-of-Use",
        "pp_url":  "https://en.help.roblox.com/hc/en-us/articles/115004630823-Roblox-Privacy-Policy",
        "ground_truth": {
            "tosdr_grade": "F",
            "expected_rating": "RISKY",
            "known_violations": ["ai_training", "content_ownership", "dark_patterns", "data_selling"],
        },
    },
]

# -- Scoring (mirrors shared/scoring.ts) ---------------------------------------
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
    rating = "SAFE" if score >= 90 else "OKAY" if score >= 50 else "RISKY"
    return score, rating

# -- Prompts -------------------------------------------------------------------

QUICK_SYSTEM = """You are a privacy attorney giving an instant verdict. Apply the NULL HYPOTHESIS: flag a violation ONLY when the text contains explicit, verbatim evidence. Do not infer violations from silence or common industry practices.

VIOLATIONS TO DETECT:
- ai_training: Explicit AI/ML MODEL TRAINING using user data. The cited text MUST contain the word "train", "fine-tune", "training data", or "build AI/ML model" applied directly to user content. REQUIRED (at least one must appear verbatim): "train our models", "fine-tune", "training data for AI", "generative AI trained on user data". BANNED TRIGGERS -- these words alone are NEVER sufficient: "analyze", "store", "host", "process", "improve", "personalize", "recommendations", "enhance", "Affiliates". A broad license grant containing "Affiliates" or "store and host" WITHOUT the word "train" is NOT an ai_training violation. DIRECTION CHECK: Only flag if the SERVICE trains on user data. If the clause PROHIBITS users from doing something (e.g., "you may not use automated means", "prohibited uses include AI scraping"), it is NOT an ai_training violation.
- data_selling: Personal data explicitly shared with/sold to third parties (advertisers, brokers, marketing partners) for THEIR commercial benefit. Internal service use is NOT a violation. REQUIRED keywords for violation: "advertiser", "data broker", or "marketing partner for their own commercial use". "Service providers", "vendors", or "partners helping us operate" are NOT violations.
- transparency: Deliberately self-contradictory language -- policy says minimal data use then immediately permits unlimited use. Vague-but-not-contradictory = no violation. Requires two statements that directly oppose each other in the same section.
- data_retention: An EXPLICIT retention period over 1 year (12 months) post-account-deletion. Silence on retention is NOT a violation.
- content_ownership: Worldwide sublicensable license beyond displaying content on the platform. NOT a violation: "license to host/display/store/sync on our platform". NOT a violation: licensing of feedback, suggestions, ideas, or comments. NOT a violation: open/Creative Commons licenses (CC BY, CC BY-SA, GFDL) where users freely contribute and retain rights. Only flag for user-generated content published on the platform (posts, photos, videos, files, messages) where the service claims rights for its own commercial benefit.
- dark_patterns: REQUIRES at least one of: (1) forced MANDATORY individual arbitration clause binding ALL disputes, (2) explicit class action lawsuit waiver, (3) statute of limitations under 2 years that applies to ALL disputes broadly. A scoped statute of limitations that only applies to specific narrow claim types (e.g. only disputes about paid contributions, only DMCA claims) is NOT a dark pattern. A LIABILITY CAP ALONE (e.g. $100, $500, $1000) WITHOUT arbitration or class action waiver is NOT a dark pattern. Do NOT flag a service purely because of a low liability cap or a narrowly scoped limitation period.

Output ONLY valid JSON -- no markdown, no extra text:
{"tldr":"2-sentence plain-English verdict. Name the biggest risk if any.","ai_training":boolean,"data_selling":boolean,"transparency":boolean,"data_retention":boolean,"content_ownership":boolean,"dark_patterns":boolean}"""

DEEP_SYSTEM = """You are a senior privacy attorney and data protection expert. Apply the NULL HYPOTHESIS: default every pillar to violation: false and only change it to true when you can copy-paste a verbatim sentence from the text that proves the violation.

Analyze the legal text against these privacy pillars:
1. ai_training      -- User content or data EXPLICITLY used to train, fine-tune, or build AI/ML MODELS. REQUIRED: the word "train", "fine-tune", "training data", or "build AI model" MUST appear verbatim in your citation. NOT violations: "improve our services", "store and host", broad license grants without "train". DIRECTION CHECK: Only flag if the SERVICE trains on user data. Clauses prohibiting users from scraping are NOT ai_training violations.
2. data_selling     -- Personal data explicitly shared with or sold to named THIRD PARTIES (advertisers, data brokers, marketing partners) for their own commercial benefit. REQUIRED keywords: "advertiser", "data broker", or "marketing partner for their own commercial use". "Service providers" or "vendors helping us" are NOT violations.
3. transparency     -- Language that is SELF-CONTRADICTORY within the same policy section. NOT a contradiction: opt-out rights, jurisdiction-scoped clauses, or cross-references. Requires two statements that directly oppose each other.
4. data_retention   -- An EXPLICIT retention period over 1 year (12 months) post-account-deletion. Silence on retention is NOT a violation.
5. content_ownership -- Broad IP rights beyond what is needed to show your content on the platform. NOT a violation: licensing of feedback, suggestions, ideas, or comments voluntarily submitted. NOT a violation: storage/sync/hosting licenses (e.g. iCloud, Dropbox-style "license to store your files"). NOT a violation: open/Creative Commons licenses (CC BY, CC BY-SA, GFDL) — these protect users, not the company. Only flag for user-generated content published on the platform where the service claims sublicensable commercial rights.
6. dark_patterns    -- REQUIRES at least one of: (1) forced MANDATORY individual arbitration binding ALL disputes, (2) explicit class action waiver, (3) statute of limitations under 2 years that applies broadly to ALL disputes. A statute of limitations scoped only to narrow claim types (e.g. only disputes about specific contributions, only DMCA claims) is NOT a dark pattern. A LIABILITY CAP ALONE without arbitration or class action waiver is NOT a violation. Do NOT flag purely because of a low liability cap or a narrowly scoped limitation period.

CITATION RULE -- VERBATIM COPY-PASTE ONLY:
The 'citation' field must be a verbatim copy-paste of 15-60 consecutive words taken directly from the text.
If silent: write exactly '[NOT_FOUND]'
If document explicitly PROTECTS the user, quote the verbatim protective sentence.

BANNED PATTERNS:
x Any citation starting with: "The policy", "The terms", "No mention", "No explicit", "There is no"
x Any paraphrase, summary, or interpretation

NULL HYPOTHESIS: Default to violation: false. Only set violation: true if you can copy-paste verbatim proof.

Output ONLY valid JSON:
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

CONFIDENCE: HIGH = explicit verbatim clause | MEDIUM = ambiguous or silent | LOW = inferred"""

PP_DATA_SELLING_SYSTEM = """You are a privacy attorney scanning a Privacy Policy for commercial data sharing.

TASK: Does this Privacy Policy indicate that the company shares personal user data with THIRD PARTIES for THEIR OWN commercial benefit?

VIOLATION = true when the PP:
- Shares with advertising partners, ad networks, data brokers, or marketing companies
- Allows third parties to use your data for THEIR OWN targeted ads or commercial purposes
- Uses language like: "advertising partners", "personalized ads", "marketing partners for their own use", "data brokers", "ad partners", "tailored advertising", "targeted content from partners", "interest-based advertising", "third parties may use your data", "business partners", "partners for advertising"
- Sells or licenses personal data to other companies

NOT a violation = false when the PP:
- Only shares with service providers / vendors that process data ON BEHALF OF the company
- Only shares for legal compliance, safety, or fraud prevention
- Only shares within affiliates/subsidiaries of the same corporate family
- The company serves its own first-party ads without sharing underlying user data with external parties

Output ONLY valid JSON:
{"data_selling": boolean, "reason": "one sentence citing the specific language or absence that determined the verdict"}"""

# -- Helpers -------------------------------------------------------------------

def fetch_tos_text(url: str, max_chars: int = 120000) -> str:
    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/124.0.0.0 Safari/537.36"
        ),
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
        "Referer": "https://www.google.com/",
    }
    r = requests.get(url, headers=headers, timeout=25)
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
    for attempt, key in enumerate(keys):  # single rotation only — avoids cascading backoff stalls
        url = f"{GEMINI_BASE}/models/{model}:generateContent?key={key}"
        try:
            r = requests.post(url, json=body, timeout=TIMEOUT_S)
            if r.status_code == 429:
                wait = 15 + attempt * 5   # 15s, 20s, 25s, 30s, 35s, 40s (capped)
                print(f"    Rate limited (429) -- waiting {wait}s...")
                time.sleep(wait)
                last_err = "HTTP 429"
                continue
            if r.status_code in (500, 503):
                wait = 10 + attempt * 5   # 10s, 15s, 20s, 25s, 30s, 35s (capped)
                print(f"    Server error ({r.status_code}) -- waiting {wait}s...")
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
                print(f"    finishReason={finish} -- response may be truncated")
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
        bar = "X" * filled + "." * (bar_width - filled)
        remaining = max(0, seconds - int(secs))
        print(f"\r  [pause] {label} [{bar}] {int(frac*100):3d}%  {remaining:2d}s left ", end="", flush=True)
        if elapsed < seconds * 2:
            time.sleep(0.5)
    print()


def chunk_text(text: str, chunk_size: int = 70000) -> list[str]:
    """Default 70K covers Apple (66K) and Steam (49K). Per-service override via chunk_size field."""
    return [text[:chunk_size]]


def post_process_pillars(pillars: dict) -> dict:
    """D1-D7: deterministic overrides that catch systematic model errors.
    IMPORTANT: All citation-dependent rules skip when citation is empty (BASIC scan has no citations).
    """
    processed = dict(pillars)

    # D1+D2: ai_training citation must contain "train"/"fine-tune" and must not be a ban clause
    # SKIP if citation is empty (BASIC scan) — trust the model when no citation is available
    ai = processed.get("ai_training", {})
    if ai.get("violation"):
        citation = (ai.get("citation") or "").lower()
        if citation:
            has_train = "train" in citation or "fine-tune" in citation or "fine tune" in citation
            is_ban = any(w in citation for w in [
                "prohibited", "not permitted", "you may not", "you must not", "do not", "forbidden",
                "automated means", "engage in any of",
                "as training data", "licensed products",
            ])
            if not has_train:
                print(f"     D1: ai_training cleared -- citation lacks 'train'/'fine-tune': \"{citation[:60]}\"")
                processed["ai_training"] = {**ai, "violation": False, "confidence": "MEDIUM"}
            elif is_ban:
                print(f"     D2: ai_training cleared -- ban clause (not SERVICE training): \"{citation[:60]}\"")
                processed["ai_training"] = {**ai, "violation": False, "confidence": "MEDIUM"}

    # D3: transparency -- scoping language is not a self-contradiction
    transp = processed.get("transparency", {})
    if transp.get("violation"):
        citation = (transp.get("citation") or "").lower()
        if citation and any(w in citation for w in ["opt-out", "solely applies", "limited to", "only applies",
                                        "applies solely", "does not apply to"]):
            print(f"     D3: transparency cleared -- scoping language: \"{citation[:60]}\"")
            processed["transparency"] = {**transp, "violation": False, "confidence": "MEDIUM"}

    # D4: content_ownership -- clear feedback/incoming-submission/utility-license/open-license/hosting FPs
    # SKIP if citation is empty (BASIC scan) — trust the model
    co = processed.get("content_ownership", {})
    if co.get("violation"):
        citation = (co.get("citation") or "").lower()
        if citation:
            feedback_words   = ["feedback", "ideas", "suggestions", "comments", "input"]
            business_submission = ["bing places", "business listing", "business information",
                                   "business profile", "business data"]
            incoming_markers = ["you send", "send us", "send to us", "communicate to us",
                                "you submit", "submit to us", "provided to us", "sent to us",
                                "communication you", "you communicate"]
            published_words  = ["post", "photo", "video", "image", "file", "upload", "creat", "stream", "broadcast"]
            has_feedback         = any(w in citation for w in feedback_words)
            has_incoming         = any(w in citation for w in incoming_markers)
            has_business_submit  = any(w in citation for w in business_submission)
            has_published        = any(w in citation for w in published_words) or bool(re.search(r'\bcontents?\b', citation))
            is_hosting_license   = (
                "non-exclusive" in citation and "royalty-free" in citation and
                any(w in citation for w in ["store", "sync", "backup", "icloud", "host", "access your",
                                            "areas of the service", "areas of our service"])
                and not any(w in citation for w in ["sublicens", "commercial", "advertis", "publish"])
            )
            is_utility_license   = (
                "perpetual" in citation and "non-exclusive" in citation and
                "irrevocable" in citation and not has_published
            )
            is_open_license = any(w in citation for w in [
                "creative commons", "cc by", "cc-by", "open license", "freely licensed",
            ])
            if has_business_submit:
                print(f"     D4: content_ownership cleared -- business submission (not platform UGC): \"{citation[:60]}\"")
                processed["content_ownership"] = {**co, "violation": False, "confidence": "MEDIUM"}
            elif (has_feedback or has_incoming) and not has_published:
                reason = "feedback" if has_feedback else "incoming-submission"
                print(f"     D4: content_ownership cleared -- {reason} clause: \"{citation[:60]}\"")
                processed["content_ownership"] = {**co, "violation": False, "confidence": "MEDIUM"}
            elif is_hosting_license:
                print(f"     D4b: content_ownership cleared -- hosting/storage license (not commercial UGC rights): \"{citation[:60]}\"")
                processed["content_ownership"] = {**co, "violation": False, "confidence": "MEDIUM"}
            elif is_utility_license:
                print(f"     D4b: content_ownership cleared -- utility perpetual license (no UGC markers): \"{citation[:60]}\"")
                processed["content_ownership"] = {**co, "violation": False, "confidence": "MEDIUM"}
            elif is_open_license:
                print(f"     D4c: content_ownership cleared -- open/CC license (user retains rights): \"{citation[:60]}\"")
                processed["content_ownership"] = {**co, "violation": False, "confidence": "MEDIUM"}

    # D5-retention: clear data_retention for public/cached/license-continuation content (not personal data)
    # SKIP if citation is empty (BASIC scan)
    dr = processed.get("data_retention", {})
    if dr.get("violation"):
        citation = (dr.get("citation") or "").lower()
        if citation:
            public_content_retention = any(w in citation for w in [
                "server copies of public content", "cached copies", "search engine cache",
                "publicly available", "archived copies", "public posts",
                "account or access is blocked or otherwise terminated",
                "licences granted by you for public content",
                "license for public content",
                "public content continue",
                "contributions remain",
                "delinquent", "delinquent restricted",                  # Proton Mail account deletion
                "may delete accounts", "inactive account",
            ])
            if public_content_retention:
                print(f"     D5-ret: data_retention cleared -- public/cached/contribution content, not personal data: \"{citation[:60]}\"")
                processed["data_retention"] = {**dr, "violation": False, "confidence": "MEDIUM"}

    # D6+D7: dark_patterns -- scoped arbitration or liability-cap-only
    # SKIP if citation is empty (BASIC scan) — trust the model
    dp = processed.get("dark_patterns", {})
    if dp.get("violation"):
        citation = (dp.get("citation") or "").lower()
        if citation:
            scoped_arbitration = [
                "for violations of this section",
                "related to undisclosed paid",
                "solely for disputes arising from",
                "only in connection with",
                "limited to claims arising from",
                "solely in connection with",
                "undisclosed paid contributions",
                "related to your contributions",
            ]
            has_arbitration   = "arbitration" in citation
            has_class_action  = "class action" in citation or "class-action" in citation
            has_liability_cap = any(w in citation for w in [
                "liability", "damages", "limit", "cap", "exceed", "total amount paid",
            ])
            # D7 requires explicit cap language — not just generic "applicable law" boilerplate
            has_explicit_cap = (
                "shall not exceed" in citation or
                "aggregate" in citation or
                "total liability" in citation or
                bool(re.search(r'\$\d+', citation))
            )
            if any(w in citation for w in scoped_arbitration):
                print(f"     D6: dark_patterns cleared -- arbitration/SOL scoped to specific violations: \"{citation[:60]}\"")
                processed["dark_patterns"] = {**dp, "violation": False, "confidence": "MEDIUM"}
            elif has_liability_cap and has_explicit_cap and not has_arbitration and not has_class_action:
                print(f"     D7: dark_patterns cleared -- liability cap only, no arbitration/class-action waiver: \"{citation[:60]}\"")
                processed["dark_patterns"] = {**dp, "violation": False, "confidence": "MEDIUM"}

    return processed


def scan_pp_for_data_selling(pp_url: str, keys: list) -> bool:
    try:
        print(f"  Fetching Privacy Policy for data_selling check: {pp_url}")
        pp_text = fetch_tos_text(pp_url, max_chars=60000)
        print(f"     Fetched {len(pp_text):,} chars")
        pp_lower = pp_text.lower()
        service_provider_only = all(
            kw not in pp_lower
            for kw in ["advertis", "broker", "marketing partner", "targeted", "personaliz",
                       "personalis", "commercial partner", "third-party partner", "business partner"]
        )
        if service_provider_only and not any(kw in pp_lower for kw in ["third party", "third-party", "share your"]):
            print(f"     data_selling clear (no data-sharing keywords in PP -- D5 pre-filter)")
            return False
        progress_sleep(RATE_SLEEP_S, "Rate-limit cooldown before PP scan")
        result = call_gemini(PP_DATA_SELLING_SYSTEM, pp_text[:55000], PRIMARY_MODEL, keys)
        parsed = extract_json(result.get("content", "{}")) or {}
        found = bool(parsed.get("data_selling", False))
        if parsed.get("reason"):
            print(f"     PP reason: {parsed['reason'][:120]}")
        print(f"     {'data_selling FOUND in Privacy Policy' if found else 'data_selling clear in Privacy Policy'}")
        return found
    except Exception as e:
        print(f"     PP scan failed (non-fatal): {e}")
        return False


def apply_pp_data_selling(result_dict: dict, pp_found: bool) -> dict:
    if not pp_found:
        return result_dict
    parsed = extract_json(result_dict.get("content", "{}")) or {}
    if "pillars" in parsed:
        if not parsed["pillars"].get("data_selling", {}).get("violation"):
            parsed["pillars"]["data_selling"] = {
                "violation": True, "citation": "[Found in Privacy Policy]", "confidence": "MEDIUM",
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
                if conf_order.get(v.get("confidence", "LOW"), 0) > conf_order.get(existing.get("confidence", "LOW"), 0):
                    merged_pillars[k] = v
    return {"content": json.dumps({"tldr": tldr, "pillars": merged_pillars}),
            "input_tokens": sum(r.get("input_tokens", 0) for r in results),
            "output_tokens": sum(r.get("output_tokens", 0) for r in results),
            "model": results[0]["model"] if results else ""}


def ensemble_merge(primary: dict, corroborator: dict) -> dict:
    p_json = extract_json(primary["content"])
    c_json = extract_json(corroborator["content"])
    if not p_json or not c_json or "pillars" not in p_json or "pillars" not in c_json:
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
            if conf_order.get(c.get("confidence", "LOW"), 0) > conf_order.get(p.get("confidence", "LOW"), 0):
                merged[key] = c
    return {
        "content": json.dumps({**p_json, "pillars": merged}),
        "input_tokens": primary["input_tokens"] + corroborator["input_tokens"],
        "output_tokens": primary["output_tokens"] + corroborator["output_tokens"],
        "model": f"{primary['model']} + {corroborator['model']} (ensemble)",
        "ensemble": True,
    }


# -- Report helpers ------------------------------------------------------------

PILLAR_ICONS = {
    "ai_training": "[AI]", "data_selling": "[$]", "transparency": "[?]",
    "data_retention": "[D]", "content_ownership": "[C]", "dark_patterns": "[!]",
}

def rating_label(r: str) -> str:
    return {"SAFE": "[SAFE]", "OKAY": "[OKAY]", "RISKY": "[RISKY]"}.get(r, "[?]")

def grade_label(g: str) -> str:
    return {"A": "[A]", "B": "[B]", "C": "[C]", "D": "[D]", "E": "[E]", "F": "[F]"}.get(g, "[?]")

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
        "precision": len(true_pos) / len(detected) if detected else (1.0 if not known else 0.0),
        "recall":    len(true_pos) / len(known)    if known    else 1.0,
    }


def print_scan_result(service: dict, scan_type: str, result: dict, tos_len: int):
    content_json = extract_json(result["content"])
    if not content_json:
        print(f"  JSON parse failed. Raw: {result['content'][:200]}")
        return None

    if scan_type == "BASIC":
        pillars_flags = {
            k: {"violation": v, "confidence": "HIGH", "citation": ""}
            for k, v in content_json.items() if k != "tldr"
        }
        score, rating = compute_score(pillars_flags)
        tldr = content_json.get("tldr", "")
    else:
        pillars_flags = content_json.get("pillars", {})
        score, rating = compute_score(pillars_flags)
        tldr = content_json.get("tldr", "")

    acc      = accuracy_check(pillars_flags, service["ground_truth"])
    expected = service["ground_truth"]["expected_rating"]
    grade    = service.get("tosdr_grade", "?")
    match    = "OK" if rating == expected else "FAIL"

    print(f"\n{'--'*35}")
    print(f"  [{scan_type}] {service['name']}  |  tosdr: Grade {grade}  |  {rating} (score: {score})  [{match}] expected {expected}")
    print(f"  Model: {result['model']}  |  Tokens in/out: {result['input_tokens']}/{result['output_tokens']}")
    print(f"  ToS length fetched: {tos_len:,} chars")
    print(f"  TL;DR: {tldr}")

    print(f"\n  Pillar Breakdown:")
    for pillar, data in pillars_flags.items():
        icon  = PILLAR_ICONS.get(pillar, ".")
        v     = data.get("violation", False)
        conf  = data.get("confidence", "")
        flag  = "VIOLATION" if v else "clear"
        cit   = data.get("citation", "")
        cit_s = f'  "{cit[:60]}..."' if cit and cit not in ("[NOT_FOUND]", "") and len(cit) > 20 else (f"  [{cit}]" if cit else "")
        print(f"    {icon} {pillar:20s}  {flag}  {conf}{cit_s}")

    print(f"\n  Accuracy vs tosdr.org (Grade {grade}):")
    if not service["ground_truth"]["known_violations"]:
        if not acc["false_positives"]:
            print(f"    True Negative -- correctly identified as clean (no violations flagged)")
        else:
            print(f"    False Positives: {', '.join(acc['false_positives'])}  <- should NOT be flagged on Grade {grade}")
    else:
        if acc["true_positives"]:
            print(f"    True Positives  : {', '.join(acc['true_positives'])}")
        if acc["false_negatives"]:
            print(f"    False Negatives : {', '.join(acc['false_negatives'])}  <- MISSED real violations")
        if acc["false_positives"]:
            print(f"    False Positives : {', '.join(acc['false_positives'])}  <- over-flagged")
    print(f"    Precision: {acc['precision']:.0%}  |  Recall: {acc['recall']:.0%}")

    return {
        "service": service["name"], "tosdr_grade": grade, "scan_type": scan_type,
        "score": score, "rating": rating, "expected_rating": expected,
        "rating_match": rating == expected,
        "precision": acc["precision"], "recall": acc["recall"],
        "false_negatives": acc["false_negatives"], "false_positives": acc["false_positives"],
        "model": result["model"],
        "tokens_in": result["input_tokens"], "tokens_out": result["output_tokens"],
        "latency_s": 0.0,
    }


# -- Main ----------------------------------------------------------------------

def main():
    print("=" * 70)
    print("  TLDR SHIELD -- Full 25-Service Scan Battery")
    print("  Original 10 (Grades B-F) + Expansion 15 (Grades A-F)")
    print("  25 Basic + 25 Deep scans | Post-processing D1-D7 | chunk 70K (Epic 83K)")
    print("  Models: gemini-2.5-flash (basic) | flash + flash-lite (deep)")
    print("=" * 70)

    all_results = []

    for svc in SERVICES:
        print(f"\n{'=='*35}")
        grade = svc.get("tosdr_grade", "?")
        print(f"  {svc['name']}  |  tosdr Grade {grade}  |  expected: {svc['ground_truth']['expected_rating']}")
        print(f"  URL: {svc['tos_url']}")
        try:
            tos_text = fetch_tos_text(svc["tos_url"])
            print(f"  Fetched {len(tos_text):,} chars")
        except Exception as e:
            print(f"  Fetch failed: {e}")
            continue

        chunk_size = svc.get("chunk_size", 70000)
        chunks = chunk_text(tos_text, chunk_size)
        print(f"  Using first {len(chunks[0]):,} chars of {len(tos_text):,} total (chunk_size={chunk_size:,})")

        # PP co-scan
        pp_data_selling = False
        if svc.get("pp_url"):
            progress_sleep(RATE_SLEEP_S, "Rate-limit cooldown before PP fetch")
            pp_data_selling = scan_pp_for_data_selling(svc["pp_url"], SCAN_KEYS)

        # BASIC scan
        print(f"\n  Running BASIC scan...")
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
            print(f"  Done in {basic_result['latency_s']}s")
            r = print_scan_result(svc, "BASIC", basic_result, len(tos_text))
            if r:
                r["latency_s"] = basic_result["latency_s"]
                all_results.append(r)
        except Exception as e:
            print(f"  Basic scan failed: {e}")

        progress_sleep(RATE_SLEEP_S, "Rate-limit cooldown (basic -> deep)")

        # DEEP scan (ensemble)
        print(f"\n  Running DEEP scan (ensemble)...")
        t0 = time.time()
        try:
            primary_r = call_gemini(DEEP_SYSTEM, chunks[0], PRIMARY_MODEL, SCAN_KEYS)
            progress_sleep(RATE_SLEEP_S, "Rate-limit cooldown (primary -> corroborator)")
            corr_r    = call_gemini(DEEP_SYSTEM, chunks[0], CORROBORATOR, SCAN_KEYS)
            deep_result = ensemble_merge(merge_deep_results([primary_r]), merge_deep_results([corr_r]))
            deep_result = apply_pp_data_selling(deep_result, pp_data_selling)
            deep_parsed = extract_json(deep_result.get("content", "{}")) or {}
            if "pillars" in deep_parsed:
                deep_parsed["pillars"] = post_process_pillars(deep_parsed["pillars"])
                deep_result = {**deep_result, "content": json.dumps(deep_parsed)}
            deep_result["latency_s"] = round(time.time() - t0, 1)
            print(f"  Done in {deep_result['latency_s']}s (ensemble merged)")
            r = print_scan_result(svc, "DEEP", deep_result, len(tos_text))
            if r:
                r["latency_s"] = deep_result["latency_s"]
                all_results.append(r)
        except Exception as e:
            print(f"  Deep scan failed: {e}")

        progress_sleep(RATE_SLEEP_S, "Rate-limit cooldown (next service)")

    # -- SUMMARY ---------------------------------------------------------------
    print(f"\n\n{'=='*35}")
    print("  SUMMARY -- Full 25-Service Battery Results")
    print(f"{'=='*35}")

    basic_results = [r for r in all_results if r["scan_type"] == "BASIC"]
    deep_results  = [r for r in all_results if r["scan_type"] == "DEEP"]

    for group_name, group in [("BASIC (gemini-2.5-flash alone)", basic_results),
                               ("DEEP (ensemble: flash + flash-lite)", deep_results)]:
        if not group:
            continue
        correct  = sum(1 for r in group if r["rating_match"])
        avg_prec = sum(r["precision"] for r in group) / len(group)
        avg_rec  = sum(r["recall"] for r in group) / len(group)
        avg_lat  = sum(r["latency_s"] for r in group) / len(group)
        print(f"\n  {group_name}:")
        print(f"    Rating accuracy : {correct}/{len(group)} correct")
        print(f"    Avg Precision   : {avg_prec:.0%}")
        print(f"    Avg Recall      : {avg_rec:.0%}")
        print(f"    Avg Latency     : {avg_lat:.1f}s")
        for grade in ["A", "B", "C", "D", "E", "F"]:
            gg = [r for r in group if r.get("tosdr_grade") == grade]
            if not gg:
                continue
            print(f"\n    Grade {grade}:")
            for r in gg:
                m  = "OK" if r["rating_match"] else "FAIL"
                fn = f"  missed: {','.join(r['false_negatives'])}" if r["false_negatives"] else ""
                fp = f"  over-flagged: {','.join(r['false_positives'])}" if r["false_positives"] else ""
                print(f"      [{m}] {r['service']:16s} -> {r['rating']:5s} (exp {r['expected_rating']})  P={r['precision']:.0%} R={r['recall']:.0%}{fn}{fp}")

    print(f"\n{'--'*35}")
    print("  FALSE POSITIVE ANALYSIS (Grade A+B -- should be SAFE)")
    print(f"{'--'*35}")
    safe_expected = [r for r in all_results if r["expected_rating"] == "SAFE"]
    for r in safe_expected:
        if r["false_positives"]:
            print(f"  FAIL {r['service']:16s} ({r['scan_type']:5s}): wrongly flagged {r['false_positives']}")
        else:
            print(f"  OK   {r['service']:16s} ({r['scan_type']:5s}): clean -- no false positives")

    print(f"\n{'--'*35}")
    print("  SPECIFICITY SUMMARY")
    print(f"{'--'*35}")
    safe_correct  = sum(1 for r in safe_expected if r["rating_match"])
    risky_results = [r for r in all_results if r["expected_rating"] == "RISKY"]
    risky_correct = sum(1 for r in risky_results if r["rating_match"])
    print(f"  True Negative Rate (SAFE correctly identified) : {safe_correct}/{len(safe_expected)}")
    print(f"  True Positive Rate (RISKY correctly identified): {risky_correct}/{len(risky_results)}")

    print(f"\n{'--'*35}")
    print("  BOTTLENECK ANALYSIS")
    print(f"{'--'*35}")
    if basic_results and deep_results:
        basic_rec   = sum(r["recall"]    for r in basic_results) / len(basic_results)
        deep_rec    = sum(r["recall"]    for r in deep_results)  / len(deep_results)
        basic_prec  = sum(r["precision"] for r in basic_results) / len(basic_results)
        deep_prec   = sum(r["precision"] for r in deep_results)  / len(deep_results)
        recall_gain = deep_rec - basic_rec
        print(f"  Basic recall : {basic_rec:.0%}  |  Deep recall : {deep_rec:.0%}  |  Ensemble gain: {recall_gain:+.0%}")
        print(f"  Basic precision : {basic_prec:.0%}  |  Deep precision : {deep_prec:.0%}")

        from collections import Counter
        all_fn = [fn for r in all_results for fn in r.get("false_negatives", [])]
        if all_fn:
            print(f"\n  Consistently missed violations (false negatives):")
            for pillar, count in Counter(all_fn).most_common():
                print(f"    . {pillar} -- missed {count}x")
        all_fp = [fp for r in all_results for fp in r.get("false_positives", [])]
        if all_fp:
            print(f"\n  Consistently over-flagged (false positives):")
            for pillar, count in Counter(all_fp).most_common():
                print(f"    . {pillar} -- over-flagged {count}x")

    print(f"\n{'=='*35}\n")


if __name__ == "__main__":
    main()
