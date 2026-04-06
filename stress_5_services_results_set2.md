# TLDR Shield 5-Service Stress Test (Set 2: Basic + Deep)

- Quick model: `meta/llama-3.3-70b-instruct`
- Deep model: `meta/llama-3.3-70b-instruct`
- Services: 5
- Runs per service per tier: 2

## Reddit
Source: https://www.redditinc.com/policies/user-agreement
Expected ratings: RISKY/OKAY

- Run 1 BASIC: RISKY (40) | latency=3.09s | violations=content_ownership | expectedMatch=true
- Run 1 DEEP: RISKY (25) | latency=6.51s | violations=data_selling, content_ownership | expectedMatch=true

- Run 2 BASIC: RISKY (40) | latency=3.77s | violations=transparency, content_ownership | expectedMatch=true
- Run 2 DEEP: RISKY (25) | latency=3.04s | violations=data_selling, content_ownership | expectedMatch=true

## Discord
Source: https://discord.com/terms
Expected ratings: RISKY/OKAY

- Run 1 BASIC: RISKY (40) | latency=14.18s | violations=transparency, content_ownership | expectedMatch=true
- Run 1 DEEP: RISKY (25) | latency=7.41s | violations=data_selling, content_ownership | expectedMatch=true

- Run 2 BASIC: RISKY (25) | latency=4.57s | violations=data_selling, content_ownership | expectedMatch=true
- Run 2 DEEP: RISKY (25) | latency=8.77s | violations=data_selling, content_ownership | expectedMatch=true

## YouTube
Source: https://www.youtube.com/t/terms
Expected ratings: RISKY

- Run 1 BASIC: RISKY (20) | latency=4.26s | violations=data_selling, transparency, content_ownership | expectedMatch=true
- Run 1 DEEP: RISKY (25) | latency=3.95s | violations=data_selling, content_ownership | expectedMatch=true

- Run 2 BASIC: RISKY (20) | latency=3.41s | violations=data_selling, transparency, content_ownership | expectedMatch=true
- Run 2 DEEP: RISKY (25) | latency=4.80s | violations=data_selling, content_ownership | expectedMatch=true

## LinkedIn
Source: https://www.linkedin.com/legal/user-agreement
Expected ratings: RISKY

- Run 1 BASIC: RISKY (30) | latency=4.46s | violations=data_selling, transparency, content_ownership | expectedMatch=true
- Run 1 DEEP: RISKY (40) | latency=6.49s | violations=content_ownership | expectedMatch=true

- Run 2 BASIC: RISKY (30) | latency=5.74s | violations=data_selling, transparency, content_ownership | expectedMatch=true
- Run 2 DEEP: RISKY (40) | latency=6.48s | violations=content_ownership | expectedMatch=true

## Amazon
Source: https://www.amazon.com/gp/help/customer/display.html?nodeId=508088
Expected ratings: RISKY/OKAY

- Run 1 BASIC: RISKY (20) | latency=3.72s | violations=data_selling, transparency, content_ownership | expectedMatch=true
- Run 1 DEEP: RISKY (30) | latency=4.52s | violations=data_selling, transparency, content_ownership | expectedMatch=true

- Run 2 BASIC: RISKY (20) | latency=4.55s | violations=data_selling, transparency, content_ownership | expectedMatch=true
- Run 2 DEEP: ERROR (Request was aborted.) | latency=1224.78s | violations=n/a | expectedMatch=false

## Aggregate

- Tier: QUICK
  - Parse rate: 10/10
  - Expected rating match: 10/10 (100.0%)
  - Latency p50: 4.26s
  - Latency p90: 5.74s
  - Latency min/max: 3.09s / 14.18s
- Tier: DEEP
  - Parse rate: 9/10
  - Expected rating match: 9/9 (100.0%)
  - Latency p50: 6.48s
  - Latency p90: 7.41s
  - Latency min/max: 3.04s / 8.77s

## Raw JSON

