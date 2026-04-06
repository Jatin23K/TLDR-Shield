# Backup Model Validation

> Testing backup candidates with refined v3 prompt
> Goal: find a model that can pair with either primary for 98%+ ensemble

=======================================================
  X (Twitter)
  Expected: RISKY | Violations: ai_training, data_selling, content_ownership
-------------------------------------------------------

### Qwen2.5-32b
Run 1: RISKY ✅ S:24 V:[ai_training, data_selling, content_ownership] 11.6s | 5/5 ✅
Run 2: RISKY ✅ S:24 V:[ai_training, data_selling, content_ownership] 12.1s | 5/5 ✅
Run 3: RISKY ✅ S:24 V:[ai_training, data_selling, content_ownership] 12.4s | 5/5 ✅
Run 4: RISKY ✅ S:24 V:[ai_training, data_selling, content_ownership] 11.1s | 5/5 ✅
Run 5: RISKY ✅ S:24 V:[ai_training, data_selling, content_ownership] 12.2s | 5/5 ✅

### Gemma-3-27b
Run 1: RISKY ✅ S:35 V:[ai_training, data_selling, content_ownership] 9.2s | 5/5 ✅
Run 2: RISKY ✅ S:35 V:[ai_training, data_selling, content_ownership] 9.0s | 5/5 ✅
Run 3: RISKY ✅ S:35 V:[ai_training, data_selling, content_ownership] 8.9s | 5/5 ✅
Run 4: RISKY ✅ S:35 V:[ai_training, data_selling, content_ownership] 9.6s | 5/5 ✅
Run 5: RISKY ✅ S:35 V:[ai_training, data_selling, content_ownership] 9.1s | 5/5 ✅
=======================================================
  TikTok
  Expected: RISKY | Violations: ai_training, data_selling, data_retention, content_ownership
-------------------------------------------------------

### Qwen2.5-32b
Run 1: RISKY ✅ S:25 V:[ai_training, data_selling, content_ownership] 7.1s | MISS: data_retention(exp=true,got=false)
Run 2: RISKY ✅ S:35 V:[ai_training, data_selling, transparency, content_ownership] 8.7s | MISS: transparency(exp=false,got=true), data_retention(exp=true,got=false)
Run 3: RISKY ✅ S:35 V:[ai_training, data_selling, transparency, content_ownership] 8.8s | MISS: transparency(exp=false,got=true), data_retention(exp=true,got=false)
Run 4: RISKY ✅ S:35 V:[ai_training, data_selling, transparency, content_ownership] 8.6s | MISS: transparency(exp=false,got=true), data_retention(exp=true,got=false)
Run 5: RISKY ✅ S:25 V:[ai_training, data_selling, content_ownership] 7.3s | MISS: data_retention(exp=true,got=false)

### Gemma-3-27b
Run 1: RISKY ✅ S:35 V:[ai_training, data_selling, data_retention, content_ownership] 9.6s | 5/5 ✅
Run 2: RISKY ✅ S:35 V:[ai_training, data_selling, data_retention, content_ownership] 9.5s | 5/5 ✅
Run 3: RISKY ✅ S:35 V:[ai_training, data_selling, content_ownership] 9.6s | MISS: data_retention(exp=true,got=false)
Run 4: RISKY ✅ S:35 V:[ai_training, data_selling, data_retention, content_ownership] 10.0s | 5/5 ✅
Run 5: RISKY ✅ S:35 V:[ai_training, data_selling, data_retention, content_ownership] 9.6s | 5/5 ✅
=======================================================
  Signal
  Expected: SAFE/OKAY | Violations: None
-------------------------------------------------------

### Qwen2.5-32b
Run 1: SAFE ✅ S:95 V:[None] 6.2s | 5/5 ✅
Run 2: SAFE ✅ S:95 V:[None] 5.5s | 5/5 ✅
Run 3: SAFE ✅ S:95 V:[None] 6.6s | 5/5 ✅
Run 4: SAFE ✅ S:95 V:[None] 5.5s | 5/5 ✅
Run 5: SAFE ✅ S:95 V:[None] 6.2s | 5/5 ✅

### Gemma-3-27b
Run 1: SAFE ✅ S:95 V:[None] 6.2s | 5/5 ✅
Run 2: SAFE ✅ S:95 V:[None] 6.7s | 5/5 ✅
Run 3: SAFE ✅ S:95 V:[None] 6.2s | 5/5 ✅
Run 4: SAFE ✅ S:95 V:[None] 6.3s | 5/5 ✅
Run 5: SAFE ✅ S:95 V:[None] 6.3s | 5/5 ✅
=======================================================
  DuckDuckGo
  Expected: SAFE/OKAY | Violations: None
