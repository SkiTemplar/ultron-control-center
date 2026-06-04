---
name: antivibe
description: "Anti-Vibe-Coding protocol. Learn what AI writes, don't just accept it. Use for architectural deep dives and decision logging."
kind: skill
tier: L1
category: workflow
last_verified: 2026-05-03
tags: [antivibe]
token_est: 245
layer: L1-skills
---

# Antivibe: Educational Deep-Dive Protocol

Forces a "Research -> Understand -> Verify" workflow to combat blind acceptance of AI code.

## Core Directives
1. **Explain the 'Why':** Every significant code change must include an explanation of trade-offs.
2. **Decision Logging:** Maintain `antivibe-phase.log` to track thinking phases and identified bottlenecks.
3. **Verify Assumptions:** Run static analysis or pattern matching to ensure no "hallucinated" dependencies.

## Usage
Activate when:
- Performing large refactors.
- Documenting Architectural Decision Records (ADRs).
- Requesting a second opinion on performance or security implications.

## Logging Format
```markdown
## [PHASE] Research
- Assumption: X
- Verification: Y
- Result: Z
```
