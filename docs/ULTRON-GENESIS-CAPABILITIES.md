# ULTRON Genesis — Capabilities Catalog

**Version:** v14.1.1 (audited 2026-05-08) · **Type:** functional reference (not changelog)

What ULTRON is and does, organized by domain. Every capability listed has a
verified script path or a defined protocol — nothing aspirational. Drift
audit on 2026-05-08 reconciled counts and added v14.1+ systems (deadwood
scanner, sentinel marker, Usage configurable reset, bulk waivers,
github-pat MCP). Backup of pre-audit version at
`~/.ultron/backups/ULTRON-GENESIS-CAPABILITIES.pre-audit-2026-05-08.md`.

---

## 1. What ULTRON is

ULTRON is a personal cognitive harness built on top of Claude Code. It runs in
the user's terminal, persists across sessions via a 3-layer memory, and treats
Claude (Opus 4.7) as the orchestrator. Two specialist peers — Codex CLI
(`gpt-5.5`, sandbox read-only) and Gemini MCP (long-context, image gen) — are
called when the task fits their strengths.

**Three pillars:**

1. **Memory** — what ULTRON knows about the user, the work, and the past.
2. **Routing** — which skill, persona, or peer to engage for a given prompt.
3. **Hardening** — what stops untrusted skills, MCPs, or payloads from
   compromising the system.

---

## 2. Power modes

Five modes shape token budget, exploration depth, and which protocols ULTRON
allows during a session.

| Mode | When | Effect |
|---|---|---|
| `LOW` | Trivial / one-off | Minimal context · Dual/Triple forbidden |
| `MEDIUM` | Default | Read only what's needed · MiniDual allowed |
| `HIGH` | Feature work · refactor · technical decision | Explore 1–2 levels · Dual allowed |
| `ULTRA` | Architecture · prod code · multi-model deliberation | Full exploration · MaxDual + Triple allowed |
| `LEARN` | Knowledge ingestion | Vault sync + session compactor force-on at Stop |

Mode is registered automatically on prompt — `mode-trigger.py` (UserPromptSubmit
hook) detects `/high`, `/ultra`, `/learn`, the natural-language phrase
"guarda en memoria", and several explicit slash commands. It calls
`memory_sync.py mode <MODE>` before the prompt reaches Claude.

**Overlays** stack on a base mode: `/thinking` · `/contrast` (3 alternatives)
· `/contrast --blank` (no opinion seed) · `/contrast --dual` (with peer) ·
`/learn` (force LEARN at Stop only).

---

## 3. Three-layer memory

| Layer | Where | What | Rebuild |
|---|---|---|---|
| **L0 hot context** | `~/.ultron/.tmp/context.md` | Pre-computed session primer (≤400 tok) — last sessions, stale notes, blocking alerts | Auto on SessionStart hook · `context_primer.py generate` |
| **L1 indexed memory** | `~/.ultron/brain_index/index.db` (SQLite + FTS5) | Chunked notes from L2 with token estimates, BM25 retrieval | `brain_index.py update` (incremental, async) · `build` (full) |
| **L2 cold vault** | `~/.ultron-vault/*.md` (538 notes) + `CC-memories/` bridge to `~/.claude/projects/*/memory/` | Source-of-truth markdown notes, wikilink graph | `memory_sync.py` (vault git push/pull, mode register) |
| **L3 remote** | `https://github.com/SkiTemplar/ultron-memory.git` | Off-machine backup of L2 | `memory_sync.py push` (queued, drained at SessionStart) |

**Token budgeting** (`token_budget.py`): hard cap of 1500 tok always-on overhead
(L0 + global CLAUDE.md + global MEMORY.md). Verified by
`doctor --token-audit`. Truncation respects priority prefixes when a
generator overruns its layer budget.

**Decay** (`decay_queue.py`): every note carries a staleness score. Top-3 stale
notes surface in L0 each SessionStart so context.md flags them.

