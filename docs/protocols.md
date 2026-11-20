# Protocols — ULTRON Operational Procedures

Reference for recurring maintainer protocols. Scripts listed here are
**not** user-facing (see `docs/MAINTAINERS.md` for the full inventory);
they are invoked manually or by scheduled tasks on a known cadence.

---

## Governed memory maintenance

The governed memory (`brain.db`) has its own maintenance: the SessionEnd hook
`memory-gc.js` runs `ultron-memory gc --days 90` at most once a week, and
`ultron-memory doctor` checks the FTS5 index.

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

## See also

- `docs/MAINTAINERS.md` — canonical inventory of all maintainer-only scripts.
- `docs/RELEASE-CHECKLIST.md` — pre-release preflight.
- `docs/RELEASE-PROCESS.md` — step-by-step release flow.
- `docs/CHANGELOG-POLICY.md` — versioning and CHANGELOG format.
