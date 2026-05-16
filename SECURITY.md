<div align="center">

<h1>Security Policy</h1>

<p>
  ULTRON is a local-first system that wraps Claude Code and runs untrusted user-authored
  skills, hooks and MCP servers. The attack surface is real even though the binary never
  opens a public port.
</p>

<p>
  <a href="README.md">README</a>
  &middot;
  <a href="CONTRIBUTING.md">Contributing</a>
  &middot;
  <a href="LICENSE">License</a>
</p>

</div>

---

## Reporting a vulnerability

> [!IMPORTANT]
> Please do **not** open a public GitHub issue for security problems.

Email: **anonuser [at] gmail.com**

Use a subject line that starts with `[ULTRON SECURITY]` and include:

- A short description of the issue.
- Reproduction steps or a minimal PoC.
- Affected version (`ultron --version` or the `CHANGELOG.md` entry).
- Your assessment of impact and severity.
- Whether you intend to disclose publicly, and on what timeline.

I aim to acknowledge new reports within **72 hours**. For valid issues, a fix or mitigation will land on `main` before any public disclosure, and the report will be credited in the changelog unless you ask otherwise.

---

## In scope

The following are considered security issues for this project.

| Category | Detail |
|---|---|
| **Prompt injection** | Skill manifest (`~/.claude/skills/*/SKILL.md`), agent manifest (`~/.claude/agents/*.md`), persona description or hook payload that bypasses the PI001-PI013 ruleset. The scanner covers both skills and agents through the same decision ladder and the same Allow-anyway waiver flow (per-SHA1 entries in `~/.ultron/config/skill-trust.yaml`); editing a manifest invalidates its waiver by design. |
| **Hook injection** | Untrusted file under `~/.claude/` or `~/.ultron/` that escalates into arbitrary command execution outside the documented hook contract. |
| **Secrets leakage** | `~/.claude/settings.json`, `~/.ultron/.env` or per-skill config files leaking into log output, telemetry, alerts or the news generator. |
| **Command injection** | Any cockpit Python script that shells out to PowerShell, `git`, `claude`, `codex` or `gemini`. |
| **Path traversal** | `brain_index.py`, `embed_vault.py`, `skill_sync_security.py` or any installer step that touches user files. |
| **Insecure defaults** | Bundled `settings.json` template or the install script. |
| **Tauri IPC misuse** | React frontend invoking commands not declared in `src-tauri/`'s allow-list. |

---

## Out of scope

These are user-owned risks, not project vulnerabilities.

| Item | Owner |
|---|---|
| User installs a malicious skill or agent from a third party | User (ULTRON warns on unsigned skills and agents via the PI ruleset; final trust call is the user's) |
| User shares their own `~/.ultron-vault/` contents publicly | User (vaults are personal data by design) |
| User commits secrets to a fork | User (the repo gitignores the obvious paths; verifying your own history is your responsibility) |
| User runs with `--dangerously-skip-permissions` | User (the flag is exactly what it says it is) |
| Issues in upstream tools (Claude Code, Codex CLI, Gemini CLI, Qdrant, Tauri) | Upstream project |

---

## Hardening references

| Component | Where to look |
|---|---|
| **Prompt-injection ruleset** | `scripts/cockpit/skill_sync_security.py` enforces rules PI001 through PI013 on every skill (`~/.claude/skills/*/SKILL.md`) and every agent (`~/.claude/agents/*.md`) during sync. A manifest flagged `security_status: warned` only routes with explicit user confirmation; a manifest that fails outright is quarantined under `~/.ultron/quarantine/`. Waivers (Allow-anyway) are SHA1-pinned in `~/.ultron/config/skill-trust.yaml` and invalidate when the file changes. |
| **Constitution** | `~/.ultron/config/constitution.json` declares per-persona safety gates that the dispatcher checks before invocation. |
| **Hook allow-list** | The install script merges a known set of hooks into `settings.json`. Any additional handlers a user adds are their responsibility. |

---

## Disclosure

Once a fix is shipped, a CVE-style summary will be added to the relevant changelog entry. The reporter is credited unless they request anonymity.

<div align="center">
<sub>Thanks for keeping ULTRON safe to run on real machines.</sub>
</div>