---

## 4. Brain Index (ZTMSI)

`brain_index.py` — FTS5 SQLite index, currently 665 notes / ~1.4M tokens
(verified 2026-05-08).

**Query modes:**

```bash
uv run python brain_index.py query "<topic>"                   # note-level
uv run python brain_index.py query "<topic>" --mode chunks --top K   # paragraph-level (S2-A)
```

`--mode chunks` returns paragraph-rank results sorted by BM25 against the
chunk text, with token estimates so the caller can budget. Median latency on
the live DB: ~4 ms.

**Schema:** `notes`, `notes_fts` (FTS5), `chunks_fts` (FTS5
contentless virtual; chunks live inside the FTS table — no separate
`chunks` content table), `links`, `meta`, `decay_state`. 5 layer tags:
`L2-vault`, `L1-projects`, `L1-sessions`, `L1-skills`, `L1-skills-ref`.
Tokenizer `unicode61 remove_diacritics 2` (Spanish-correct).

**Frontmatter backfill** (`frontmatter_backfill.py`): notes without
`tags`/`token_est`/`layer` get them filled idempotently. Vocabulary alignment
with `_extract_domain` (e.g. `L1-skills`).

**Migration safety:** `ALTER TABLE … ADD COLUMN` pattern proven idempotent.
WAL + read-only secondary connection so writes never block concurrent queries.

---

## 5. Hooks

All hooks installed in `~/.claude/settings.json`:

| Event | Hook | Purpose |
|---|---|---|
| `SessionStart` | `~/.ultron/hooks/session-init.ps1` | Load mode cache, prime L0, drain push queue, fire MCP health-check async, fire brain index update if >4h stale |
| `UserPromptSubmit` | `mode-trigger.py` | Detect `/high` `/ultra` `/learn` etc., register mode |
| `UserPromptSubmit` | `intent-dispatcher.py` | Route prompt → recommended skill / mode / tool · 40ms hard budget · pre-compiled rules · validated stdin |
| `PreToolUse (Read\|Glob\|Grep\|WebFetch\|WebSearch)` | `auto-approve-readonly.py` | Whitelist read-only tools so user is not prompted |
| `PreToolUse (Bash)` | `block-dangerous-bash.py` | Reject destructive bash patterns |
| `PreToolUse (mcp__.*)` | `mcp-resilience.py` | Inject fallback note when MCP is degraded |
| `PreToolUse (Skill)` | `skill_integrity_check.py` | Verify skill provenance + sha1 before activation (added post-Genesis) |
| `PostToolUse (Skill\|Agent)` | `routing-telemetry.py` | Log skill/agent invocation outcome for `route_quality.py` |
| `PostToolUse (Read)` | `track-knowledge-reads.py` | Refresh decay timestamps on knowledge files |
| `Stop (1)` | `session-log.py` | Append session log line (always-on) |
| `Stop (2)` | `~/.ultron/hooks/stop-memory-sync.ps1` | Vault sync (HIGH+) · brain index update · session compactor · weekly auto-doctor (opt-in) |
| `Stop (3)` | `~/.ultron/hooks/session-cleanup.ps1` | Transcript prune + tmp sweep (added post-Genesis) |

Total: **12 hooks** wired in `~/.claude/settings.json` (1 SessionStart +
4 PreToolUse + 2 PostToolUse + 3 Stop + 2 UserPromptSubmit). Verified
2026-05-08.

**Hook input contract:** every hook either reads stdin via the bounded +
validated helper `hook_input_validator.safe_load_stdin(event)`, or applies
its own bounded reader. 4 MiB hard cap. Schema validation per event. Fail
silently to the alerts bus; never block the user flow.

---

## 6. Intent dispatcher

`hooks/intent-dispatcher.py` — runs on every UserPromptSubmit with a 40 ms
hard budget. Outputs (when relevant) a single routing line:

```
[ULTRON·DISPATCH] skill=repo-evaluator | mode=HIGH | tool=Read
```