-------------------------------------------------------

### Qwen2.5-32b
Run 1: SAFE ✅ S:95 V:[None] 5.7s | 5/5 ✅
Run 2: SAFE ✅ S:95 V:[None] 4.8s | 5/5 ✅
Run 3: SAFE ✅ S:95 V:[None] 5.2s | 5/5 ✅
Run 4: SAFE ✅ S:95 V:[None] 5.3s | 5/5 ✅
Run 5: SAFE ✅ S:95 V:[None] 4.7s | 5/5 ✅

### Gemma-3-27b
Run 1: SAFE ✅ S:95 V:[None] 5.6s | 5/5 ✅
Run 2: SAFE ✅ S:95 V:[None] 6.4s | 5/5 ✅
Run 3: SAFE ✅ S:95 V:[None] 6.0s | 5/5 ✅
Run 4: SAFE ✅ S:95 V:[None] 5.7s | 5/5 ✅
Run 5: SAFE ✅ S:98 V:[None] 5.9s | 5/5 ✅
=======================================================
  Spotify
  Expected: RISKY/OKAY | Violations: data_selling, content_ownership
-------------------------------------------------------

### Qwen2.5-32b
Run 1: RISKY ✅ S:25 V:[data_selling, content_ownership] 6.3s | 5/5 ✅
Run 2: RISKY ✅ S:25 V:[data_selling, content_ownership] 7.1s | 5/5 ✅
Run 3: RISKY ✅ S:25 V:[data_selling, content_ownership] 6.3s | 5/5 ✅
Run 4: RISKY ✅ S:24 V:[data_selling, content_ownership] 7.2s | 5/5 ✅
Run 5: RISKY ✅ S:25 V:[data_selling, content_ownership] 7.7s | 5/5 ✅

### Gemma-3-27b
Run 1: RISKY ✅ S:35 V:[data_selling, content_ownership] 7.4s | 5/5 ✅
Run 2: RISKY ✅ S:35 V:[data_selling, content_ownership] 7.3s | 5/5 ✅
Run 3: RISKY ✅ S:35 V:[data_selling, content_ownership] 7.2s | 5/5 ✅
Run 4: RISKY ✅ S:35 V:[data_selling, content_ownership] 7.4s | 5/5 ✅
Run 5: RISKY ✅ S:35 V:[data_selling, content_ownership] 7.2s | 5/5 ✅

=======================================================
              BACKUP MODEL SUMMARY
=======================================================

## Solo Accuracy

| Metric | Qwen2.5-32b | Gemma-3-27b |
|--------|------------|------------|
| Parse Rate | 25/25 | 25/25 |
| Rating Accuracy | 25/25 (100.0%) | 25/25 (100.0%) |
| **Pillar Accuracy** | **117/125 (93.6%)** | **124/125 (99.2%)** |
| Avg Latency | 7.61s | 7.68s |
| Max Latency | 12.41s | 10.04s |

## Miss Breakdown

| Service:Pillar | Qwen2.5-32b | Gemma-3-27b |
|---------------|------------|------------|
| TikTok:data_retention | 5/5 | 1/5 |
| TikTok:transparency | 3/5 | 0/5 |

## Simulated Ensemble (Union) with Primary Models

> Using known primary model results from the validated solo test:
> - Qwen3-80b: 92.8% solo (misses X:data_selling=0/5, TikTok:data_retention=3/5, TikTok:content_ownership=3/5, Spotify:data_selling=3/5)
> - Mixtral-8x22b: 96.0% solo (misses X:data_selling=5/5, TikTok:data_retention=2/5, TikTok:content_ownership=1/5)

### Does backup cover primary blind spots?

| Blind Spot | Qwen2.5-32b catches? | Gemma-3-27b catches? |
|-----------|---------------------|---------------------|
| Mixtral misses X:data_selling | 5/5 ✅ | 5/5 ✅ |
| Qwen misses TikTok:data_retention | 0/5 ⚠️ | 4/5 ✅ |
| Qwen misses TikTok:content_ownership | 5/5 ✅ | 5/5 ✅ |
| Qwen misses Spotify:data_selling | 5/5 ✅ | 5/5 ✅ |

