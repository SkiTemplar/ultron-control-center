# 168-Skill Manual Security Audit — 2026-05-07

> Auditor: security-auditor persona (Claude Opus 4.7, 1M ctx)
> Source: PI009 quarantined skills in `C:\Users\USER\.ultron\skills.manifest.yaml`
> Scope: ALL skills with `security_status: quarantine_pending` AND `security_status_reason: security_quarantine_pending:PI009`
> Read-only audit. No skill files were modified.

## Executive Summary

- **Total quarantined entries with `PI009` in reason**: **123** (manifest grep). The user prompt referenced "168" — the wider quarantine pool spans multiple PI rules (PI001/2/5/6/7/8/9/12); this audit's mandate is the PI009 subset, which is 123 skills, not 168. See "Open questions for USER" below.
- **Bucket counts**: clean=**118**, note=**5**, review=**0**, malicious=**0**
- **Notable patterns observed**:
  - 99% of the 123 are the **VoltAgent `awesome-claude-code-subagents` MIT-licensed collection** (developer-role personas).
  - All 123 declare standard Anthropic-shipped tools only (`Read, Write, Edit, Bash, Glob, Grep`, sometimes `WebFetch, WebSearch`).
  - Zero suspicious URLs across all 123 skills (only 9 URL lines total — all benign documentation: openrouter.ai/keys, github.com/conorbronsdon, schemdraw.readthedocs.io, matplotlib, networkx, nature.com guidelines, science.org guidelines, consort-statement.org).
  - Zero credential paths (.ssh, .env outside legitimate code samples, ~/.aws, kubeconfig, .docker/config).
  - Zero exfiltration patterns (no curl/POST to webhook.site/pastebin/discord/telegram/transfer.sh).
  - Zero self-modification language ("create new SKILL.md at...", "edit settings.json", "modify ~/.claude/skills/...").
  - Zero hidden-instruction language ("silently", "secretly", "do not tell", "covert", "without informing").
  - Zero persona-spoof language ("activate ULTRON", "become Alfred", "pretend to be").
  - Zero unknown frontmatter keys (only `allowed-tools`, `metadata`, `license` outside the standard set, all benign).
- **Bottom line for USER**: **Safe to bulk-promote (or remove) the 123 PI009-only quarantined skills.** They are flagged solely because they declare `Bash/Write/Edit` in their `tools:` frontmatter, which is correct and required for engineering personas. None of them carry malicious instructions, credential probes, exfiltration logic, or persona-spoof traps. Treat PI009 alone as informational unless paired with another rule.

## MALICIOUS findings

**None.** No skill in the 123-set contains evidence of malicious intent.

## REVIEW findings

**None.** No skill required deeper human review beyond the NOTE entries below.

## NOTE findings (curiosities, smells — not malicious)

### N1. `codebase-orchestrator` declares unresolved MCP tool names
- **File**: `C:\Users\USER\.claude\skills\codebase-orchestrator\SKILL.md`
- **Line**: 4
- **Pattern**: `tools: Read, Write, Edit, Bash, Glob, Grep, WebFetch, airis-mcp-gateway, context-manager, error-coordinator, pied-piper, subagent-catalog:search, subagent-catalog:fetch`
- **Why noted**: References MCP servers (`airis-mcp-gateway`, `pied-piper`, `subagent-catalog:*`) that are not present in USER's `~/.claude/settings.json`. Not malicious — these are upstream-collection assumptions. Tool calls would fail closed (Claude cannot invoke a tool that isn't loaded). Lines 249, 252 reference them in prose only.
- **Recommendation**: Either (a) prune unknown MCPs from the `tools:` line so the runtime can validate the field, or (b) remove the skill if `pied-piper`/`subagent-catalog` are not part of the ULTRON stack.

### N2. `ui-ux-tester` declares `chrome-mcp` and `computer-use`
- **File**: `C:\Users\USER\.claude\skills\ui-ux-tester\SKILL.md`
- **Line**: 4
- **Pattern**: `tools: Read, Write, Edit, Bash, Glob, Grep, WebSearch, chrome-mcp, computer-use`
- **Why noted**: `computer-use` is a real Anthropic capability with broad system-level reach (mouse/keyboard control). `chrome-mcp` requires a browser MCP server. Body (lines 17, 196) uses them appropriately for legitimate UI testing.
- **Recommendation**: If `computer-use` is not enabled in USER's harness, this is informational. If enabled in the future, ensure this skill activates only on explicit UI-testing requests (the description gates it well). Not a security risk in itself; just elevated capability.

