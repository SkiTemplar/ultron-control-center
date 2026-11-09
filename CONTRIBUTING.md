<div align="center">

<h1>Contributing to ULTRON</h1>

<p>
  <a href="README.md">README</a>
  &middot;
  <a href="INSTALL.md">Install</a>
  &middot;
  <a href="SECURITY.md">Security</a>
  &middot;
  <a href="LICENSE">License</a>
</p>

</div>

ULTRON is a Windows 11 + Linux x86_64 (v15.5+) orchestrator for Claude Code and Codex (Gemini is reachable as a cloud provider through the AI Router). The default install runs against existing subscriptions; an opt-in API-key path is welcome as a contribution. It is a small project with strong opinions. This document is the operational guide for getting a dev environment up and landing a PR — not a manifesto. If you only want to *use* ULTRON, read `INSTALL.md` instead.

---

## 5 commands to start contributing

From an elevated PowerShell on Windows 10/11 with Claude Code already installed and authenticated:

```powershell
git clone https://github.com/SkiTemplar/ultron-control-center.git $env:USERPROFILE\.ultron
cd $env:USERPROFILE\.ultron
.\install.ps1                       # auto-installs uv, Qdrant native, hooks (~3 min)
cd control-center
npm install ; npm run tauri dev     # launches the desktop app
```

`install.ps1` is idempotent — re-running is safe. It refuses to continue if Claude Code is missing. If you do not want a desktop build (no Rust toolchain on this machine, headless box, etc.), pass `-NoApp` to `install.ps1` and stop after step 3.

The Codex CLI is optional (gemini-cli was retired on 2026-06-19). Most development work only requires Claude Code.

---

## Repository layout

One screen. Everything below is relative to the repo root (`~/.ultron/` on a working install).

```
ultron/
  install.ps1                       Root bootstrap installer (idempotent).
  pyproject.toml / uv.lock          Python deps, managed by uv. Never use pip.
  .github/workflows/                ci.yml (cargo build/test + tsc + vitest).

  control-center/                   The Tauri 2 desktop app.
    src/                            React + TypeScript frontend.
      App.tsx                       Tab router.
      components/                   One .tsx per sidebar tab (Dashboard, Skills, Agents...).
      lib/                          Shared helpers (button-prompts.ts, features.ts, paths.ts).
      types.ts                      Shared TS types mirroring Rust structs.
    src-tauri/                      Rust backend.
      src/<domain>.rs               Domain logic (agents.rs, skills.rs, memory.rs, ...).
                                    Each exposes a `*_inner` pure-Rust API.
      src/commands/<group>.rs       Thin #[tauri::command] wrappers (v15.4 split).
                                    Wrappers only delegate to the domain `*_inner`.
      src/lib.rs                    Runtime plumbing only: plugins, tray, hotkeys.
      src/handlers.rs               The generate_handler! registry of every Tauri command.
      tauri.conf.json               App identifier, window config, allowlist.

  scripts/
    cockpit/                        Python operational layer (brain_index, alerts,
                                    agent_telemetry, context_primer, doctor, etc.).
    hooks/                          Only auto-changelog.py (run by git-hooks/post-commit).

  hooks/
    scripts/*.js                    Claude Code hooks (Node). Run in place from
                                    ~/.ultron/hooks/scripts; wired in ~/.claude/settings.json.
    manifest.json                   Versioned mirror of the live hooks (regen-manifest.js).

  templates/                        Files copied into ~/.claude or ~/.ultron at install.
    settings-hooks.json             Hook template the installers merge; generated from
                                    ~/.claude/settings.json by hooks/regen-manifest.js.
    CLAUDE.md.example, MEMORY.md.example, etc.

  cockpit/                          Runtime data (catalogs, telemetry). Most files are
                                    gitignored except checked-in catalogs like
                                    mcp-catalog.json.

  skills/, plans/, knowledge/       Sources for the brain_index FTS5 corpus.
  tests/                            pytest suite (CI job python-tests).
```

Avoid Grep-ing blind for a script. `SYSTEM-MAP.md` at the repo root is the pinned route table.

---

## Where to add what

