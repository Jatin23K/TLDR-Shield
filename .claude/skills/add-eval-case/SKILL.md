---
name: add-eval-case
description: Add a correctly formatted test case to eval/dataset.jsonl, validate schema, and quick-test it.
user-invocable: true
---

# Add Eval Case Skill

Add a new test case to `eval/dataset.jsonl` with the correct schema, then validate and smoke-test it.

## When to use

- Adding a new policy text to test coverage
- Reproducing a bug or false positive/negative as a regression test
- Expanding the dataset after a pillar definition change

## Steps

### 1. Determine the next ID

Read the last line of `eval/dataset.jsonl` and increment the `t{N}` number. Check existing IDs:

```bash
grep -o '"id":"t[0-9]*' eval/dataset.jsonl | sort
```

### 2. Choose the label

Label format: `t{N}_{descriptor}` where descriptor is short and meaningful.

Examples:
- `t9_risky_ai_training`
- `t10_safe_minimal`
- `t11_okay_vague_retention`

### 3. Write the case

Append one JSON object (no trailing comma — JSONL is one object per line):

```jsonc
{
  "id": "t{N}_{label}",
  "text": "...actual policy text to analyze...",
  "expected": {
    "rating": "SAFE" | "OKAY" | "RISKY",
    "pillars": {
      "ai_training": false,
      "data_selling": false,
      "transparency": false,
      "data_retention": false,
      "content_ownership": false,
      "dark_patterns": false
    }
  }
}
```

**Schema rules — all required, will silently fail if wrong:**
- `id`: string, `t{N}_{label}` convention
- `text`: string, the policy text (can be a snippet or full doc)
- `expected.rating`: exactly `"SAFE"`, `"OKAY"`, or `"RISKY"` (uppercase)
- `expected.pillars`: object with **all 6 keys**, all boolean
- Pillar keys must be **snake_case** — `ai_training` not `aiTraining`
- All 6 pillar keys required: `ai_training`, `data_selling`, `transparency`, `data_retention`, `content_ownership`, `dark_patterns`

### 4. Validate the JSONL schema

After appending, verify the file is still valid JSONL:

```bash
node -e "
const fs = require('fs');
const lines = fs.readFileSync('eval/dataset.jsonl','utf8').trim().split('\n');
const required = ['ai_training','data_selling','transparency','data_retention','content_ownership','dark_patterns'];
lines.forEach((line, i) => {
  const c = JSON.parse(line);
  if (!c.id || !c.text || !c.expected) throw new Error(\`Line \${i+1}: missing top-level fields\`);
  if (!['SAFE','OKAY','RISKY'].includes(c.expected.rating)) throw new Error(\`Line \${i+1}: invalid rating\`);
  required.forEach(k => {
    if (typeof c.expected.pillars[k] !== 'boolean') throw new Error(\`Line \${i+1}: pillar '\${k}' missing or not boolean\`);
  });
});
console.log('All', lines.length, 'cases valid');
"
```

If any error is thrown, fix it before proceeding.

### 5. Smoke-test the new case

Run eval on quick tier only (faster) to verify the new case doesn't break parsing:

```bash
npm run eval:quick 2>&1 | tail -50
```

Check that:
- `parseFails` is still 0
- The new case ID appears in the output
- No new errors in the output

### 6. Check accuracy impact

If the new case is expected to be a **regression test** (testing a known failure), the overall accuracy numbers will drop. This is expected — note it explicitly:

> "Added case t{N} as a regression test for [issue]. pillarsPct will show as lower until the underlying bug is fixed."

If accuracy dropped unexpectedly, investigate whether `expected.pillars` values are correct.

## Notes

- `dark_patterns` pillar is controlled by a feature flag — set `darkPatterns: false` in expected if not testing that pillar, but **still include the key**
- Text can be a short representative snippet — it doesn't need to be a full 50-page policy
- The eval dataset is intentionally small — each case should cover a distinct scenario not already covered
- After adding a case, update the "8 cases" count in CLAUDE.md if it changes
