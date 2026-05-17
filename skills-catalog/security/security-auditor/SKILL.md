---
name: security-auditor
description: Comprehensive security auditor covering OWASP, compliance frameworks (SOC2, GDPR, HIPAA), penetration testing methodology, and code security review. Activate when performing security audits, reviewing code for vulnerabilities, checking compliance, or assessing infrastructure security posture.
kind: skill
tier: L1
category: security
last_verified: 2026-05-03
tags: [security, auditor]
token_est: 1024
layer: L1-skills
---

# Security Auditor Skill

Comprehensive security assessment across application code, infrastructure, and compliance frameworks.

## Compliance Frameworks

SOC 2 Type II, ISO 27001/27002, HIPAA, PCI DSS, GDPR, NIST CSF, CIS Benchmarks.

## Audit Methodology

1. **Planning** — Scope definition, compliance mapping, stakeholder alignment
2. **Implementation** — Testing execution, control review, evidence collection
3. **Analysis** — Finding validation and risk prioritization
4. **Reporting** — Comprehensive documentation with actionable remediation

## Finding Classification

| Severity | Definition | Example |
|---|---|---|
| Critical | Immediate exploitation risk | SQL injection, RCE |
| High | Significant risk, likely exploited | Auth bypass, SSRF |
| Medium | Moderate risk, requires conditions | CSRF, reflected XSS |
| Low | Limited impact | Information disclosure |
| Informational | Best practice | Verbose error messages |

## OWASP Top 10 Checks

```python
# A1: Broken Access Control
# Check: Can user access other users' data?
# Test: Change user_id in API request to another user's ID

# A2: Cryptographic Failures
# Check: Is sensitive data encrypted at rest and in transit?
# Bad: MD5/SHA1 for passwords
# Good: bcrypt/Argon2id with cost factor >= 12

# A3: Injection
# Check: Are all inputs parameterized?
# Bad SQL:
query = f"SELECT * FROM users WHERE email = '{email}'"
# Good SQL (parameterized):
query = "SELECT * FROM users WHERE email = $1"
cursor.execute(query, (email,))

# A7: Authentication Failures
# Check: Brute force protection, MFA, session management
```

## Code Security Patterns

```typescript
// Input validation (never trust user input)
import { z } from 'zod'
const CreateUserSchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(12).max(128),
  age: z.number().int().min(18).max(120),
})

// Secrets management (never in code/env files)
// Good: use secrets manager
const apiKey = await secretsManager.getSecretValue({ SecretId: 'prod/api-key' })

// Auth tokens
// JWT: always verify signature, check expiry, use RS256 not HS256 in prod
// Sessions: use secure, httpOnly, sameSite=strict cookies

// Rate limiting
import rateLimit from 'express-rate-limit'
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 minutes
  max: 100,
  standardHeaders: true,
})
```

## Infrastructure Security

```yaml
# Kubernetes security context
securityContext:
  runAsNonRoot: true
  runAsUser: 1000
  readOnlyRootFilesystem: true
  allowPrivilegeEscalation: false
  capabilities:
    drop: ["ALL"]

# Network policy — default deny
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny
spec:
  podSelector: {}
  policyTypes:
    - Ingress
    - Egress
```

## Security Headers (HTTP)

```nginx
# Nginx security headers
add_header Strict-Transport-Security "max-age=31536000; includeSubDomains; preload" always;
add_header X-Frame-Options "DENY" always;
add_header X-Content-Type-Options "nosniff" always;
add_header Referrer-Policy "strict-origin-when-cross-origin" always;
add_header Content-Security-Policy "default-src 'self'; script-src 'self' 'unsafe-inline'" always;
add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;
```

## Dependency Security

```bash
# Check for known vulnerabilities
npm audit --audit-level=high
pip-audit
trivy fs --security-checks vuln .

# Pin exact versions in production
# Use lock files (package-lock.json, poetry.lock)
# Enable Dependabot/Renovate for automated updates
```

## Source

Adapted from [VoltAgent/awesome-claude-code-subagents security-auditor](https://github.com/VoltAgent/awesome-claude-code-subagents) (MIT).