| You want to add | Edit / create | Wire it via |
|---|---|---|
| A new Tauri command | `control-center/src-tauri/src/<domain>.rs` (logic as `*_inner`) + thin wrapper in `control-center/src-tauri/src/commands/<group>.rs` | `pub use` in `commands/mod.rs` and the `generate_handler!` macro in `control-center/src-tauri/src/handlers.rs` |
| A new React tab | `control-center/src/components/<Name>.tsx` | Add the tab id to the `Tab` union and `SECTIONS` in `control-center/src/components/Sidebar.tsx`, then render it in `App.tsx` |
| A Claude Code hook | `hooks/scripts/<name>.js` (Node) | Register it in `~/.claude/settings.json`, then run `node hooks/regen-manifest.js` to refresh `hooks/manifest.json` and `templates/settings-hooks.json` (the pre-commit `--check` fails on drift; `tests/test_hooks_template.py` checks the template only cites scripts in the repo) |
| A cockpit Python tool | `scripts/cockpit/<name>.py` (inherit `cockpit_base` where it helps) | A test in `tests/test_<name>.py` and, if user-facing, surface it from a Tauri command or hook |
| A skill | `~/.claude/skills/<name>/SKILL.md` with mandatory YAML frontmatter (`name`, `description`, `model`) | The skill scanner picks it up automatically; run `uv run python scripts/cockpit/embed_skills.py index` if it should appear in semantic recall (needs Qdrant) |
| An agent | `~/.claude/agents/<name>.md` (one file, same frontmatter rules, plus an exact 5.5-family `model` and `maxTurns`) | The Agents tab lists it; it refuses to enable or save as active an agent without both (`control-center/src-tauri/src/agents/policy.rs`) |
| A button prompt | `control-center/src-tauri/src/button_prompts/defaults.rs` (the canonical catalog, `build_defaults`) | Consumers fetch via `getPrompt(key, vars)` from `src/lib/button-prompts.ts` |

Skill and agent frontmatter uses **full Claude model IDs** (`claude-sonnet-5`, `claude-opus-5`) — never short aliases. The PI001-PI013 prompt-injection scanner in `scripts/cockpit/skill_sync_security.py` runs against both directories with the same rules.

---

## Conventions that are actually enforced

Read the files around yours before adding new code. The patterns are consistent on purpose.

- **Comments answer WHY, not WHAT.** If the code is obvious, no comment. If a workaround exists for a Tauri / Windows / Codex quirk, leave a comment explaining the trap.
- **No emojis in source code.** Markdown deliverables that the user explicitly asks for can use them; checked-in code, hooks, scripts and docs cannot.
- **Python is UTF-8 explicit.** Any script that emits to stdout starts with `sys.stdout.reconfigure(encoding="utf-8")` — Windows code pages otherwise mangle non-ASCII output piped through the Tauri sidecar.
- **PowerShell is strict.** `Set-StrictMode -Version Latest` and `$ErrorActionPreference = 'Stop'` at the top. Use `Test-Path -LiteralPath` to avoid wildcard surprises in user-home paths.
- **Rust at the Tauri boundary returns `Result<T, String>`.** The frontend deserialises errors as strings; never bubble a typed Rust error across the IPC seam. Domain modules can use richer errors internally; convert at the wrapper.
- **Python deps via `uv`.** Never `pip install`, never `python script.py`. Use `uv run python script.py` and `uv pip install <pkg>`.
- **Subscription-first, API keys are opt-in.** ULTRON's default install uses the Claude Code and Codex CLIs against existing subscriptions — no API keys required. A PR that **adds** an opt-in API-key path for users who prefer pay-per-token is welcome (gated behind an off-by-default config flag and clearly marked as optional). What is NOT welcome is removing the subscription path or making the API-key route the default.
- **No telemetry, no silent network calls.** Every outbound request must be user-initiated. This is non-negotiable.
- **No Docker.** ULTRON dropped Docker in v15.0.2 in favour of the native Qdrant binary, which only dense recall needs (`ULTRON_DENSE=0` turns it off). Do not reintroduce.

A pre-commit hook runs the PII gate (`audit_personal_data.py`, fails on HIGH), the hooks parity check (`hooks/regen-manifest.js --check`, manifest and install template), the selftest classification check (`scripts/run-selftests.mjs --check`) and `cargo fmt --check`. Heavy checks (cargo test, vitest, tsc) run in CI. Install it once with:

```powershell
uvx pre-commit install
```

---

## Local checks before pushing

CI runs the three jobs below on `windows-latest`. Run them locally first.

```powershell
# Rust (~30s warm)
cd $env:USERPROFILE\.ultron\control-center\src-tauri
cargo check --all-targets
cargo clippy --all-targets -- -A warnings

# TypeScript (~5s)
cd $env:USERPROFILE\.ultron\control-center
npx tsc --noEmit

# Python (~60s)
cd $env:USERPROFILE\.ultron
uv run pytest tests/ -q --tb=short `
  --ignore=tests/test_multimodel.py `
  --ignore=tests/test_auto_recall.py `
  --ignore=tests/test_backup_watch.py `
  --ignore=tests/test_meta_prompter.py `
  --deselect=tests/test_intent_dispatcher.py::test_telemetry_written