**Internals:**
- Read-only SQLite handle to the brain index, `mode=ro&immutable=1`, progress
  handler aborts if remaining budget <2 ms.
- Pre-compiled regex cache (`_get_rules`).
- Bounded stdin via `_read_stdin_bounded()` (1 MB cap on the dispatcher path).
- Per-call budget closure (`_make_budget()`) — no module-level state.
- Telemetry written to `~/.ultron/telemetry/dispatcher-events.jsonl` after
  stdout flush, only if remaining budget >2 ms.
- Adversarial prompts (8 canonical) verified to never traceback-leak.

**Internal p95 latency:** 0.58 ms (52× margin under target).
**Slash-command short-circuit p95:** 0.001 ms.
**E2E subprocess p95:** 79 ms (OS-bound, accepted per ADR-007).

---

## 7. Skills

**SSOT:** `~/.ultron/skills.manifest.yaml` (392 entries as of 2026-05-08:
22 wellknown personas/scripts + 370 auto-discovered + 13 plugin-namespaced
re-added on each auto-discover). Schema validated via
`~/.ultron/config/skills-manifest-schema.json` (JSON Schema 2020-12).
Filesystem total = 552 (root=379 + plugin=138 + bundle=35); the manifest
covers root only.

**Cache:** `~/.ultron/manifest.cache.json` — consumed by intent-dispatcher for
fast lookup. Excludes `deprecated:true` and `security_status:quarantine_pending`
entries.

**Catalog state (post v14.1.1 bulk-waive):** 0 quarantine, 0 block,
166 warned (trust-downgraded), 226 allow. Bulk-waivers in
`~/.ultron/config/skill-trust.yaml` (~50 entries) cover false-positive
PI007/PI008/PI009/PI012 patterns from `awesome-claude-code-subagents`
and `claude-code-plugins` sources.

**CLI** (`skill_manifest.py`):

```bash
ultron manifest list [--deprecated] [--source X] [--format table|json]
ultron manifest sync                  # auto-discover + rebuild yaml + cache
ultron manifest validate              # JSON Schema + drift report
ultron manifest add <name> --source X [--triggers a,b] [--tags x,y]
ultron manifest deprecate <name>
```

**Auto-discover** (`registry_sync.py auto-discover`): scans
`~/.claude/skills/*/SKILL.md` (and codex/gemini equivalents), reads
frontmatter, generates triggers from name tokens, infers cost tier from
`category` / `kind` / `tier` fields, **runs the security scanner before
admitting the skill** (see §12), records provenance with `source_url=None`
and `declared_source=<frontmatter source>` (untrusted by construction).

---

## 8. Dual / MaxDual peer review (Codex)

Codex CLI is the orchestrator's peer critic. Three sub-modes graded by token
intensity:

| Sub-mode | Default rounds | Allowed in mode |
|---|---|---|
| `/minidual` | 1 (CRITIQUE only) | MEDIUM trigger / HIGH / ULTRA |
| `/dual` | 3 (`--rounds=N`, 1–5) | HIGH trigger / ULTRA |
| `/maxdual` | 5 (`--rounds=N`, 3–8) | ULTRA always · HIGH only with explicit trigger |

**Hard rules:**
- `LOW` mode forbids Dual completely.
- Codex always invoked with `--sandbox read-only` and `--ignore-user-config`.
- If Codex suggests a code change, Claude (not Codex) writes it.
- Soft caps: MiniDual unlimited · Dual 3/day · MaxDual 1/day · Triple 3/day ·
  MaxTriple 10/day. Caps emit a warning, never block.

**Backend:** `~/.claude/skills/ultron/scripts/shared-duet.ps1`. Resume via
`-SessionIds '{"codex":"<id>"}'`. Async mode (S2-C MMFP) writes the request
to `~/.ultron/multimodel/requests/<id>.yaml` for delayed peer execution.

