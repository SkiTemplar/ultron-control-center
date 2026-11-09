# ULTRON Integration Guide

## One repo, two layers

ULTRON is a **single monorepo** at `~/.ultron/` with one `.git` root and
no submodules. There are no separate repositories to integrate.

Two versioned layers coexist inside it, plus the Node scripts that glue them:

| Layer | Root | Version | Technology |
|-------|------|---------|------------|
| Python Cockpit | `scripts/cockpit/` | 15.7.0 | Python 3.12, uv |
| Control Center | `control-center/` | 15.8.0 | Tauri 2, React 19, Rust |
| Hooks, mods and scripts | `hooks/`, `mods/`, `scripts/` | unversioned | Node.js |

### Why two version numbers?

The Python cockpit holds **maintenance tooling**: `doctor.py`, the scheduled
tasks and CLI utilities that have been evolving since v14. It is not the runtime.
The core lives elsewhere: memory (`ultron-memory`) and the AI Router (`route()`, in
`control-center/src-tauri/src/ai_router/`) are Rust, and the Claude Code hooks are
Node.js. Its version is tracked in `pyproject.toml` and propagated to docs/badges via
`scripts/cockpit/version_propagate.py`.

Control Center is the **main product** — a Tauri 2 desktop application whose core
is the ULTRON Sessions window (multi-engine chat), plus memory, delegation and the
tabs around them. It was rewritten to v2.0 in May 2026 and followed
its own semantic version (`2.x`) in `control-center/package.json` until it
was unified to the `15.x` line on 2026-09-10 (currently 15.8.0, one step
ahead of the cockpit's 15.7.0). The CI `version-drift` gate intentionally
lets these two numbers diverge (that guard checks internal consistency
within each layer — `package.json`/`Cargo.toml`/`tauri.conf.json` for
Control Center — not cross-layer synchronisation).

### Repo structure

```
~/.ultron/
├── .git/                        single git root
├── pyproject.toml               Python cockpit v15.7.0
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
│   ├── package.json             Control Center v15.8.0
│   ├── src/                     React 19 frontend
│   └── src-tauri/               Rust/Tauri 2 backend
├── hooks/                       Claude Code lifecycle hooks
├── brain.db                     SQLite memory store (FTS5, runtime — gitignored)
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

The GUI is built with standard Tauri / npm tooling.

```powershell
cd control-center

# Development mode (hot-reload)
npm install
npm run tauri dev

# Production build: plain executable, no installer (bundle targets: ["app"])
# Output: control-center/src-tauri/target/release/control-center.exe
npm run build:app
```

`build:app` does not close a running instance: it renames the locked `.exe`
(`control-center/scripts/release-locked-exe.mjs`), and the new binary takes effect
when the app restarts. The Tauri updater is disabled (`plugins.updater.active: false`
in `tauri.conf.json` until a real signing key exists), so upgrades are manual.

### CI gates

All three layers are checked by `.github/workflows/ci.yml`, on push and on pull
requests to `main`. A red run does not stop later pushes, so CI is a signal, not a
barrier: check `gh run list --branch main` (check 12.6 of the Kirkardo meter
measures it).

| Job | Scope | Runner |
|-----|-------|--------|
| `version-drift` | `version_propagate.py --check` (installers vs `pyproject.toml`) | ubuntu-latest |
| `personal-info-leak` | no HIGH personal-data findings | ubuntu-latest |
| `cargo-clippy` | `cargo clippy --lib --bins -- -D warnings` | windows-latest |
| `cargo-test` | `cargo test` (lib only), three parallel jobs: `sesiones::`, `memory::` + `mascot::` and the rest | windows-latest |
| `typescript` | `tsc --noEmit` | windows-latest |
| `vitest` | `vitest run --shard=N/3` (3 jobs in parallel) | windows-latest |
| `routing-dispatcher` | dispatcher scripts load (syntax + require chain) | ubuntu-latest |
| `hook-selftests` | hook and script selftests (hermetic; `--fake-home --jobs 4`), two parallel jobs: `delegate.selftest` and the rest | windows-latest |
| `mods-tests` | `claude plugin test` for each mod + desktop MCP (`scripts/run-mod-tests.mjs`, pinned CLI) | windows-latest |
| `python-tests` | `pytest tests/` | windows-latest |

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
Mostly. Memory recall (`ultron-memory`, `recall_unified`) and AI routing
(`ai_router/`) are Rust and only need `brain.db` and the sidecar. The Python
runtime is needed for the cockpit scripts: `doctor.py`, the maintenance
commands that shell out to `scripts/cockpit/*.py`, and a few panels that read
their output.

**Q: What happened to the Mem0 / ECC migration plan?**
That plan (2026-05-22) was discarded. ULTRON's memory system remains the
native Rust binary `ultron-memory.exe` backed by `brain.db` (SQLite +
FTS5). Dense recall over a native Qdrant binary (path configurable via
`ULTRON_QDRANT_EXE`; defaults to `~/.ultron/qdrant-native/`) is optional:
it is on by default in the code and `ULTRON_DENSE=0` turns it off, leaving
sparse FTS5 recall. Mem0 is not used.
