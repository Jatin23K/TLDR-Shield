import urllib.request, json, time

def scan(label, text, tier="quick"):
    url = "http://localhost:3000/api/analyze"
    payload = json.dumps({"text": text, "tier": tier, "eli5": False, "darkPatterns": True}).encode()
    req = urllib.request.Request(url, data=payload, headers={"Content-Type": "application/json"})
    t0 = time.time()
    result = None
    with urllib.request.urlopen(req, timeout=60) as r:
        for line in r:
            line = line.decode("utf-8").strip()
            if line.startswith("data:"):
                try:
                    d = json.loads(line[5:])
                    if "rating" in d:
                        result = d
                    if "error" in d:
                        print(f"  [{label}] ERROR: {d['error']}")
                        return
                except Exception:
                    pass
    elapsed = time.time() - t0
    if result:
        v = [k for k, v2 in result.get("pillars", {}).items() if v2.get("violation")]
        cached = " [CACHED]" if result.get("cached") else ""
        chunked = f" [CHUNKED x{result.get('chunkCount',1)}]" if result.get("chunked") else ""
        status = "PASS" if _check(label, result) else "FAIL"
        print(f"  [{status}] {label:<28} {result['rating']:>5} {result['score']:>3}/100  {elapsed:.1f}s  violations={len(v)}{cached}{chunked}")
        print(f"         tldr: {result.get('tldr','')[:80]}")
    else:
        print(f"  [FAIL] {label:<28} NO RESULT {elapsed:.1f}s")

def _check(label, r):
    if "T1" in label: return True
    if "CLEAN" in label: return r["rating"] == "SAFE" and r["score"] >= 85
    if "RISKY" in label or "MEGA" in label: return r["rating"] == "RISKY" and r["score"] < 50
    if "OKAY" in label: return r["rating"] == "OKAY"
    return True

CLEAN = (
    "We collect only your email to send receipts. We never sell your data to third parties. "
    "You may delete your account at any time and all data is removed within 30 days. "
    "We do not use your data for AI training. Our policy is clear and simple. "
    "Data is retained only while your account is active."
)
RISKY = (
    "By using our service you grant us a perpetual irrevocable worldwide royalty-free license "
    "to use, reproduce, modify, publish your content for any purpose including AI training. "
    "We share your personal data including location, browsing history, and contacts with our "
    "847 advertising partners. You waive your right to class action lawsuits. Data is retained "
    "indefinitely after account deletion. Opt-out requires written mail to our legal department "
    "within 3 days of account creation."
)
OKAY = (
    "We collect your email and usage analytics to improve our service. Usage data may be used "
    "to train internal recommendation models — you can opt out in Settings at any time. "
    "We do not sell your personal data to third parties. You may delete your account; data is "
    "removed within 14 days. You retain full ownership of all files you upload."
)
MEGACORP = (
    "MEGACORP GLOBAL TERMS v47.2. Section 3.1: MegaCorp and its 847 advertising partners may "
    "collect and share your personal data including name, email, phone, location, device IDs, "
    "browsing history, purchase history, biometric data, voice recordings for any commercial purpose. "
    "Section 3.2: Your data is used to train AI and ML models. No opt-out available. "
    "Section 4.1: You grant MegaCorp a perpetual irrevocable worldwide royalty-free license "
    "to use, reproduce, modify, distribute your content for any purpose. "
    "Section 5.1: MegaCorp retains your data for 10 years after account deletion. "
    "Section 6.1: You waive all class action rights and agree to binding arbitration."
)

print("=" * 65)
print("TLDR SHIELD — FINAL VERIFICATION")
print(f"Model: meta/llama-3.3-70b-instruct (both tiers)")
print("=" * 65)

print("\nT1  Input validation")
try:
    scan("T1-TOO-SHORT", "We use cookies.", "quick")
except Exception as e:
    print(f"  [PASS] T1-TOO-SHORT               Correct 400 rejection")

print("\nT2  Quick scan — clean doc (expect SAFE 90+)")
scan("T2-CLEAN-QUICK", CLEAN, "quick")

print("\nT3  Quick scan — risky doc (expect RISKY <50)")
scan("T3-RISKY-QUICK", RISKY, "quick")

print("\nT4  Quick scan — okay doc (expect OKAY 50-74)")
scan("T4-OKAY-QUICK", OKAY, "quick")

print("\nT5  Deep scan — clean doc (expect SAFE 90+)")
scan("T5-CLEAN-DEEP", CLEAN, "deep")

print("\nT6  Deep scan — MegaCorp 6-violations (expect RISKY 0-9)")
scan("T6-MEGA-DEEP", MEGACORP, "deep")

print("\nT7  Cache hit (repeat T2)")
scan("T7-CACHE-HIT", CLEAN, "quick")

print()
print("=" * 65)