**Auth-dependent models:**
- ChatGPT subscription: only `gpt-5.5`. Default fallback disabled.
- API key (`OPENAI_API_KEY`): full `gpt-5.5*` family + `gpt-5.4-codex` fallback.

**Triple Mode** adds Gemini in parallel (Codex + Gemini Pro + optionally
Flash via MMFP). Used for `/triple` and `/maxtriple`.

---

## 9. Gemini MCP — long-context specialist

Gemini MCP delegation is recommended when:

| Task | Threshold |
|---|---|
| Whole-codebase or repo analysis | >150 files |
| Single context exceeds Claude's window | >80K tokens |
| Image / video generation (Veo) | any image |
| Embeddings / vector search | any |
| Massive documentation review | >50 docs |

Models: `gemini-2.5-pro` (deep analysis) · `gemini-2.5-flash` (fast iter).
API key resolution from `~/.claude/settings.json > mcpServers > gemini > env >
GEMINI_API_KEY` (or `${GEMINI_API_KEY}` placeholder; the MCP health probe
expands placeholders before testing).

**Distinction:**
- Iterative peer critique during a flow → Dual Mode (Codex)
- One-shot review of a finished diff → `second-opinion` skill (Codex or Gemini)
- Wide-context analysis (>150 files / >80K tok) → Gemini MCP
- Image generation → Gemini MCP (Veo)

---

## 10. Cockpit (`ultron.ps1`)

Single PowerShell entry point dispatching to ~80+ cockpit scripts
(86 `.py` files in `scripts/cockpit/` + 73 switch cases in
`ultron.ps1`, verified 2026-05-08). Subcommands sampled below;
`ultron help` lists the full set.

```
ultron status                        # dashboard: projects, vault, telemetry, alerts
ultron open <project>                # IDE launcher with .claude/context.md
ultron projects [--list|--search q]  # registry browser
ultron scan [--verbose|--dry-run]    # filesystem rescan
ultron mcp <list|catalog|install|uninstall|validate|health>
ultron alerts <list|ack>             # alerts bus CLI
ultron manifest <list|sync|validate|add|deprecate>
ultron sync                          # full skills registry + manifest sync chain
ultron security <scan|provenance|settings-snapshot|allowlist>
ultron doctor [--fix|--dry-run|--json|--health-check|--token-audit|--quiet|--security|--yes]
ultron dashboard [--print]           # DASHBOARD.md
ultron standup [--print|--gemini]    # daily standup
ultron news [new|create]             # news digest
ultron retention [--dry-run]         # rotation policy
ultron schedule <install|status|uninstall>   # Windows Task Scheduler
ultron desktop [install|uninstall]   # Desktop shortcut
ultron track [snapshot|summary]      # activity tracker
ultron app <name>                    # GUI app launcher
ultron ask <q>                       # quick-ask via Haiku + mini-memory
```

The PS1 wrapper handles uv-vs-python detection and a typed `[string[]]`
arg-passing wrapper that survives PS5.1's array-unwrap quirks.

---

## 11. Telemetry & Alerts

**Telemetry** (`telemetry.py` + `route_quality.py` + `usage_report.py`):
outcome-aware skill events captured per invocation, aggregated for ranking.

**Alerts bus** (`alerts.py`): append-only `~/.ultron/alerts.jsonl`. Severity
ladder: `info` < `warn` < `blocking`. Acks are NEW lines, never mutations.
Cross-process safe via `_LockedSection` (msvcrt on Windows, fcntl on POSIX,
threading.Lock for in-process, 5 s timeout with graceful degrade).

**Public API:**
- `alerts.write(severity, source, message, tags)` — append.
- `alerts.write_dedupe(severity, source, message, dedupe_tag, window_seconds, tags)`
  — atomic check-then-write. Two concurrent callers cannot both append a
  duplicate within the window.
