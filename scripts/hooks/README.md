# ULTRON Hooks

Hooks under this directory are wired into `~/.claude/settings.json` automatically
by the installer. The single source of truth is
[`../../templates/settings-hooks.json`](../../templates/settings-hooks.json);
`install.ps1` / `install.sh` `merge_hooks()` copies that template into the user
settings non-destructively (with backup). The token `{USERPROFILE}` expands to
the user's home (forward-slash form) at install time.

To override or disable a hook for your account, edit `~/.claude/settings.json`
directly — the merge step preserves user-added entries.

---

## Lifecycle hooks (SessionStart / Stop / *Compact)

| File | Event | Purpose | Default | Platform |
|---|---|---|---|---|
| `session-init.ps1` | SessionStart | Drains push-queue, primes decay cache, regenerates `context.md`, injects unacked alerts. | yes | win |
| `session-init.sh` | SessionStart | POSIX sibling of the above. | yes (Linux) | linux |
| `detect_gaps.py` | SessionStart | Surfaces open loops: skill drift, stale plans, quarantined items, un-acked criticals. | yes | both |
| `stop-memory-sync.ps1` | Stop | `brain_index.update` + decay_queue + (HIGH/ULTRA only) vault commit / push / compactor. **Inlines** session-log + session-cleanup behavior since v15.5.17. | yes | win |
| `stop-memory-sync.sh` | Stop | POSIX sibling (same inline). | yes (Linux) | linux |
| `auto-changelog.py` | Stop | On minor/major bump, drain `~/.ultron/.tmp/pending-patches.jsonl` into a sucinct CHANGELOG entry (Spanish format). Patch bumps just append to the buffer. HIGH/ULTRA gated. | yes | both |
| `plan-detector.py` | Stop | Scans the transcript for deferred-work markers and appends to `~/.ultron/plans/_inbox.md`. | yes | both |
| `session-log.py` | Stop | **Deprecated as standalone in v15.5.17** — behavior inlined into `stop-memory-sync.{ps1,sh}` (top, pre-debounce). Kept on disk for manual maintainer use; see `docs/MAINTAINERS.md`. | no (inlined) | both |
| `session-cleanup.{ps1,sh}` | Stop | **Deprecated as standalone in v15.5.17** — behavior inlined into `stop-memory-sync.{ps1,sh}` tail. Kept for manual maintainer use. | no (inlined) | both |
| `pre_compact.py` | PreCompact | Dumps live state (context + plans + routing + alerts) so post-compact survives. | yes | both |
| `post_compact.py` | PostCompact | Logs the compact event + emits a short recovery roadmap. | yes | both |

## Prompt hooks (UserPromptSubmit)

| File | Purpose | Default | Platform |
|---|---|---|---|
| `mode-trigger.py` | Detects `/high` / `/ultra` / `/learn` and registers the session mode (telemetry only, never blocks). | yes | both |
| `intent-dispatcher.py` | 4-step intent pipeline (slash-shortcut → rules → ZTMSI/FTS5 → fallthrough); emits one routing line when confidence ≥ 0.70. | yes | both |
| `auto-recall.py` | First-turn semantic recall via fastembed → Qdrant; injects top-3 vault notes as a system-reminder (`asyncRewake: true`). | yes | both |

## Tool hooks (PreToolUse / PostToolUse)

| File | Event / matcher | Purpose | Default | Platform |
|---|---|---|---|---|
| `auto-approve-readonly.py` | PreToolUse · `Read\|Glob\|Grep\|WebFetch\|WebSearch` | Auto-approves read-only tools; denies path-traversal into `.ssh`/`.aws`/`.env`/`*token*`. v2.0 SEC-02 hardening. | yes | both |
| `block-dangerous-bash.py` | PreToolUse · `Bash` | bashlex AST walker — blocks `rm -rf`, base64-decode, `curl \| sh`, exfil patterns inside `$()` / `<()`. | yes | both |
| `validate_push.py` | PreToolUse · `Bash` | Blocks force-push to protected branches (`main` / `master` / `release/*`). Exit 2 = hard refusal. | yes | both |
| `mcp-resilience.py` | PreToolUse · `mcp__.*` | If the target MCP is degraded/missing in `mcp-health.json`, injects a one-line fallback note (never blocks). | yes | both |
| `skill_integrity_check.py` | PreToolUse · `Skill` | SHA1 of `SKILL.md` vs provenance baseline; warns on drift (set `ULTRON_INTEGRITY=strict` to hard-block). | yes | both |
| `routing-telemetry.py` | PostToolUse · `Skill\|Agent\|Task` | JSONL append per Skill/Agent/Task invocation → `~/.ultron/sessions/YYYY-MM-DD/routing.jsonl`. | yes | both |
| `prompt-feedback-capture.py` | PostToolUse · `Skill` | Captures truncated + PII-filtered Skill outputs → `~/.ultron/.tmp/prompt-feedback.jsonl` (META-PROMPTER corpus). | yes | both |
| `track-knowledge-reads.py` | PostToolUse · `Read` | Tracks reads under `~/.ultron/knowledge/**` so the same file is not re-read in the next turn. | yes | both |