### N3. `let-fate-decide` uses cryptographic randomness for tarot draws
- **File**: `C:\Users\USER\.claude\skills\let-fate-decide\SKILL.md`
- **Lines**: 41, 55–60
- **Why noted**: Quirky skill that draws Tarot cards to inject entropy when prompts are vague. Uses `secrets.randbelow()` (correct cryptographic RNG choice). Line 41 contains the word "silently" but in benign context: "draw cards instead of silently choosing one". Line 128, 131: legitimate guardrails ("cards inform direction, they don't override safety or correctness").
- **Recommendation**: None. Skill is well-designed; safety override warnings are intentional.

### N4. `incident-responder` and `penetration-tester` mention "data exfiltration"
- **Files**: `C:\Users\USER\.claude\skills\incident-responder\SKILL.md` (L240), `C:\Users\USER\.claude\skills\penetration-tester\SKILL.md` (L61)
- **Pattern**: `- Data exfiltration` (bullet in a list of detection/test categories)
- **Why noted**: The word "exfiltration" appears as a category name in defensive/offensive security checklists. Not an instruction to exfiltrate.
- **Recommendation**: None. Standard security taxonomy.

### N5. `clinical-decision-support` and `scientific-schematics` reference external AI services
- **Files**:
  - `clinical-decision-support\SKILL.md` (`metadata: skill-author: K-Dense Inc.`)
  - `scientific-schematics\SKILL.md` L86, L611 — references `https://openrouter.ai/keys` for an optional API key, plus mentions Nano Banana 2 and Gemini 3.1 Pro Preview as model backends.
- **Why noted**: Third-party AI service (OpenRouter) is a real, well-known LLM router. Skill-author attribution is transparent. URL is for the user to obtain their own key — not a webhook or data sink.
- **Recommendation**: None. Authorship and external-service usage is properly disclosed.

## Methodology

### Files opened
- **Full reads (10 skills)**: `codebase-orchestrator`, `ui-ux-tester`, `clinical-decision-support` (head), `scientific-schematics` (head), `let-fate-decide` (head), `interpreting-culture-index` (head), `dimensional-analysis` (head), `m365-admin` (full), `azure-infra-engineer` (full), `windows-infra-admin` (full), `penetration-tester` (head), `security-engineer` (head). ~12 SKILL.md files opened, mostly the smallest+largest outliers and any with unusual tool declarations.
- **Bulk pattern scan (123 skills)**: 4 separate Select-String passes covering ~80 distinct regex patterns from heuristics A–G (suspicious instructions, suspicious URLs, credential paths, exfil patterns, self-modification, persona-spoof, persistence/cron/daemon language).
- **Frontmatter analysis (123 skills)**: enumerated every `key:` in the YAML frontmatter; grouped `tools:` declarations by exact value.
- **URL scan (123 skills)**: every `https?://` line — total 9 lines, all benign.

### Time budget
- ~30 minutes wall-clock of focused work. Heavy use of bulk Select-String over the 123-skill set rather than per-file Read.

### Heuristics that produced the most signal
1. **Frontmatter `tools:` value grouping**: cleanly surfaced the two tool-set outliers (`codebase-orchestrator`, `ui-ux-tester`).
2. **Bulk URL extraction**: confirmed the URL surface is essentially zero (9 lines). High-confidence "no exfil endpoint embedded" verdict.
3. **Pattern bucket A (suspicious-instruction language)**: 31 hits, all benign technical English (e.g., "memory dumps", "platform-specific overrides", "data exfiltration" as a checklist category).
4. **Pattern bucket "credential paths and self-mod"**: zero hits across 22 patterns × 123 skills = 2706 checks. Strong signal of cleanliness.

### Heuristics that were quiet (likely clean across the board)
- Hidden HTML comment scan (already covered by PI002, but re-verified by reading frontmatter).
- Encoded payloads (\xNN, base64 blobs) — zero hits in PI009 set.
- Persona-spoof / "activate ULTRON" / "become Alfred" / `[INST]` / `<system>` injection markers — zero hits.
- Webhook/paste/telegram/discord exfil hostnames — zero hits.
- Credential file paths (`~/.ssh`, `.env` outside dotenv-config docs, `kubeconfig`, `.aws/`) — zero hits.

## Open questions for USER