- `alerts.ack(alert_id)` — append ack line.
- `alerts.read_unacked(severity_min, limit)` — folded view, oldest first.
- `alerts.archive_older_than(days)` — move to `~/.ultron/alerts/archive/YYYY-MM.jsonl`.

`session-init.ps1` injects unacked `warn`+`blocking` alerts into `context.md`
under a `## Pending Alerts` section so they surface at turn 0.

---

## 12. Security (S5-C hardening)

Six security primitives, all gated into the auto-discover and install paths.

**Skill scanner** (`skill_sync_security.py`) — **12** prompt-injection /
hardening rules (PI012 added post-Genesis):

| Rule | Pattern | Severity | Decision contribution |
|---|---|---|---|
| PI001 | "ignore previous instructions" / system-prompt overrides | CRITICAL | block |
| PI002 | HTML comments with system/instruction directives | HIGH | quarantine |
| PI003 | Zero-width / RTL-override unicode | HIGH | quarantine |
| PI004 | Base64 blob >200 chars (not `data:`) | MEDIUM | warn |
| PI005 | Shell command in YAML frontmatter VALUES | CRITICAL | block |
| PI006 | Non-whitelisted top-level frontmatter keys | MEDIUM | warn |
| PI007 | "use the bash/shell tool" patterns in description | HIGH | quarantine |
| PI008 | URL/IP exfiltration patterns (webhook.site, raw.githubusercontent / non-anthropics, public IP) | HIGH | quarantine |
| PI009 | `tools: Bash\|Write\|Edit` declared from untrusted source | MEDIUM | warn (then trust-downgrades silently) |
| PI010 | Encoded payloads (>20 hex / >100 url-encoded / >20 unicode) | MEDIUM | warn |
| PI011 | Frontmatter `source` field present | MEDIUM | warn (and IGNORED for trust) |
| PI012 | Embedded system-prompt directives in SKILL body ("You are…", `SYSTEM:`, `<system>` tags) | HIGH | quarantine |

**Aggregation:** any block → block; any quarantine → quarantine; any warn
→ warn; else allow. Trusted-source downgrade: `warn → allow` AND
`quarantine → warn`, but `block` is preserved (only an explicit
sha1-bound waiver in `skill-trust.yaml` overrides block).

**Trust source:** never the SKILL.md frontmatter. Only:
- `source_kind == "local"` AND skill path under `local_skill_root`, OR
- `trust_level == "trusted"` AND `source_url` populated by an out-of-band
  installer (reserved for future signed-fetch paths).

**Per-skill exceptions** (`~/.ultron/config/skill-trust.yaml`): waive specific
rule_ids for a skill when its current `skill_md_sha1` matches the recorded
hash. Modifying the SKILL.md invalidates the waiver, forcing fresh review.
SHA1 is non-cryptographic — adequate for accidental drift detection in the
home-system threat model.

**Provenance** (`skill_provenance.py`): `~/.ultron/skill-provenance.json`
records `source_kind`, `source_url`, `declared_source`, `installed_at`,
`skill_md_sha1`, `trust_level`, `scan_decision`, `last_scanned`. Cross-process
locked.

**Hook input validator** (`hook_input_validator.py`): JSON Schema per
hook event (`UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`,
`SessionStart`, `Notification`, `SubagentStop`). Bounded stdin reader (4 MiB
cap). String length caps (1 MB for prompt, 100 KB others). Null-byte
rejection. Depth cap (10 levels). Failure → `safe_load_stdin` returns None →
hook exits 0 + warn alert via `write_dedupe(window=3600)` so silent drops are
observable.

**Settings integrity** (`settings_integrity.py`): append-only snapshot ledger
of `~/.claude/settings.json` at
`~/.ultron/integrity/settings.snapshots.jsonl`. `verify()` diffs current vs
last `user_authorized=true` snapshot, surfaces added/removed MCPs/hooks/
plugins. Missing baseline → `warn` finding with fix command.