```json
[
  {
    "service": "Reddit",
    "sourceUrl": "https://www.redditinc.com/policies/user-agreement",
    "run": 1,
    "tier": "quick",
    "model": "meta/llama-3.3-70b-instruct",
    "latencyMs": 3091,
    "parseOk": true,
    "expectedRatingMatch": true,
    "rating": "RISKY",
    "score": 40,
    "violations": [
      "content_ownership"
    ]
  },
  {
    "service": "Reddit",
    "sourceUrl": "https://www.redditinc.com/policies/user-agreement",
    "run": 1,
    "tier": "deep",
    "model": "meta/llama-3.3-70b-instruct",
    "latencyMs": 6506,
    "parseOk": true,
    "expectedRatingMatch": true,
    "rating": "RISKY",
    "score": 25,
    "violations": [
      "data_selling",
      "content_ownership"
    ]
  },
  {
    "service": "Reddit",
    "sourceUrl": "https://www.redditinc.com/policies/user-agreement",
    "run": 2,
    "tier": "quick",
    "model": "meta/llama-3.3-70b-instruct",
    "latencyMs": 3775,
    "parseOk": true,
    "expectedRatingMatch": true,
    "rating": "RISKY",
    "score": 40,
    "violations": [
      "transparency",
      "content_ownership"
    ]
  },
  {
    "service": "Reddit",
    "sourceUrl": "https://www.redditinc.com/policies/user-agreement",
    "run": 2,
    "tier": "deep",
    "model": "meta/llama-3.3-70b-instruct",
    "latencyMs": 3036,
    "parseOk": true,
    "expectedRatingMatch": true,
    "rating": "RISKY",
    "score": 25,
    "violations": [
      "data_selling",
      "content_ownership"
    ]
  },
  {
    "service": "Discord",
    "sourceUrl": "https://discord.com/terms",
    "run": 1,
    "tier": "quick",
    "model": "meta/llama-3.3-70b-instruct",
    "latencyMs": 14175,
    "parseOk": true,
    "expectedRatingMatch": true,
    "rating": "RISKY",
    "score": 40,
    "violations": [
      "transparency",
      "content_ownership"
    ]
  },
  {
    "service": "Discord",
    "sourceUrl": "https://discord.com/terms",
    "run": 1,
    "tier": "deep",
    "model": "meta/llama-3.3-70b-instruct",
    "latencyMs": 7410,
    "parseOk": true,
    "expectedRatingMatch": true,
    "rating": "RISKY",
    "score": 25,
    "violations": [
      "data_selling",
      "content_ownership"
    ]
  },
  {
    "service": "Discord",
    "sourceUrl": "https://discord.com/terms",
    "run": 2,
    "tier": "quick",
    "model": "meta/llama-3.3-70b-instruct",
    "latencyMs": 4572,
    "parseOk": true,
    "expectedRatingMatch": true,
    "rating": "RISKY",
    "score": 25,
    "violations": [
      "data_selling",
      "content_ownership"
    ]
  },
  {
    "service": "Discord",
    "sourceUrl": "https://discord.com/terms",
    "run": 2,
    "tier": "deep",
    "model": "meta/llama-3.3-70b-instruct",
    "latencyMs": 8772,
    "parseOk": true,
    "expectedRatingMatch": true,
    "rating": "RISKY",
    "score": 25,
    "violations": [
      "data_selling",
      "content_ownership"
    ]
  },
  {
    "service": "YouTube",
    "sourceUrl": "https://www.youtube.com/t/terms",
    "run": 1,
    "tier": "quick",
    "model": "meta/llama-3.3-70b-instruct",
    "latencyMs": 4257,
    "parseOk": true,
    "expectedRatingMatch": true,
    "rating": "RISKY",
    "score": 20,
    "violations": [
      "data_selling",
      "transparency",
      "content_ownership"
    ]
  },
  {
    "service": "YouTube",
    "sourceUrl": "https://www.youtube.com/t/terms",
    "run": 1,
    "tier": "deep",
    "model": "meta/llama-3.3-70b-instruct",
    "latencyMs": 3947,
    "parseOk": true,
    "expectedRatingMatch": true,
    "rating": "RISKY",
    "score": 25,
    "violations": [
      "data_selling",
      "content_ownership"
    ]
  },
  {
    "service": "YouTube",
    "sourceUrl": "https://www.youtube.com/t/terms",
    "run": 2,
    "tier": "quick",
    "model": "meta/llama-3.3-70b-instruct",
    "latencyMs": 3411,
    "parseOk": true,
    "expectedRatingMatch": true,
    "rating": "RISKY",
    "score": 20,
    "violations": [
      "data_selling",
      "transparency",
      "content_ownership"
    ]
  },
  {
    "service": "YouTube",
    "sourceUrl": "https://www.youtube.com/t/terms",
    "run": 2,
    "tier": "deep",
    "model": "meta/llama-3.3-70b-instruct",
    "latencyMs": 4803,
    "parseOk": true,
    "expectedRatingMatch": true,
    "rating": "RISKY",
    "score": 25,
    "violations": [
      "data_selling",
      "content_ownership"
    ]
  },
  {
    "service": "LinkedIn",
    "sourceUrl": "https://www.linkedin.com/legal/user-agreement",
    "run": 1,
    "tier": "quick",
    "model": "meta/llama-3.3-70b-instruct",
    "latencyMs": 4458,
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
    "service": "LinkedIn",
    "sourceUrl": "https://www.linkedin.com/legal/user-agreement",
    "run": 1,
    "tier": "deep",
    "model": "meta/llama-3.3-70b-instruct",
    "latencyMs": 6491,
    "parseOk": true,
    "expectedRatingMatch": true,
    "rating": "RISKY",
    "score": 40,
    "violations": [
      "content_ownership"
    ]
  },
  {
    "service": "LinkedIn",
    "sourceUrl": "https://www.linkedin.com/legal/user-agreement",
    "run": 2,
    "tier": "quick",
    "model": "meta/llama-3.3-70b-instruct",
    "latencyMs": 5741,
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
    "service": "LinkedIn",
    "sourceUrl": "https://www.linkedin.com/legal/user-agreement",
    "run": 2,
    "tier": "deep",
    "model": "meta/llama-3.3-70b-instruct",
    "latencyMs": 6476,
    "parseOk": true,
    "expectedRatingMatch": true,
    "rating": "RISKY",
    "score": 40,
    "violations": [
      "content_ownership"
    ]
  },
  {
    "service": "Amazon",
    "sourceUrl": "https://www.amazon.com/gp/help/customer/display.html?nodeId=508088",
    "run": 1,
    "tier": "quick",
    "model": "meta/llama-3.3-70b-instruct",
    "latencyMs": 3720,
    "parseOk": true,
    "expectedRatingMatch": true,
    "rating": "RISKY",
    "score": 20,
    "violations": [
      "data_selling",
      "transparency",
      "content_ownership"
    ]
  },
  {
    "service": "Amazon",
    "sourceUrl": "https://www.amazon.com/gp/help/customer/display.html?nodeId=508088",
    "run": 1,
    "tier": "deep",
    "model": "meta/llama-3.3-70b-instruct",
    "latencyMs": 4518,
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
    "service": "Amazon",
    "sourceUrl": "https://www.amazon.com/gp/help/customer/display.html?nodeId=508088",
    "run": 2,
    "tier": "quick",
    "model": "meta/llama-3.3-70b-instruct",
    "latencyMs": 4555,
    "parseOk": true,
    "expectedRatingMatch": true,
    "rating": "RISKY",
    "score": 20,
    "violations": [
      "data_selling",
      "transparency",
      "content_ownership"
    ]
  },
  {
    "service": "Amazon",
    "sourceUrl": "https://www.amazon.com/gp/help/customer/display.html?nodeId=508088",
    "run": 2,
    "tier": "deep",
    "model": "meta/llama-3.3-70b-instruct",
    "latencyMs": 1224775,
    "parseOk": false,
    "expectedRatingMatch": false,
    "error": "Request was aborted."
  }
]
```