## Qdrant boot helpers (not Claude Code hooks)

`ensure-qdrant.{ps1,sh}` stay in this directory because session-init wires
them as a real Claude SessionStart hook (cold-start safety net). The other
three bootcheck files — `qdrant-notify.ps1`, `qdrant-bootcheck-hidden.vbs`
and `install-qdrant-bootcheck.ps1` — are NOT settings.json hooks; they back
the `ULTRON-QdrantBoot` Windows scheduled task that runs at user logon. As
of v15.5.14 they live under `scripts/qdrant/` so this hooks/ tree is a
pure Claude-hooks surface.

| File | Purpose | Default | Platform |
|---|---|---|---|
| `ensure-qdrant.ps1` | Probes `localhost:6333/healthz`; on KO launches `qdrant-native/qdrant.exe` hidden, waits 60s. | yes (scheduled task) | win |
| `ensure-qdrant.sh` | POSIX sibling for native binary on Linux. | yes (scheduled task) | linux |
| `../qdrant/qdrant-notify.ps1` | WinForm floating panel (bottom-right, persistent) shown when Qdrant is not OK. | yes | win |
| `../qdrant/qdrant-bootcheck-hidden.vbs` | Windowless wrapper around the ensure + notify chain (avoids PowerShell console flash on fullscreen games). | yes | win |
| `../qdrant/install-qdrant-bootcheck.ps1` | Registers / unregisters / queries the `ULTRON-QdrantBoot` scheduled task. | manual setup | win |

---

## Cross-platform compatibility

Every PowerShell hook ships a POSIX sibling so the same behaviour runs on
Linux from v15.5 onward:

| Windows (`.ps1`) | Linux (`.sh`) |
|---|---|
| `session-init.ps1` | `session-init.sh` |
| `session-cleanup.ps1` | `session-cleanup.sh` |
| `stop-memory-sync.ps1` | `stop-memory-sync.sh` |
| `ensure-qdrant.ps1` | `ensure-qdrant.sh` |

`install.ps1` / `install.sh` pick the right family per OS; the Python hooks are
platform-neutral and run unchanged on both.

---

## Override or add a hook

The hook spec lives in `~/.ultron/templates/settings-hooks.json`. After editing
it, re-run `install.ps1` (idempotent) or merge it manually into
`~/.claude/settings.json`. A new hook follows the pattern:

```json
{
  "hooks": {
    "<EventName>": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "{USERPROFILE}/.ultron/.venv/Scripts/python.exe {USERPROFILE}/.ultron/scripts/hooks/<your-hook>.py"
          }
        ]
      }
    ]
  }
}
```

Hook scripts read JSON from stdin and exit 0 unless they intentionally block
(exit 2 = hard refusal, surfaced to the model as stderr).

## Test a hook locally

```bash
echo '{"hook_event_name":"PreToolUse","tool_name":"Read","tool_input":{"file_path":"test.txt"}}' \
  | uv run python ~/.ultron/scripts/hooks/auto-approve-readonly.py
```

Expected (auto-approve):

```json
{"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "allow", "permissionDecisionReason": "Read-only tool 'Read' auto-approved by ULTRON hook"}}
```

---

## References

- [Hooks reference (Claude Code)](https://code.claude.com/docs/en/hooks)
- [Hooks (Agent SDK)](https://code.claude.com/docs/en/agent-sdk/hooks)
- `~/.ultron/knowledge/claude-platform/subagents-and-hooks.md`
