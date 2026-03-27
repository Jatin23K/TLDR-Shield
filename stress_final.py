import urllib.request, json, time, ssl

ctx = ssl.create_default_context()
keys = [
    "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",
    "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",
    "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",
]

DEEP_SYSTEM = (
    "You are a senior privacy attorney. Analyze for 6 pillars: "
    "ai_training, data_selling, transparency, data_retention, content_ownership, dark_patterns. "
    "Scoring: 0 violations=90-100 SAFE | 1 minor=60-89 OKAY | 1 major or 2+=25-59 RISKY | 3+=0-24 RISKY. "
    'Output ONLY valid JSON (no markdown): {"rating":"SAFE"|"OKAY"|"RISKY","score":0-100,"tldr":"2-sentence summary",'
    '"pillars":{"ai_training":{"violation":bool,"citation":"verbatim or Not addressed"},'
    '"data_selling":{"violation":bool,"citation":"verbatim or Not addressed"},'
    '"transparency":{"violation":bool,"citation":"verbatim or Not addressed"},'
    '"data_retention":{"violation":bool,"citation":"verbatim or Not addressed"},'
    '"content_ownership":{"violation":bool,"citation":"verbatim or Not addressed"},'
    '"dark_patterns":{"violation":bool,"citation":"verbatim or Not addressed"}}}'
)

LONG_DOC = """FACEBOOK / META PLATFORMS TERMS OF SERVICE (Extract)

SECTION 1 - WHAT WE COLLECT
We collect content, communications and other information you provide when you use our Products.
We collect information about how you use our Products including types of content you view,
features you use, actions you take, people you interact with, and duration of activities.

SECTION 2 - DEVICE INFORMATION
We collect information from computers, phones, TVs and other devices you use with our Products.
Device identifiers including unique IDs from games or apps you use and Family Device IDs.

SECTION 3 - INFORMATION FROM PARTNERS
Advertisers, app developers, and publishers send us information through Facebook Business Tools
about your activities off Facebook including websites you visit, purchases you make, ads you see,
whether or not you have a Facebook account or are logged in.

SECTION 4 - HOW WE USE YOUR INFORMATION
We use your data including preferences, content you share and interact with to train artificial
intelligence and machine learning models that power our features and develop new AI systems.
There is no way to opt out of this data use while maintaining an active account.
We share information globally both internally and externally with partners around the world.

SECTION 5 - SHARING WITH THIRD-PARTY PARTNERS
We share your personal data including demographics, interests, behavior, and location data
with approximately 10,000 advertising and analytics partners for their own commercial advertising purposes.

SECTION 6 - DATA RETENTION
When you delete your account, we retain certain data for up to 5 years for legal and business purposes.
Backup copies may persist for up to 90 days after deletion. Anonymized or aggregated data derived
from your account is retained indefinitely and is not subject to deletion requests.

SECTION 7 - CONTENT LICENSE
When you share or upload content on our Products, you grant us a non-exclusive, transferable,
sub-licensable, royalty-free, worldwide license to host, use, distribute, modify, run, copy,
publicly perform or display, translate, and create derivative works of your content.
This license does not end when you stop using our Products unless your content is deleted by all.

SECTION 8 - DISPUTE RESOLUTION
You agree that any claim against Meta must be resolved exclusively through binding arbitration
on an individual basis. YOU ARE WAIVING YOUR RIGHT TO A TRIAL BY JURY AND TO PARTICIPATE IN
A CLASS ACTION LAWSUIT OR CLASS-WIDE ARBITRATION."""


def call_model(model, key_idx=0):
    payload = json.dumps({
        "model": model,
        "messages": [
            {"role": "system", "content": DEEP_SYSTEM},
            {"role": "user", "content": f"Analyze:\n{LONG_DOC}"}
        ],
        "temperature": 0.2,
        "max_tokens": 900
    }).encode()
    req = urllib.request.Request(
        "https://integrate.api.nvidia.com/v1/chat/completions",
        data=payload,
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {keys[key_idx]}"}
    )
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=35, context=ctx) as r:
        resp = json.loads(r.read())
    elapsed = time.time() - t0
    content = resp["choices"][0]["message"]["content"].strip()
    if content.startswith("```"):
        content = content.split("```")[1].lstrip("json").strip()
    s = content.find("{")
    e = content.rfind("}")
    data = json.loads(content[s:e+1]) if s != -1 else None
    return elapsed, data


models = [
    "meta/llama-3.3-70b-instruct",
    "mistralai/mixtral-8x22b-instruct-v0.1",
]

print("REAL-WORLD LENGTH T&C TEST (Meta/Facebook extract)")
print("Expected: RISKY, score 0-15, ALL 6 pillars violated")
print("=" * 65)

for model in models:
    print(f"\n{model}")
    times = []
    scores = []
    violations_counts = []
    for run in range(3):
        try:
            elapsed, data = call_model(model, key_idx=run % 3)
            if data:
                v = [k for k, v2 in data["pillars"].items() if v2.get("violation")]
                times.append(elapsed)
                scores.append(data["score"])
                violations_counts.append(len(v))
                print(f"  Run {run+1}: {data['rating']:>5} {data['score']:>3}/100  {elapsed:.1f}s  {len(v)}/6 violations  truncated={data.get('truncated',False)}")
            else:
                print(f"  Run {run+1}: NO JSON {elapsed:.1f}s")
        except Exception as ex:
            print(f"  Run {run+1}: FAIL {str(ex)[:60]}")
        time.sleep(0.8)
    if times:
        avg_t = sum(times) / len(times)
        avg_s = sum(scores) / len(scores)
        consistent = (max(scores) - min(scores)) <= 10
        avg_v = sum(violations_counts) / len(violations_counts)
        print(f"  SUMMARY: avg_time={avg_t:.1f}s | avg_score={avg_s:.0f}/100 | avg_violations={avg_v:.1f}/6 | consistent={consistent}")
