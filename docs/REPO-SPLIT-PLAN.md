# Repo Split Plan — v15.2 Public Release

ULTRON has lived as a single personal monorepo (`~/.ultron/`) since its origin.
For the public release we split it into three independent repositories so that
the code, the curated skill packs, and the empty vault skeleton can be cloned,
licensed, and versioned separately.

## Target repositories

| Repo | License | Contents | Audience |
|------|---------|----------|----------|
| `ultron` | MIT | Tauri Control Center, Python cockpit, PowerShell dispatcher, hooks, installer, docs | End users installing the tool |
| `ultron-skills` | MIT | Curated skill packs (core, dev, finance, creative, gaming) with generic names | Users who want preconfigured skills beyond what the installer offers |
| `ultron-memory-template` | MIT | Empty `~/.ultron/` skeleton: directory tree, placeholder `PLANS.json`, empty `brain_index/`, sample `context.md` | New users bootstrapping their first vault |

Each repo has its own LICENSE, README, and release cadence. `ultron` does not
depend on the other two at install time, but the installer can clone them on
request.

## Migration table

Mapping of current top-level paths in `~/.ultron/` to their destination:

| Current path | Destination | Notes |
|--------------|-------------|-------|
| `control-center/` | `ultron` | Frontend and Tauri shell |
| `scripts/` | `ultron` | Cockpit dispatcher and Python tools |
| `cockpit/audits/`, `cockpit/DASHBOARD.md` | `ultron` (templates only) | Real audits stay local |
| `cockpit/news/*.html` | not published | Personal newsletter output |
| `cockpit/icons/` | `ultron` | Tray and window icons |
| `plans/PLANS.json` | not published | Personal in-flight work |
| `plans/specs/` | `ultron` | Design specs are documentation |
| `docs/` | `ultron` | Public documentation |
| `pyproject.toml`, `uv.lock` | `ultron` | Python dependencies |
| `SYSTEM-MAP.md` | `ultron` (sanitized) | Strip user-specific paths |
| `MEMORY.md` | not published | Personal memory file |
| `memory-template/` (new) | `ultron-memory-template` | Empty skeleton derived from current layout |
| `~/.claude/skills/<generic>/` | `ultron-skills` | Only after renaming personas to roles |
| `~/.claude/skills/<persona>/` | not published | Persona skills are personal; keep in user's local tree |
| `skill-vault/` | partial → `ultron-skills` | Vendor-shipped vault items only |
| `personal/` | not published | Personal data root |
| `qdrant_storage/`, `qdrant-native/` | not published | Local index binaries |
| `brain_index/index.db` | not published | Personal index |
| `multimodel/`, `telemetry/`, `metrics/`, `audits/` | not published | Personal telemetry |
| `archive/`, `quarantine/`, `backups/`, `_legacy/` | not published | Personal history |
| `LICENSE`, `README.md`, `CONTRIBUTING.md` | `ultron` | This release |

When in doubt, the default is "do not publish". Add an explicit entry above
before moving a directory into a public repo.

## Pre-split checklist

Run these in order. Each item must be green before the next.

- [ ] **Persona-strip**: rename persona-named skills (Pana, Alfred,
      Don-Claudio, Tio-Gilito, Tolkien, Einstein, Terry, Mike, Warren, Jordan,
      Novalbos, Kirkardo, Tyson) to generic role aliases (`orchestrator`,
      `sys-admin`, `game-dev`, `finance`, `writer`, `tutor`, `senior-engineer`,
      `ui-designer`, `investment-advisor`, `business-strategist`,
      `cs-tutor`, `code-grader`). Persona names remain as optional aliases in
      the user's local tree only.
- [ ] **Path sanitization**: `grep -r "C:\\Users\\USER"` returns zero
      matches under `scripts/`, `control-center/src/`,
      `control-center/src-tauri/`, `cockpit/`, `docs/`. Replace with
      `Path.home()` or read from `config/`.
- [ ] **Secret audit**: scan history for tokens, API keys, OAuth blobs,
      personal email, phone. Run a fresh secret scanner against the staging
      branch.
- [ ] **`personal/` ignored**: `.gitignore` excludes `personal/`,
      `cockpit/news/*.html`, `memory/MEMORY.md`, `brain_index/`,
      `qdrant_storage/`, `qdrant-native/`, `_legacy/`, `archive/`, `backups/`,
      `quarantine/`, `multimodel/`, `telemetry/`, `metrics/`, `audits/`,
      `.tmp/`, `alerts.jsonl*`, `*.lock` files, screenshots at repo root.
- [ ] **LICENSE present** at the root of each target repo.
- [ ] **README done** for each target repo with install instructions matching
      that repo's scope.
- [ ] **Skill manifest filtered**: `skills.manifest.yaml` published in
      `ultron-skills` lists only the renamed generic skills.
- [ ] **Memory template scrubbed**: `ultron-memory-template` contains an empty
      tree with no real notes, no real plans, no real telemetry rows.