**MCP allowlist** (`mcp_allowlist.py` + `~/.ultron/config/mcp-allowlist.yaml`):
enforced by `mcp_installer.py` BEFORE settings.json mutation. Exact match
or scope-boundary publisher prefix (`@scope` exact OR `@scope/...`). Import
failure → fail-closed unless `--force` (alert logged). Allowlist file has
7 entries (verified 2026-05-08); 19 MCPs are currently registered in
Claude Code (the allowlist gates the install path, not all currently-
active MCPs — claude.ai-managed ones bypass it).

**Secrets scanner** (`secrets_scanner.py`): scans settings.json,
alerts.jsonl, telemetry, config yaml, .tmp json. Detects OpenAI/Anthropic/
Google/GitHub/Slack/AWS keys + high-entropy values in `*_key|*_token|*_secret`
fields. Whitelists `${VAR}` placeholders and `sha1:` hash prefixes.

**Path traversal guard** (`path_traversal_guard.py`): `safe_resolve(user_path,
base)` rejects `..`/null bytes/escapes. Library-only — call sites migrate
incrementally.

---

## 13. Doctor

`doctor.py` — system self-check. **18 detectors** total (14 base + 4
security; D17/D18 added in v14.1.x):

A. Orphan paths in `~/.ultron/` not referenced by active scripts
B. Skills installed but absent from manifest
C. Skills in manifest deprecated:false but not on disk
D. Hooks in `settings.json` whose script path doesn't exist
E. L0 stale (>4h)
F. ZTMSI stale (>4h)
G. Session logs >30d
H. Backup snapshots >90d
I. Telemetry >180d
J. Alerts unacked blocking >24h
K. `alerts.jsonl` >10MB
L. ULTRON token overhead >1500
M. MCP hard fails
N. Skill provenance drift (sha1 mismatch / unknown skill)
O. Settings.json drift vs last authorized snapshot
P. Secrets in config / logs
Q. Skills failing security scan
R. **D17 — Deadwood:** reads `~/.ultron/.tmp/deadwood.json` sidecar (24h
   freshness). Surfaces top 5 BLOCKING individually (overflow folded),
   aggregates WARN into one summary, suppresses INFO.
S. **D18 — Skill truncation:** walks `~/.claude/skills/` +
   `~/.claude/plugins/`, classifies SKILL.md by namespace, warns when
   total exceeds `thresholds.skill_truncation_warn_at` (default 200).

**CLI modes:**

```bash
ultron doctor                 # full report (info exits 0, warn 1, blocking 2)
ultron doctor --fix           # interactive y/N per finding (TTY required or --yes)
ultron doctor --dry-run       # report only, never write
ultron doctor --json          # machine-readable
ultron doctor --health-check  # MCP + ZTMSI + L0 compact
ultron doctor --token-audit   # E1 measurement
ultron doctor --security      # only N/O/P/Q
ultron doctor --quiet         # exit code only
```

**`--fix` safety:** TTY gate refuses to run on piped input unless `--yes` is
explicit on argv. `fix_command` is doctor-internal (never user-supplied). Each
applied fix is appended to `~/.ultron/.tmp/doctor-fix-log.jsonl`.

**Auto-doctor opt-in:** set `auto_doctor: true` in `doctor-rules.yaml` →
`stop-memory-sync.ps1` fires `doctor --quiet --json` once a week (gated by
`~/.ultron/.tmp/doctor-last-run.txt`, 30 s job timeout).

**Configuration:** `~/.ultron/config/doctor-rules.yaml` — retention windows,
staleness thresholds, token overhead limit. Defaults baked in if absent.

---

## 14. MCP resilience

`mcp_health_check.py` — probes every MCP in `settings.json`. Stdio MCPs
get a JSON-RPC `initialize` request via `silent_popen`; SSE MCPs get a
urllib HEAD/GET. Per-probe timeout 3 s, parallel ThreadPoolExecutor with
`max_workers = min(N, 9)` and an overall deadline of `timeout_s + 1`. Pending
probes at the deadline are marked `degraded`.

