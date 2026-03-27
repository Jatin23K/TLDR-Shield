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
        has_pillars = result.get("pillars") is not None
        v_count = len([k for k, v in (result.get("pillars") or {}).items() if v.get("violation")]) if has_pillars else "N/A"
        cached = " [CACHED]" if result.get("cached") else ""
        chunked = f" [CHUNKED x{result.get('chunkCount',1)}]" if result.get("chunked") else ""
        print(f"  {label:<30} {result['rating']:>5} {result['score']:>3}/100  {elapsed:.1f}s  pillars={'YES' if has_pillars else 'NO':>3}  violations={v_count}{cached}{chunked}")
        print(f"    tldr: {result.get('tldr','')[:90]}")
    else:
        print(f"  {label:<30} NO RESULT {elapsed:.1f}s")

RISKY = (
    "By using our service you grant us a perpetual irrevocable worldwide royalty-free license "
    "to use, reproduce, modify, publish your content for any purpose including AI training. "
    "We share your personal data including location, browsing history, and contacts with our "
    "847 advertising partners. You waive your right to class action lawsuits. Data is retained "
    "indefinitely after account deletion. Opt-out requires written mail to our legal department "
    "within 3 days of account creation."
)

CLEAN = (
    "We collect only your email to send receipts. We never sell your data to third parties. "
    "You may delete your account at any time and all data is removed within 30 days. "
    "We do not use your data for AI training. Our policy is clear and simple. "
    "Data is retained only while your account is active."
)

print("=" * 72)
print("TIER DIFFERENTIATION TEST")
print("Quick = badge only (no pillars) | Deep = full breakdown (pillars + citations)")
print("=" * 72)
print()

print("QUICK SCAN (expect: rating+score+tldr only, NO pillars detail)")
scan("Quick — Clean doc", CLEAN, "quick")
scan("Quick — Risky doc", RISKY, "quick")
print()

print("DEEP SCAN (expect: rating+score+tldr + ALL pillars + citations)")
scan("Deep  — Clean doc", CLEAN, "deep")
scan("Deep  — Risky doc", RISKY, "deep")
print()
print("=" * 72)
