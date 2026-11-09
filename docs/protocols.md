# Protocols — ULTRON Operational Procedures

Reference for recurring maintainer protocols. Scripts listed here are
**not** user-facing (see `docs/MAINTAINERS.md` for the full inventory);
they are invoked manually or by scheduled tasks on a known cadence.

---

## Auto-memory audit protocol

**Script:** `scripts/memory-audit.py`
**Cadence:** Manual. No hook or Control Center caller runs it.

Audits the Claude Code auto-memory files
(`~/.claude/projects/*/memory/*.md`, not `brain.db`) and reports entries
without frontmatter, with an invalid `type`, oversized without structure,
duplicated (Jaccard similarity >= 0.80), stale, or missing from the
`MEMORY.md` index. It is read-only except for `--fix-index`, which appends
the orphan entries to `MEMORY.md`.

```powershell
uv run python scripts/memory-audit.py
uv run python scripts/memory-audit.py --fix-index
```

The governed memory (`brain.db`) has its own maintenance: the SessionEnd hook
`memory-gc.js` runs `ultron-memory gc --days 90` at most once a week, and
`ultron-memory doctor` checks the FTS5 and Qdrant indexes.

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

**Scripts:** `cockpit/skill-lazy/_verify_final.js`, `cockpit/skill-lazy/_accuracy_at3.js`
**Cadence:** After every edit to the skill dispatcher or `config/intent-rules.yaml`.

The dispatcher (`routing-dispatcher.v2.js` + `v3.js`) is not wired as a
Claude Code hook since 2026-09-29, but its harnesses and the CI job
`routing-dispatcher` still guard it. Both must stay green:

```powershell
node cockpit/skill-lazy/_verify_final.js
node cockpit/skill-lazy/_accuracy_at3.js
```

The old `scripts/routing-test-runner.py` (it ran a v1 dispatcher that no
longer exists) was removed on 2026-10-08.

---

## Skill-catalog rebuild protocol

**Script:** `scripts/skill-discovery.py`
**Cadence:** When adding or removing skills from `~/.claude/skills/`.

One-off scan that detects skills not mapped in FAST PATH Layer 1/2.
After running, update `cockpit/skill-lazy/routing-dispatcher.v2.js` (and
v3) to cover any newly discovered skills; remember the dispatcher is not
wired as a hook today.

```powershell
uv run python scripts/skill-discovery.py --verbose
```

---

## See also

- `docs/MAINTAINERS.md` — canonical inventory of all maintainer-only scripts.
- `docs/RELEASE-CHECKLIST.md` — pre-release preflight.
- `docs/RELEASE-PROCESS.md` — step-by-step release flow.
- `docs/CHANGELOG-POLICY.md` — versioning and CHANGELOG format.