Output: `~/.ultron/.tmp/mcp-health.json` (atomic temp + flush + fsync +
os.replace). Status per MCP: `ok` | `degraded` | `missing`.

Subprocess hygiene: `_kill_tree(proc)` walks the Windows process tree via
`taskkill /T /F` so `npx.cmd → node → MCP server` chains never linger.

`${VAR}` env placeholders in stdio configs are expanded before the probe so
secret-bearing MCPs (Gemini API key, etc.) don't false-degrade.

`mcp-resilience.py` (PreToolUse hook) reads `mcp-health.json` on every MCP
tool call. If the MCP is degraded, injects a one-line `additionalContext`
with the fallback string from `mcp-fallbacks.yaml`. p95 hook latency well
under the 40 ms PreToolUse budget.

---

## 15. Sessions & compaction

**Session log** (`session-log.py`, Stop hook): one JSONL line per session
appended to `~/.ultron/sessions/YYYY-MM-DD.md`.

**Compactor** (`session_compactor.py`, HIGH+ Stop only): transcript →
summarized vault note via Codex. Output:
`~/.ultron-vault/50_SESSIONS_LOG/auto-YYYY-MM-DD-HHMMSS.md` with
`## Next-session seeds` section. SessionStart re-pulls those seeds into L0.

**Memory bridge** (`memory_bridge.py`): mirrors per-project Claude Code
memories from `~/.claude/projects/*/memory/` into the vault under
`CC-memories/`. Wikilink repair runs weekly.

**Push queue** (`memory_sync.py push-queue`): drained at SessionStart with
a 5 s timeout. Items not delivered stay queued for the next attempt.

---

## 16. Backups

`~/.ultron/backups/YYYY-MM-DD-pre-SX/` — taken before each sprint that
modifies `settings.json`, hooks, or core cockpit scripts. Included files
typically: `settings.json`, `hooks/session-init.ps1`,
`hooks/stop-memory-sync.ps1`, `cockpit/ultron.ps1`, `cockpit/tui.py`, the
specific scripts being modified, plus large state files (e.g. `index.db` for
S2-A, `manifest.cache.json` for S4).

Backup rotation: doctor surfaces snapshots >90 days for archival review;
nothing is deleted automatically.

---

## 17. Plans & references

- Master plan: `~/.ultron/plans/ULTRON-v14-MASTER-DEFINITIVO.md` (v4.6
  LOCKED). All sprints S0–S5 closed.
- v14.1 sprint plan: `~/.ultron/plans/2026-05-06-repo-evaluator-genesis-14-audit.md`
  (DEADWOOD sprint — 8 commits, Phases 0–7 + ULTRA polish).
- Release marker: `~/.ultron/GENESIS-RELEASE.md`.
- Dual Mode protocol spec: `~/.claude/skills/ultron/references/dual-mode-protocol.md`.
- Multimodel infra: `~/.ultron/multimodel/` (S2-C MMFP requests/responses).
- Telemetry samples: `~/.ultron/telemetry/v14-overhaul/`.
- Sprint audits:
  `~/.ultron/audits/skill-truncation-2026-05-07.md`,
  `~/.ultron/audits/skill-pi-audit-2026-05-07.md`,
  `~/.ultron/audits/deadwood-baseline.md`.
- This document: `~/.ultron/docs/ULTRON-GENESIS-CAPABILITIES.md`.

---

## 18. v14.1+ systems (post-Genesis additions)

Capabilities introduced after the v14.0.0 release. All shipped via the
DEADWOOD sprint (commits `9b91494`..`4d99589`).

**Deadwood scanner** (`scripts/cockpit/deadwood_scanner.py`, ~500 LOC,
18 tests). Detects deprecated/dead fragments via three stages:

