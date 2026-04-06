# Ensemble Deep Scan — Final Validation

> **Models:** `qwen3-next-80b` + `mixtral-8x22b` (parallel)
> **Ensemble:** Union (OR) — if EITHER flags a violation, it's flagged
> **Prompt:** Refined v3 — zero false positives confirmed in solo testing
> **Rationale:** Solo tests showed these models have OPPOSITE blind spots with NO overlapping false positives. Union fills each model's gaps.

=======================================================
  X (Twitter)
  Expected: RISKY | Violations: ai_training, data_selling, content_ownership
-------------------------------------------------------

**Run 1:**
  Qwen:    RISKY S:35 V:[ai_training,data_selling,content_ownership] 7.2s
  Mixtral: RISKY S:40 V:[ai_training,content_ownership] 4.5s
  **ENSEMBLE: RISKY ✅ | Score: 35 | V: [ai_training, data_selling, content_ownership] | Pillars: 5/5 ✅ PERFECT | 7.2s ✅**

**Run 2:**
  Qwen:    RISKY S:35 V:[ai_training,data_selling,content_ownership] 7.2s
  Mixtral: RISKY S:45 V:[ai_training,content_ownership] 4.6s
  **ENSEMBLE: RISKY ✅ | Score: 35 | V: [ai_training, data_selling, content_ownership] | Pillars: 5/5 ✅ PERFECT | 7.2s ✅**

**Run 3:**
  Qwen:    RISKY S:35 V:[ai_training,data_selling,content_ownership] 8.3s
  Mixtral: RISKY S:45 V:[ai_training,content_ownership] 4.4s
  **ENSEMBLE: RISKY ✅ | Score: 35 | V: [ai_training, data_selling, content_ownership] | Pillars: 5/5 ✅ PERFECT | 8.3s ✅**

**Run 4:**
  Qwen:    RISKY S:35 V:[ai_training,data_selling,content_ownership] 8.6s
  Mixtral: RISKY S:40 V:[ai_training,content_ownership] 4.4s
  **ENSEMBLE: RISKY ✅ | Score: 35 | V: [ai_training, data_selling, content_ownership] | Pillars: 5/5 ✅ PERFECT | 8.6s ✅**

**Run 5:**
  Qwen:    RISKY S:35 V:[ai_training,data_selling,content_ownership] 6.1s
  Mixtral: RISKY S:40 V:[ai_training,content_ownership] 4.4s
  **ENSEMBLE: RISKY ✅ | Score: 35 | V: [ai_training, data_selling, content_ownership] | Pillars: 5/5 ✅ PERFECT | 6.1s ✅**
=======================================================
  TikTok
  Expected: RISKY | Violations: ai_training, data_selling, data_retention, content_ownership
-------------------------------------------------------

**Run 1:**
  Qwen:    RISKY S:25 V:[ai_training,data_selling,content_ownership] 7.7s
  Mixtral: RISKY S:45 V:[ai_training,data_selling,data_retention,content_ownership] 5.3s
  **ENSEMBLE: RISKY ✅ | Score: 25 | V: [ai_training, data_selling, data_retention, content_ownership] | Pillars: 5/5 ✅ PERFECT | 7.7s ✅**

**Run 2:**
  Qwen:    RISKY S:25 V:[ai_training,data_selling] 5.7s
  Mixtral: RISKY S:45 V:[ai_training,data_selling,data_retention,content_ownership] 5.3s
  **ENSEMBLE: RISKY ✅ | Score: 25 | V: [ai_training, data_selling, data_retention, content_ownership] | Pillars: 5/5 ✅ PERFECT | 5.7s ✅**

**Run 3:**
  Qwen:    RISKY S:25 V:[ai_training,data_selling] 12.1s
  Mixtral: RISKY S:45 V:[ai_training,data_selling,data_retention,content_ownership] 5.3s
  **ENSEMBLE: RISKY ✅ | Score: 25 | V: [ai_training, data_selling, data_retention, content_ownership] | Pillars: 5/5 ✅ PERFECT | 12.1s ✅**

**Run 4:**
  Qwen:    RISKY S:25 V:[ai_training,data_selling] 6.2s
  Mixtral: RISKY S:45 V:[ai_training,data_selling,data_retention,content_ownership] 5.4s
  **ENSEMBLE: RISKY ✅ | Score: 25 | V: [ai_training, data_selling, data_retention, content_ownership] | Pillars: 5/5 ✅ PERFECT | 6.2s ✅**

**Run 5:**
  Qwen:    RISKY S:25 V:[ai_training,data_selling] 5.3s
  Mixtral: RISKY S:45 V:[ai_training,data_selling,data_retention,content_ownership] 5.4s
  **ENSEMBLE: RISKY ✅ | Score: 25 | V: [ai_training, data_selling, data_retention, content_ownership] | Pillars: 5/5 ✅ PERFECT | 5.4s ✅**
=======================================================
  Signal
  Expected: SAFE/OKAY | Violations: None
-------------------------------------------------------

**Run 1:**
  Qwen:    SAFE S:100 V:[—] 5.1s
  Mixtral: SAFE S:100 V:[—] 4.2s
  **ENSEMBLE: SAFE ✅ | Score: 100 | V: [None] | Pillars: 5/5 ✅ PERFECT | 5.1s ✅**

**Run 2:**
  Qwen:    SAFE S:100 V:[—] 5.1s
  Mixtral: SAFE S:100 V:[—] 4.2s
  **ENSEMBLE: SAFE ✅ | Score: 100 | V: [None] | Pillars: 5/5 ✅ PERFECT | 5.1s ✅**