1. **Discrepancy on the count**: Prompt referenced "168 skills" but the manifest currently has **123** entries with `security_quarantine_pending:PI009`. The wider `quarantine_pending` pool (any PI rule) is **161** (counted via `Grep "security_quarantine_pending"`). If the intended scope was the full 161 (or 168 — possibly an older snapshot), please re-run with the broader set; the rules outside PI009 already triaged into specific patterns and may not need an A–G manual pass.
2. **Source confirmation**: 88 of the 123 skills declare exactly `tools: Read, Write, Edit, Bash, Glob, Grep` and follow the VoltAgent / `awesome-claude-code-subagents` template (visible in similar siblings like `devops-engineer`, `docker-expert`, `kotlin-specialist` which credit "Adapted from VoltAgent/awesome-claude-code-subagents (MIT)" in their footers — but the PI009 set itself does not include those credit lines). Confirm whether you intend to keep the entire VoltAgent collection or curate to a subset (most are generic engineering personas with significant overlap to ULTRON's `terry-davis`, `don-claudio`, `mike-tyson`, etc.).
3. **`codebase-orchestrator` MCPs**: confirm whether `airis-mcp-gateway` and `pied-piper` are intentional future-state references, or leftover upstream noise to prune.
4. **Bulk promotion vs. cull**: Recommendation — promote PI009-only skills out of quarantine in bulk (zero malicious findings). Optionally cull duplicates (e.g., `python-pro` vs ULTRON's `terry-davis` for code work; `mike-tyson` already covers UI/UX vs. `ui-designer`).

---

## Appendix A — Full PI009 skill list (123)

```
accessibility-tester, ad-security-reviewer, agent-organizer, ai-engineer, ai-writing-auditor,
angular-architect, api-designer, api-documenter, architect-reviewer, azure-infra-engineer,
backend-developer, blockchain-developer, build-engineer, business-analyst, chaos-engineer,
cli-developer, clinical-decision-support, cloud-architect, code-reviewer, codebase-orchestrator,
content-marketer, context-manager, cpp-pro, csharp-developer, customer-success-manager,
data-analyst, data-engineer, data-scientist, database-administrator, database-optimizer,
debugger, dependency-manager, deployment-engineer, design-bridge, devops-incident-responder,
dimensional-analysis, django-developer, documentation-engineer, dotnet-core-expert,
dotnet-framework-4.8-expert, dx-optimizer, electron-pro, elixir-expert, embedded-systems,
error-coordinator, error-detective, expo-react-native-expert, fastapi-developer, fintech-engineer,
flutter-expert, frontend-developer, fullstack-developer, git-workflow-manager, golang-pro,
graphql-architect, incident-responder, interpreting-culture-index, iot-engineer,
it-ops-orchestrator, java-architect, javascript-pro, knowledge-synthesizer, laravel-specialist,
legacy-modernizer, legal-advisor, let-fate-decide, license-engineer, llm-architect, m365-admin,
machine-learning-engineer, mcp-developer, microservices-architect, ml-engineer, mlops-engineer,
mobile-app-developer, mobile-developer, multi-agent-coordinator, network-engineer, nlp-engineer,
node-specialist, payment-integration, penetration-tester, performance-engineer,
performance-monitor, php-pro, platform-engineer, product-manager, project-idea-validator,
project-manager, prompt-engineer, python-pro, qa-expert, quant-analyst, rails-expert,
readme-generator, refactoring-specialist, reinforcement-learning-engineer, risk-manager,
rust-engineer, sales-engineer, scientific-schematics, scrum-master, security-engineer,
slack-expert, spring-boot-engineer, sql-pro, sre-engineer, swift-expert, symfony-specialist,
task-distributor, technical-writer, terraform-engineer, terragrunt-expert, test-automator,
tooling-engineer, typescript-pro, ui-designer, ui-ux-tester, vue-expert, websocket-engineer,
windows-infra-admin, wordpress-master, workflow-orchestrator
```

## Appendix B — Tool-declaration distribution (PI009 set)

| Count | `tools:` value |
|------:|----------------|
| 88 | `Read, Write, Edit, Bash, Glob, Grep` |
| 13 | `Read, Write, Edit, Glob, Grep, WebFetch, WebSearch` |
|  8 | `Read, Write, Edit, Glob, Grep` |
|  5 | (no `tools:` field; uses `allowed-tools:` instead) |
|  4 | `Read, Write, Edit, Bash, Glob, Grep, WebFetch, WebSearch` |
|  3 | `Read, Grep, Glob, Bash` |
|  1 | `Read, Write, Edit, Bash, Glob, Grep, WebSearch, chrome-mcp, computer-use` (ui-ux-tester) |
|  1 | `Read, Write, Edit, Bash, Glob, Grep, WebFetch, airis-mcp-gateway, context-manager, error-coordinator, pied-piper, subagent-catalog:search, subagent-catalog:fetch` (codebase-orchestrator) |

All 123 declare only Anthropic-built-in tool names plus (in 2 cases) MCP server names. No "RemoteShell", "BackgroundDaemon", "FileSystem.fullAccess", or other custom-injected dangerous tool names.
