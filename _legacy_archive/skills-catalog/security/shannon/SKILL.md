---
name: shannon
description: Autonomous AI Pentester. Performs white-box security testing by combining source code analysis with live exploitation.
kind: skill
tier: L1
category: security
last_verified: 2026-05-03
tags: [shannon]
token_est: 319
layer: L1-skills
---

# Shannon: Autonomous AI Pentester

Shannon is an autonomous AI penetration testing agent that performs white-box security testing. It follows the "No Exploit, No Report" philosophy.

## Capabilities
- **White-box Analysis:** Maps attack surfaces by reading source code.
- **Dynamic Exploitation:** Uses Playwright and CLI tools to execute real attacks.
- **OWASP Coverage:** Injection, XSS, SSRF, Auth Bypass, IDOR.
- **Proof of Concept:** Generates reproducible exploit scripts.

## Workflow
1. **Pre-Recon:** repository structure and entry points mapping.
2. **Recon:** Live app navigation and network capture.
3. **Vulnerability Analysis:** Specialized agents for diff vulnerability classes.
4. **Exploitation:** Live vector testing.
5. **Reporting:** PoC exploits and severity metrics.

## Safety
- NEVER target production without `--force-production`.
- Avoid destructive paths unless scoped.
- Tools run inside Shannon Docker worker.

## Commands
- `/shannon <url> <repo_path>`: Start full pentest.
- `/shannon results`: Display latest PoC findings.