```

The excluded files assume a fully-provisioned local environment (scheduled tasks, populated history, PII paths). They cannot run on a fresh checkout. See `.github/workflows/ci.yml` for the canonical exclude list.

Rust **unit** tests are scarce today — the Tauri crate has near-zero coverage. New domain code is expected to include `#[cfg(test)] mod tests` blocks for the `*_inner` functions.

---

## Areas where help is welcome

These are the issues to grab if you want to start small and land something useful.

- **Rust unit tests for `src-tauri/src/<domain>.rs`.** Each domain module's `*_inner` functions are pure Rust; mock the filesystem with `tempfile` and test them.
- **Button-prompt migration.** Roughly ten components still inline their AI session prompts as string literals. The pattern to follow lives in `control-center/src/lib/button-prompts.ts` and `src-tauri/src/button_prompts/defaults.rs`.
- **Agents tab UX.** The scanner output, batch enable/disable, and bulk edits all need polish. See `control-center/src/components/Agents.tsx`.
- **Sustainable i18n.** Today the README is bilingual by hand-maintaining two files. A real i18n system (probably gated to long-form docs only) would be welcome.
- **Hooks observability.** Hooks log timings and errors through `hooks/scripts/lib/hook-obs.js` (`hook-errors.jsonl`); a single hook-execution dashboard tab does not exist yet.

If something is not on this list but you think it fits the scope above, open a draft issue first.

---

## Out of scope

These will be declined regardless of code quality. Open a discussion before writing the code if you are unsure.

| Will be declined | Why |
|---|---|
| Making paid API keys the **default** path | Subscription-via-CLI is the contract for fresh installs. Adding an opt-in API-key route as a secondary path is fine; replacing or shadowing the CLI path is not. |
| Personal data, hard-coded user paths, persona names from a single vault | Use generic identifiers; read paths from config. |
| Telemetry, analytics, silent outbound calls | All network I/O must be initiated by an explicit user action. |
| Anything that reintroduces Docker | Removed in v15.0.2. When dense recall is on, the native Qdrant binary is the contract on both Windows and Linux. |
| macOS port | Explicit non-goal for v15.x. Windows 11 + Linux x86_64 (v15.5+) are the supported platforms; if you want macOS, fork and maintain it separately. |

---

## Opening a PR

1. Fork, branch off `main`. Naming: `feat/<slug>`, `fix/<slug>`, `docs/<slug>`, `chore/<slug>`, `refactor/<slug>`, `test/<slug>`.
2. Commit in conventional-commits style with imperative mood, and **always include
   the target version** in the scope so the commit log is self-documenting and the
   Dashboard / changelog views surface the bump correctly:
   - `feat(v15.4.21/plans): add archive-on-resolve toggle`
   - `fix(v15.4.21/hooks): handle UTF-8 BOM in settings.json`
   - `docs(v15.4.21/install): clarify Qdrant binary location`
   - `chore(v15.4.21/deps): bump tauri to 2.x`

   If a commit doesn't change `package.json` / `tauri.conf.json` / `Cargo.toml`, use
   the next-pending version (i.e. the one you would bump to if you tagged now). The
   version drift Doctor row catches mismatches between the three files on developer
   clones.
3. Co-author trailers for AI assistants (`Co-Authored-By: Claude ...`) are encouraged for transparency but **never required** from external contributors.
4. Run the three local checks above. CI runs the same three on `windows-latest` — if any is red on your machine, do not request review.
5. Push and open the PR. Description checklist:
   - [ ] One-sentence user-visible change at the top.
   - [ ] Link the spec under `plans/specs/` if one exists.
   - [ ] Mention any behaviour change that affects existing `~/.ultron/` data on disk.
   - [ ] List any new dependency (Python, npm or Cargo) and why it could not be avoided.
6. The auto-changelog hook detects version bumps in `pyproject.toml` / `tauri.conf.json` automatically. Do not hand-edit `CHANGELOG.md` in the same PR as a feature unless the entry is large enough to need prose.

No force-pushes to `main`. Rewrite history only on your own branch.

---

## Contact

- **General questions, design discussion, bug reports:** GitHub Issues on `SkiTemplar/ultron-control-center`.
- **Security vulnerabilities:** do **not** open a public issue. Follow the disclosure process in `SECURITY.md`.
- **Skill or agent proposals:** open a draft issue with the manifest attached. The PI scanner output is helpful context.

<div align="center">
<sub>Keep ULTRON small, fast, and honest.</sub>
</div>
