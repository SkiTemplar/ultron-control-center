---
name: everything-claude-code
description: Performance-focused agent harness. Advanced memory optimization and security scanning for large codebases.
kind: meta
tier: L1
category: workflow
last_verified: 2026-05-03
tags: [everything, claude, code]
token_est: 231
layer: L1-skills
---

# Everything Claude Code (ECC)

Performance and security optimization layer for complex engineering tasks.

## Memory Optimization
- **Pruning**: Automatically identifies and ignores non-essential files to keep the context window lean.
- **Checkpointing**: Saves project state frequently to prevent token waste on restarts.

## Security Scanning
- **Live Audit**: Scans generated code for common vulnerabilities (OWASP Top 10) before presenting to the user.
- **Secret Detection**: Hard block on any output containing patterns matching API keys or secrets.

## Engineering Standards
Enforces strict adherence to project-local conventions and architectural patterns found in `GEMINI.md` or `MEMORY.md`.