1. *Sentinel scan* — explicit `@ULTRON-DEPRECATED:<ver>` blocks with
   required fields (`reason`, `replaced-by`, `remove-after`, optional
   `owner`/`severity`). Promotes to BLOCKING when `remove-after < today`.
   Multi-language comment prefixes (`#`, `//`, `--`).
2. *Heuristic regex* — `removed_in_v`, `deprecated_word`,
   `legacy_marker`, `todo_remove`, `dead_suffix`. Suppresses inside
   Python triple-quoted spans + sentinel-wrapped ranges.
3. *Cross-reference* — ultron.ps1 stub-dispatch detection,
   settings.json hook path validation, `health.py:EXPECTED_SCRIPTS`
   drift via AST parse.

CLI: `--json` (sidecar `~/.ultron/.tmp/deadwood.json`), `--report`
(markdown audit `~/.ultron/audits/deadwood-<date>.md`), `--quiet`,
`--roots`. Exit codes 0/1/2 mirror doctor. Wired into `ultron sync-all`
step 7 (refresh sidecar before doctor smoke).

**Sentinel marker grammar** (`@ULTRON-DEPRECATED:<version>`): structured
inline-comment annotation for code fragments. Required fields enforce
discoverable owner + retire date. Used today on ultron.ps1 stubs (auth,
usage, limits, telemetry — `remove-after: 2026-11-07`) and
auto_updater.py legacy commands.

**Skill trust framework** (`~/.ultron/config/skill-trust.yaml`):
- `trusted_sources` list (anthropics, addyosmani, obra,
  claude-code-plugins, agent-skills@addy-agent-skills,
  claude-plugins-official, superpowers-marketplace,
  awesome-claude-code-subagents).
- `local_skill_root` for filesystem-vetted local skills.
- `exceptions` block: per-skill sha1-bound waivers. Each waiver lists
  `waived_rules` (e.g. `["PI001","PI012"]`) with `reason`,
  `approved_by`, `approved_at`. Modifying SKILL.md invalidates waivers.

**repo-evaluator audit prompts**
(`scripts/cockpit/tui/prompts/01-09-*.md`): 9 ULTRA TRIPLE / HIGH DUAL /
MAXTRIPLE / MINIDUAL audit prompts loaded by TUI buttons. Uniform
structure ROLE / CONTEXT / INPUTS / CHECKS / OUTPUT / CONSTRAINTS.

**Action prompt files**
(`scripts/cockpit/tui/prompts/skills-*.md`): six clipboard prompts for
TUI skill-management buttons (`registry-sync`, `search-github`,
`update-all`, `create`, `search-codex`, `search-gemini`). Same loader,
same uniform structure.

**Newsletter template** (`scripts/cockpit/templates/newsletter.md.tmpl`
+ `NEWSLETTER_EDITIONS` dict in tui.py). One template, three editions
(tech / football / space) parameterised by edition_name, tagline,
accent, topics, sources, sections, min_news, breaking_banner_block.

**Usage configurable reset**
(`~/.ultron/cockpit/usage-config.json` + `UsageResetConfigModal` in
tui.py). Replaces hardcoded Friday 03:00. Free-form input
(`Friday 03:00` / `fri 3` / `vie 03:00` / `4 3 0`) with locale-aware
weekday prefixes.

**github-pat MCP** (user scope). Reads PAT from
`GITHUB_PERSONAL_ACCESS_TOKEN` env (loaded by
`~/.ultron/cockpit/secrets-loader.ps1` from Windows Credential Manager
target `ULTRON_GITHUB_PAT`). Coexists with the Copilot-OAuth-based
`plugin:github:github` as a PAT-based fallback. Both currently
✓ Connected.

**Test suite growth:** 247 (v14.0.0) → 611 + 20 skipped (v14.1.1).
Added: `test_deadwood_scanner.py` (18), `test_doctor_deadwood.py` (10),
`test_doctor_skill_truncation.py` (7), `test_clipboard_prompts.py`
(20), `test_usage_reset.py` (25).