**Run 3:**
  Qwen:    SAFE S:100 V:[—] 4.3s
  Mixtral: SAFE S:100 V:[—] 4.3s
  **ENSEMBLE: SAFE ✅ | Score: 100 | V: [None] | Pillars: 5/5 ✅ PERFECT | 4.3s ✅**

**Run 4:**
  Qwen:    SAFE S:100 V:[—] 4.1s
  Mixtral: SAFE S:100 V:[—] 4.4s
  **ENSEMBLE: SAFE ✅ | Score: 100 | V: [None] | Pillars: 5/5 ✅ PERFECT | 4.4s ✅**

**Run 5:**
  Qwen:    SAFE S:100 V:[—] 9.9s
  Mixtral: SAFE S:100 V:[—] 4.2s
  **ENSEMBLE: SAFE ✅ | Score: 100 | V: [None] | Pillars: 5/5 ✅ PERFECT | 9.9s ✅**
=======================================================
  DuckDuckGo
  Expected: SAFE/OKAY | Violations: None
-------------------------------------------------------

**Run 1:**
  Qwen:    SAFE S:100 V:[—] 4.2s
  Mixtral: SAFE S:100 V:[—] 4.4s
  **ENSEMBLE: SAFE ✅ | Score: 100 | V: [None] | Pillars: 5/5 ✅ PERFECT | 4.4s ✅**

**Run 2:**
  Qwen:    SAFE S:100 V:[—] 4.2s
  Mixtral: SAFE S:100 V:[—] 4.3s
  **ENSEMBLE: SAFE ✅ | Score: 100 | V: [None] | Pillars: 5/5 ✅ PERFECT | 4.3s ✅**

**Run 3:**
  Qwen:    SAFE S:100 V:[—] 3.8s
  Mixtral: SAFE S:100 V:[—] 4.3s
  **ENSEMBLE: SAFE ✅ | Score: 100 | V: [None] | Pillars: 5/5 ✅ PERFECT | 4.3s ✅**

**Run 4:**
  Qwen:    SAFE S:100 V:[—] 5.0s
  Mixtral: SAFE S:100 V:[—] 4.3s
  **ENSEMBLE: SAFE ✅ | Score: 100 | V: [None] | Pillars: 5/5 ✅ PERFECT | 5.0s ✅**

**Run 5:**
  Qwen:    SAFE S:100 V:[—] 5.7s
  Mixtral: SAFE S:100 V:[—] 4.3s
  **ENSEMBLE: SAFE ✅ | Score: 100 | V: [None] | Pillars: 5/5 ✅ PERFECT | 5.7s ✅**
=======================================================
  Spotify
  Expected: RISKY/OKAY | Violations: data_selling, content_ownership
-------------------------------------------------------

**Run 1:**
  Qwen:    OKAY S:75 V:[data_selling,content_ownership] 4.2s
  Mixtral: RISKY S:45 V:[data_selling,content_ownership] 4.8s
  **ENSEMBLE: RISKY ✅ | Score: 45 | V: [data_selling, content_ownership] | Pillars: 5/5 ✅ PERFECT | 4.8s ✅**

**Run 2:**
  Qwen:    OKAY S:72 V:[data_selling,content_ownership] 5.2s
  Mixtral: RISKY S:45 V:[data_selling,content_ownership] 4.8s
  **ENSEMBLE: RISKY ✅ | Score: 45 | V: [data_selling, content_ownership] | Pillars: 5/5 ✅ PERFECT | 5.2s ✅**

**Run 3:**
  Qwen:    OKAY S:75 V:[data_selling,content_ownership] 4.4s
  Mixtral: RISKY S:45 V:[data_selling,content_ownership] 4.9s
  **ENSEMBLE: RISKY ✅ | Score: 45 | V: [data_selling, content_ownership] | Pillars: 5/5 ✅ PERFECT | 4.9s ✅**

**Run 4:**
  Qwen:    OKAY S:75 V:[data_selling,content_ownership] 5.9s
  Mixtral: RISKY S:45 V:[data_selling,content_ownership] 4.8s
  **ENSEMBLE: RISKY ✅ | Score: 45 | V: [data_selling, content_ownership] | Pillars: 5/5 ✅ PERFECT | 5.9s ✅**

**Run 5:**
  Qwen:    OKAY S:75 V:[data_selling,content_ownership] 12.4s
  Mixtral: RISKY S:45 V:[data_selling,content_ownership] 4.9s
  **ENSEMBLE: RISKY ✅ | Score: 45 | V: [data_selling, content_ownership] | Pillars: 5/5 ✅ PERFECT | 12.4s ✅**

=======================================================
              FINAL RESULTS
=======================================================

## Accuracy

| Metric | Result |
|--------|--------|
| **Ensemble Pillar Accuracy** | **125/125 (100.0%)** |
| Qwen3-80b Solo Pillar Acc | 116/125 (92.8%) |
| Mixtral-8x22b Solo Pillar Acc | 120/125 (96.0%) |
| Rating Accuracy | 25/25 (100.0%) |
| Parse Rate | 100% (both models) |

## Latency

| Metric | Value |
|--------|-------|
| Parallel Avg | 6.42s |
| P50 | 5.72s |
| P90 | 9.87s |
| Max | 12.45s |
| All Under 20s | 25/25 |

## 🎯 ZERO MISSES — PERFECT ACCURACY

