# Security Policy

ULTRON is a local-first system that wraps Claude Code and runs untrusted user-authored skills, hooks, and MCP servers. The attack surface is real even though the binary never opens a public port.

## Reporting a vulnerability

Please do **not** open a public GitHub issue for security problems. Email:

> **anonuser [at] gmail.com**

Use a subject line that starts with `[ULTRON SECURITY]`. Include:

- A short description of the issue.
- Reproduction steps or a minimal PoC.
- Affected version (`ultron --version` or the `CHANGELOG.md` entry).
- Your assessment of impact and severity.
- Whether you intend to disclose publicly, and on what timeline.

I aim to acknowledge new reports within 72 hours. For valid issues, a fix or mitigation will land on `main` before any public disclosure, and the report will be credited in the changelog unless you ask otherwise.

## In scope

The following are considered security issues for this project:

- **Prompt injection** through a skill manifest, persona description, or hook payload that bypasses the PI001-PI013 ruleset enforced by `skill_sync_security.py`.
- **Hook injection** that allows an untrusted file under `~/.claude/` or `~/.ultron/` to escalate into arbitrary command execution outside the documented hook contract.
- **Secrets leakage** from `~/.claude/settings.json`, `~/.ultron/.env`, or per-skill config files into log output, telemetry files, alerts, or the news generator.
- **Command-injection** in any cockpit Python script that shells out to PowerShell, `git`, `claude`, `codex`, or `gemini`.
- **Path traversal** in `brain_index.py`, `embed_vault.py`, `skill_sync_security.py`, or any installer step that touches user files.
- **Insecure defaults** in the bundled `settings.json` template or the install script.
- **Tauri IPC misuse** that lets the React frontend invoke commands not declared in `src-tauri/`'s allow-list.

## Out of scope

These are user-owned risks, not project vulnerabilities:

- A user installing a malicious skill from a third party. ULTRON warns on unsigned skills via the PI ruleset; the final trust call is the user's.
- A user sharing their own `~/.ultron-vault/` or `~/.ultron-vault/CC-memories/` contents publicly. Vaults are personal data by design.
- A user committing secrets to a fork. The repo gitignores the obvious paths; verifying your own commit history is your responsibility.
- A user running with `--dangerously-skip-permissions`. That flag is exactly what it says it is.
- Issues in upstream tools (Claude Code, Codex CLI, Gemini CLI, Qdrant, Tauri). Report those to the respective projects.

## Hardening references

- **Prompt-injection ruleset:** `scripts/cockpit/skill_sync_security.py` enforces rules PI001 through PI013 on every persona during sync. A skill that flags `security_status: warned` will route only with explicit user confirmation; a skill that fails outright is quarantined under `~/.ultron/quarantine/`.
- **Constitution:** `~/.ultron/config/constitution.json` declares per-persona safety gates that the dispatcher checks before invocation.
- **Hook allow-list:** the install script merges a known set of hooks into `settings.json`. Any additional handlers a user adds are their responsibility.

## Disclosure

Once a fix is shipped, a CVE-style summary will be added to the relevant changelog entry. The reporter is credited unless they request anonymity.
