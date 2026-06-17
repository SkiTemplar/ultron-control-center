# ULTRON Integration Guide

## One repo, two layers

ULTRON is a **single monorepo** at `~/.ultron/` with one `.git` root and
no submodules. There are no separate repositories to integrate.

Two distinct layers coexist inside it:

| Layer | Root | Version | Technology |
|-------|------|---------|------------|
| Python Cockpit | `scripts/cockpit/` | 15.5.20 | Python 3.12, uv |
| Control Center | `control-center/` | 2.7.1 | Tauri 2, React 19, Rust |

### Why two version numbers?

The Python cockpit is ULTRON's **operational runtime** — the CLI tools,
memory doctor, hooks, and scheduled tasks that have
been evolving since v14 (the AI Router decision engine itself, `route()`, is
Rust in `control-center/src-tauri/src/ai_router/`; the cockpit holds its
zones/providers JSON mirror, not the engine). Its version is tracked in `pyproject.toml` and
propagated to docs/badges via `scripts/cockpit/version_propagate.py`.

Control Center is the **GUI shell** — a Tauri 2 desktop application that
wraps the same runtime. It was rewritten to v2.0 in May 2026 and follows
its own semantic version in `control-center/package.json`. The CI
`version-drift` gate intentionally lets these two numbers diverge (that
guard checks internal consistency within each layer, not cross-layer
synchronisation).

### Repo structure

```
~/.ultron/
├── .git/                        single git root
├── pyproject.toml               Python cockpit v15.5.20
├── scripts/
│   └── cockpit/                 all Python operational scripts
│       ├── doctor.py            entrypoint (delegates to doctor_core)
│       ├── doctor_models.py     data model
│       ├── doctor_rules.py      rules loader
│       ├── doctor_checks.py     detection functions
│       ├── doctor_reporters.py  output formatters
│       ├── doctor_core.py       orchestration + CLI
│       └── ...
├── control-center/
│   ├── package.json             Control Center v2.7.1
│   ├── src/                     React 19 frontend
│   └── src-tauri/               Rust/Tauri 2 backend
├── hooks/                       Claude Code lifecycle hooks
├── brain.db                     SQLite memory store (FTS5)
├── config/                      runtime config (doctor-rules.yaml, etc.)
└── docs/                        this file and other documentation
```

## Deployment

### Python Cockpit (operational scripts)

The cockpit scripts run directly on the host — no containerisation, no
compilation step.

```powershell
# One-time: create the virtual env and install deps
uv sync

# Run any cockpit script
uv run python scripts/cockpit/doctor.py
uv run python scripts/cockpit/doctor.py --health-check
uv run python scripts/cockpit/doctor.py --json --quiet
```

Hooks are registered in `~/.claude/settings.json` and fired automatically
by Claude Code's lifecycle events (SessionStart, Stop, etc.).

Scheduled tasks (weekly backup, token baseline snapshot) are registered
via `scripts/cockpit/install-scheduler.ps1`.

### Control Center (Tauri desktop app)

The GUI is built and installed with standard Tauri / npm tooling.

```powershell
cd control-center

# Development mode (hot-reload)
npm install
npm run tauri:dev

# Production build (outputs installer to control-center/src-tauri/target/release/)
npm run build:app
```

After a production build, close the running ULTRON instance and run the
installer; the Tauri updater takes care of in-place upgrades.

### CI gates

All three layers are gated in `.github/workflows/ci.yml`:

| Job | Scope | Runner |
|-----|-------|--------|
| `version-drift` | `pyproject.toml` internal consistency | ubuntu-latest |
| `personal-info-leak` | no HIGH personal-data findings | ubuntu-latest |
| `cargo` | `cargo check` + `cargo clippy` | windows-latest |
| `typescript` | `tsc --noEmit` | windows-latest |

## FAQ

**Q: Are there two separate Git repos?**
No. Everything lives under `~/.ultron/.git`. There are no submodules and
no second remote.

**Q: Why does `git log` show both "feat(routing)" and "feat(memory)" commits?**
Both layers share the same commit history. Conventional-commit prefixes
(`feat(routing)`, `refactor(wave3b)`, etc.) are the human-readable scope
indicator, not a sign of separate repos.

**Q: Can I work on the cockpit without building Control Center?**
Yes. The Python layer is fully standalone. `uv run python scripts/cockpit/doctor.py`
works with no npm or cargo toolchain present.

**Q: Can I run Control Center without the cockpit?**
Partially. The GUI will launch, but memory recall, AI routing, and doctor
health checks require the Python runtime and `brain.db` to be present.

**Q: What happened to the Mem0 / ECC migration plan?**
That plan (2026-05-22) was discarded. ULTRON's memory system remains the
native Rust binary `ultron-memory.exe` backed by `brain.db` (SQLite +
FTS5) and a native Qdrant binary (path configurable via `ULTRON_QDRANT_EXE`;
defaults to `~/.ultron/qdrant-native/`). Mem0 is not used.
