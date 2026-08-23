# Protocols — ULTRON Operational Procedures

Reference for recurring maintainer protocols. Scripts listed here are
**not** user-facing (see `docs/MAINTAINERS.md` for the full inventory);
they are invoked manually or by scheduled tasks on a known cadence.

---

## Auto-cleanup protocol

**Script:** `scripts/memory-audit.py`
**Phase:** Phase A of `scripts/hooks/stop-memory-sync.{ps1,sh}`
**Cadence:** Every session Stop (automatically via the hook chain).

The auto-cleanup protocol runs `scripts/memory-audit.py` to:

1. Scan `brain.db` for items older than the configured retention window
   whose status is not `Active` (i.e., `Deprecated`, `Rejected`, or `Stale`).
2. Identify duplicate candidates (same `content_hash`, multiple rows) and
   collapse them — keeps the highest-sensitivity / most-recent entry.
3. Apply the configured sensitivity gates: items marked `Secret` are never
   surfaced in recall and are flagged for optional manual review.
4. Write a compact audit record to `~/.ultron/.tmp/memory-audit.jsonl`
   (gitignored) for the session log.

The script is **read-only by default** (dry-run unless `--apply` is passed).
The Stop hook always passes `--apply`, so removals are real and permanent.
Do not pass `--apply` manually without reviewing the dry-run output first.

### Manual invocation

```powershell
# Dry-run (safe — shows what would be removed)
uv run python scripts/memory-audit.py

# Apply (removes stale / duplicate items from brain.db)
uv run python scripts/memory-audit.py --apply

# Restrict to a single project
uv run python scripts/memory-audit.py --project ultron --apply
```

---

## Quarantine cleanup protocol

**Script:** `scripts/cleanup-quarantine.ps1`
**Cadence:** After each major wave refactor; monthly for `-PurgeExpired`.

Wave-based refactors leave `_cleanup_quarantine_<YYYY-MM-DD>` directories
under `~/.ultron/`. See `docs/MAINTAINERS.md §Disk Hygiene` for the full
command reference and safety rules.

---

## Version drift check protocol

**Script:** `scripts/cockpit/version_propagate.py`
**Cadence:** Every CI push (`.github/workflows/ci.yml § version-drift`).

Verifies internal consistency of the three Control Center manifests
(`package.json`, `Cargo.toml`, `tauri.conf.json`). The monorepo SSOT
version (`pyproject.toml` `[project].version`, the 15.x line) is checked
separately and is **decoupled** from the Control Center 2.x line.

```powershell
uv run python scripts/cockpit/version_propagate.py --check
```

Exit 1 on any drift. Fix by updating the lagging manifest to match, then
re-commit.

---

## Personal-data audit protocol

**Script:** `scripts/cockpit/audit_personal_data.py`
**Cadence:** Before every tag push; CI gate on every PR to `main`.

Walks every `git ls-files` entry for the author's real name, home path,
email, and persona slugs. Exit 1 on any HIGH finding. Run with `--strict`
to also catch MEDIUM findings.

```powershell
uv run python scripts/cockpit/audit_personal_data.py
uv run python scripts/cockpit/audit_personal_data.py --strict
```

A non-zero HIGH count blocks the release. Resolve by removing or
generalizing the offending content, then re-stage and re-run.

---

## Routing regression protocol

**Script:** `scripts/routing-test-runner.py`
**Cadence:** After every edit to `config/intent-rules.yaml`.

Runs regression cases T-01 through T-16, T-34, T-35 against the FAST
PATH Layer 1 + tiebreak logic. Any failure indicates a routing regression
and must be resolved before committing the rules change.

```powershell
uv run python scripts/routing-test-runner.py
uv run python scripts/routing-test-runner.py --verbose
```

---

## Skill-catalog rebuild protocol

**Script:** `scripts/skill-discovery.py`
**Cadence:** When adding or removing skills from `~/.claude/skills/`.

One-off scan that detects skills not mapped in FAST PATH Layer 1/2.
After running, update `cockpit/skill-lazy/routing-dispatcher.v2.js` (and
v3 if active) to cover any newly discovered skills.

```powershell
uv run python scripts/skill-discovery.py --verbose
```

---

## See also

- `docs/MAINTAINERS.md` — canonical inventory of all maintainer-only scripts.
- `docs/RELEASE-CHECKLIST.md` — pre-release preflight.
- `docs/RELEASE-PROCESS.md` — step-by-step release flow.
- `docs/CHANGELOG-POLICY.md` — versioning and CHANGELOG format.
