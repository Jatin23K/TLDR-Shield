# TLDR Shield 5-Service Stress Test (Basic + Deep)

- Quick model: `meta/llama-3.3-70b-instruct`
- Deep model: `meta/llama-3.3-70b-instruct`
- Services: 5
- Runs per service per tier: 2

## X (Twitter)
Source: https://x.com/en/tos
Expected ratings: RISKY

- Run 1 BASIC: RISKY (20) | latency=3.32s | violations=ai_training, data_selling, content_ownership | expectedMatch=true
- Run 1 DEEP: OKAY (60) | latency=4.20s | violations=n/a | expectedMatch=false

- Run 2 BASIC: RISKY (20) | latency=3.15s | violations=ai_training, data_selling, content_ownership | expectedMatch=true
- Run 2 DEEP: OKAY (60) | latency=3.60s | violations=n/a | expectedMatch=false

## TikTok
Source: https://www.tiktok.com/legal/page/us/terms-of-service/en
Expected ratings: RISKY

- Run 1 BASIC: RISKY (20) | latency=17.98s | violations=ai_training, data_selling, transparency, content_ownership | expectedMatch=true
- Run 1 DEEP: RISKY (30) | latency=3.36s | violations=ai_training, data_selling, content_ownership | expectedMatch=true

- Run 2 BASIC: RISKY (20) | latency=3.62s | violations=ai_training, data_selling, content_ownership | expectedMatch=true
- Run 2 DEEP: RISKY (30) | latency=5.99s | violations=ai_training, data_selling, transparency, data_retention, content_ownership | expectedMatch=true

## Signal
Source: https://signal.org/legal/
Expected ratings: SAFE/OKAY

- Run 1 BASIC: SAFE (100) | latency=3.00s | violations=n/a | expectedMatch=true
- Run 1 DEEP: SAFE (90) | latency=3.93s | violations=n/a | expectedMatch=true

- Run 2 BASIC: SAFE (100) | latency=2.96s | violations=n/a | expectedMatch=true
- Run 2 DEEP: SAFE (90) | latency=3.77s | violations=n/a | expectedMatch=true

## DuckDuckGo
Source: https://duckduckgo.com/terms
Expected ratings: SAFE/OKAY

- Run 1 BASIC: SAFE (95) | latency=3.52s | violations=n/a | expectedMatch=true
- Run 1 DEEP: SAFE (90) | latency=4.98s | violations=n/a | expectedMatch=true

- Run 2 BASIC: SAFE (95) | latency=20.86s | violations=n/a | expectedMatch=true
- Run 2 DEEP: SAFE (90) | latency=3.12s | violations=n/a | expectedMatch=true

## Spotify
Source: https://www.spotify.com/us/legal/end-user-agreement/
Expected ratings: RISKY/OKAY

- Run 1 BASIC: RISKY (30) | latency=6.68s | violations=data_selling, transparency, content_ownership | expectedMatch=true
- Run 1 DEEP: OKAY (60) | latency=2.71s | violations=n/a | expectedMatch=true

- Run 2 BASIC: RISKY (30) | latency=7.78s | violations=data_selling, content_ownership | expectedMatch=true
- Run 2 DEEP: OKAY (60) | latency=4.41s | violations=n/a | expectedMatch=true

## Aggregate

- Tier: QUICK
  - Parse rate: 10/10
  - Expected rating match: 10/10 (100.0%)
  - Latency p50: 3.52s
  - Latency p90: 17.98s
  - Latency min/max: 2.96s / 20.86s
- Tier: DEEP
  - Parse rate: 10/10
  - Expected rating match: 8/10 (80.0%)
  - Latency p50: 3.77s
  - Latency p90: 4.98s
  - Latency min/max: 2.71s / 5.99s

## Raw JSON

