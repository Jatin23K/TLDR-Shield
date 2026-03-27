import time
from openai import OpenAI

# --- CONFIGURATION ---
# Using your literal path from the terminal screenshot
SAVE_PATH = r"C:\projects\TLDR Shield [Too Long, Didn't Read]"

API_KEYS = [
    "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",
    "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",
    "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"
]

# Standard NVIDIA NIM Base URL
BASE_URL = "https://integrate.api.nvidia.com/v1"

# CORRECTED CANONICAL NAMES (404 FIX)
BASIC_SCAN_MODEL = "meta/llama-3.3-70b-instruct"
DEEP_SCAN_MODEL = "deepseek-ai/deepseek-r1-distill-llama-70b"

def run_tier_analysis(api_key, key_index):
    client = OpenAI(api_key=api_key, base_url=BASE_URL)
    print(f"\n{'='*40}")
    print(f" TESTING KEY #{key_index + 1} ")
    print(f"{'='*40}")

    tasks = [
        ("BASIC SCAN", BASIC_SCAN_MODEL, "Identify 5 critical points."),
        ("DEEP SCAN ", DEEP_SCAN_MODEL, "Analyze the legal logic.")
    ]

    for label, model_id, prompt in tasks:
        print(f"🚀 Running {label} ({model_id})...")
        start = time.perf_counter()
        try:
            # Short test to confirm 200 OK
            response = client.chat.completions.create(
                model=model_id,
                messages=[{"role": "user", "content": "ping"}],
                max_tokens=10,
                stream=False
            )
            latency = (time.perf_counter() - start) * 1000
            print(f"✅ [200 OK] Latency: {latency:.2f}ms")
            
        except Exception as e:
            # This captures the exact reason (401, 403, 404, etc.)
            print(f"❌ FAILED: {e}")

if __name__ == "__main__":
    for i, key in enumerate(API_KEYS):
        run_tier_analysis(key, i)