```json
[
  {
    "service": "X (Twitter)",
    "sourceUrl": "https://x.com/en/tos",
    "run": 1,
    "tier": "quick",
    "model": "meta/llama-3.3-70b-instruct",
    "latencyMs": 3322,
    "parseOk": true,
    "expectedRatingMatch": true,
    "rating": "RISKY",
    "score": 20,
    "violations": [
      "ai_training",
      "data_selling",
      "content_ownership"
    ]
  },
  {
    "service": "X (Twitter)",
    "sourceUrl": "https://x.com/en/tos",
    "run": 1,
    "tier": "deep",
    "model": "meta/llama-3.3-70b-instruct",
    "latencyMs": 4200,
    "parseOk": true,
    "expectedRatingMatch": false,
    "rating": "OKAY",
    "score": 60,
    "violations": []
  },
  {
    "service": "X (Twitter)",
    "sourceUrl": "https://x.com/en/tos",
    "run": 2,
    "tier": "quick",
    "model": "meta/llama-3.3-70b-instruct",
    "latencyMs": 3155,
    "parseOk": true,
    "expectedRatingMatch": true,
    "rating": "RISKY",
    "score": 20,
    "violations": [
      "ai_training",
      "data_selling",
      "content_ownership"
    ]
  },
  {
    "service": "X (Twitter)",
    "sourceUrl": "https://x.com/en/tos",
    "run": 2,
    "tier": "deep",
    "model": "meta/llama-3.3-70b-instruct",
    "latencyMs": 3602,
    "parseOk": true,
    "expectedRatingMatch": false,
    "rating": "OKAY",
    "score": 60,
    "violations": []
  },
  {
    "service": "TikTok",
    "sourceUrl": "https://www.tiktok.com/legal/page/us/terms-of-service/en",
    "run": 1,
    "tier": "quick",
    "model": "meta/llama-3.3-70b-instruct",
    "latencyMs": 17982,
    "parseOk": true,
    "expectedRatingMatch": true,
    "rating": "RISKY",
    "score": 20,
    "violations": [
      "ai_training",
      "data_selling",
      "transparency",
      "content_ownership"
    ]
  },
  {
    "service": "TikTok",
    "sourceUrl": "https://www.tiktok.com/legal/page/us/terms-of-service/en",
    "run": 1,
    "tier": "deep",
    "model": "meta/llama-3.3-70b-instruct",
    "latencyMs": 3360,
    "parseOk": true,
    "expectedRatingMatch": true,
    "rating": "RISKY",
    "score": 30,
    "violations": [
      "ai_training",
      "data_selling",
      "content_ownership"
    ]
  },
  {
    "service": "TikTok",
    "sourceUrl": "https://www.tiktok.com/legal/page/us/terms-of-service/en",
    "run": 2,
    "tier": "quick",
    "model": "meta/llama-3.3-70b-instruct",
    "latencyMs": 3620,
    "parseOk": true,
    "expectedRatingMatch": true,
    "rating": "RISKY",
    "score": 20,
    "violations": [
      "ai_training",
      "data_selling",
      "content_ownership"
    ]
  },
  {
    "service": "TikTok",
    "sourceUrl": "https://www.tiktok.com/legal/page/us/terms-of-service/en",
    "run": 2,
    "tier": "deep",
    "model": "meta/llama-3.3-70b-instruct",
    "latencyMs": 5991,
    "parseOk": true,
    "expectedRatingMatch": true,
    "rating": "RISKY",
    "score": 30,
    "violations": [
      "ai_training",
      "data_selling",
      "transparency",
      "data_retention",
      "content_ownership"
    ]
  },
  {
    "service": "Signal",
    "sourceUrl": "https://signal.org/legal/",
    "run": 1,
    "tier": "quick",
    "model": "meta/llama-3.3-70b-instruct",
    "latencyMs": 3004,
    "parseOk": true,
    "expectedRatingMatch": true,
    "rating": "SAFE",
    "score": 100,
    "violations": []
  },
  {
    "service": "Signal",
    "sourceUrl": "https://signal.org/legal/",
    "run": 1,
    "tier": "deep",
    "model": "meta/llama-3.3-70b-instruct",
    "latencyMs": 3934,
    "parseOk": true,
    "expectedRatingMatch": true,
    "rating": "SAFE",
    "score": 90,
    "violations": []
  },
  {
    "service": "Signal",
    "sourceUrl": "https://signal.org/legal/",
    "run": 2,
    "tier": "quick",
    "model": "meta/llama-3.3-70b-instruct",
    "latencyMs": 2957,
    "parseOk": true,
    "expectedRatingMatch": true,
    "rating": "SAFE",
    "score": 100,
    "violations": []
  },
  {
    "service": "Signal",
    "sourceUrl": "https://signal.org/legal/",
    "run": 2,
    "tier": "deep",
    "model": "meta/llama-3.3-70b-instruct",
    "latencyMs": 3766,
    "parseOk": true,
    "expectedRatingMatch": true,
    "rating": "SAFE",
    "score": 90,
    "violations": []
  },
  {
    "service": "DuckDuckGo",
    "sourceUrl": "https://duckduckgo.com/terms",
    "run": 1,
    "tier": "quick",
    "model": "meta/llama-3.3-70b-instruct",
    "latencyMs": 3524,
    "parseOk": true,
    "expectedRatingMatch": true,
    "rating": "SAFE",
    "score": 95,
    "violations": []
  },
  {
    "service": "DuckDuckGo",
    "sourceUrl": "https://duckduckgo.com/terms",
    "run": 1,
    "tier": "deep",
    "model": "meta/llama-3.3-70b-instruct",
    "latencyMs": 4977,
    "parseOk": true,
    "expectedRatingMatch": true,
    "rating": "SAFE",
    "score": 90,
    "violations": []
  },
  {
    "service": "DuckDuckGo",
    "sourceUrl": "https://duckduckgo.com/terms",
    "run": 2,
    "tier": "quick",
    "model": "meta/llama-3.3-70b-instruct",
    "latencyMs": 20863,
    "parseOk": true,
    "expectedRatingMatch": true,
    "rating": "SAFE",
    "score": 95,
    "violations": []
  },
  {
    "service": "DuckDuckGo",
    "sourceUrl": "https://duckduckgo.com/terms",
    "run": 2,
    "tier": "deep",
    "model": "meta/llama-3.3-70b-instruct",
    "latencyMs": 3119,
    "parseOk": true,
    "expectedRatingMatch": true,
    "rating": "SAFE",
    "score": 90,
    "violations": []
  },
  {
    "service": "Spotify",
    "sourceUrl": "https://www.spotify.com/us/legal/end-user-agreement/",
    "run": 1,
    "tier": "quick",
    "model": "meta/llama-3.3-70b-instruct",
    "latencyMs": 6682,
    "parseOk": true,
    "expectedRatingMatch": true,
    "rating": "RISKY",
    "score": 30,
    "violations": [
      "data_selling",
      "transparency",
      "content_ownership"
    ]
  },
  {
    "service": "Spotify",
    "sourceUrl": "https://www.spotify.com/us/legal/end-user-agreement/",
    "run": 1,
    "tier": "deep",
    "model": "meta/llama-3.3-70b-instruct",
    "latencyMs": 2705,
    "parseOk": true,
    "expectedRatingMatch": true,
    "rating": "OKAY",
    "score": 60,
    "violations": []
  },
  {
    "service": "Spotify",
    "sourceUrl": "https://www.spotify.com/us/legal/end-user-agreement/",
    "run": 2,
    "tier": "quick",
    "model": "meta/llama-3.3-70b-instruct",
    "latencyMs": 7780,
    "parseOk": true,
    "expectedRatingMatch": true,
    "rating": "RISKY",
    "score": 30,
    "violations": [
      "data_selling",
      "content_ownership"
    ]
  },
  {
    "service": "Spotify",
    "sourceUrl": "https://www.spotify.com/us/legal/end-user-agreement/",
    "run": 2,
    "tier": "deep",
    "model": "meta/llama-3.3-70b-instruct",
    "latencyMs": 4410,
    "parseOk": true,
    "expectedRatingMatch": true,
    "rating": "OKAY",
    "score": 60,
    "violations": []
  }
]
```
