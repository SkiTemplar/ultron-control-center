# ULTRON Control Center

Local-first cockpit for orchestrating Claude Code, Codex, and Gemini across long sessions.

## What it is

ULTRON is a personal control surface that sits beside the Claude Code CLI and turns
multi-day, multi-model work into something you can actually manage:

- **3-layer hierarchical memory** (L0 hot context, L1 FTS5 brain index, L2 vault notes)
  with optional Qdrant semantic recall over the same corpus.
- **AI router** that picks between Claude (orchestration), Codex (peer review and
  rescue), and Gemini (long context, image generation) without leaving your editor.
- **Plans** tab: a single source of truth for in-flight work, with AI brainstorm,
  archive-by-resolve, and Claude-driven execute or review actions.
- **Skills** browser over the local `~/.claude/skills/` tree plus a separate
  `skill-vault/` for archived or large packs the model should not auto-load.
- **MCPs** dashboard for inspecting and toggling Model Context Protocol servers
  registered in `~/.claude/settings.json`.
- **News, Schedules, Stats**: daily HTML newsletter generator, scheduled tasks
  surface (backups, embeddings, scans), and per-session telemetry (token use,
  skills triggered, memories accessed, time on task).

## Requirements

- **Windows 11** is the primary supported platform. macOS and Linux are not
  tested yet, though the Python and Rust code is largely portable.
- **Claude Code CLI** (`claude`) — required, this is the runtime ULTRON wraps.
- **Rust** stable toolchain — needed to build the Tauri 2 desktop shell.
- **Node 22** and npm — for the React + TypeScript frontend.
- **uv** (`astral-sh/uv`) — Python runtime. The repo never uses raw `python` or
  `pip`; everything goes through `uv run` and `uv pip`.
- **Codex CLI** (optional) — peer review via the `codex-plugin-cc` plugin.
  Authentication is your ChatGPT subscription, no API key required.
- **Gemini CLI** (optional) — long-context analysis and image generation via
  OAuth subscription, no API key required.

ULTRON deliberately ships with no API key requirements. Everything that talks
to a model talks to a CLI you have already logged into.

## Quick install

A bootstrap script (`scripts/install.ps1`) walks you through:

1. Creating `~/.ultron/` and its memory subdirectories.
2. Optionally cloning a memory template into your vault.
3. Merging hooks into `~/.claude/settings.json` non-destructively.
4. Selecting which skill packs to install (core, dev, personal assistant,
   gaming, finance, creative — toggles, all optional).
5. Building the Control Center binary.

See `scripts/install.ps1` for the bootstrap flow. Run it from a fresh
PowerShell session in the cloned repo root.

## Architecture

```
~/.ultron/
  cockpit/             Python tools, audits, news, dashboard
    icons/             Tray and window icons
    audits/            Repo health snapshots
  control-center/      Tauri 2 + React 19 + TS desktop app
    src/               Frontend (tabs, components)
    src-tauri/         Rust commands and tray integration
  skills/              Active skill manifests (mirrors ~/.claude/skills)
  scripts/             PowerShell dispatcher + Python cockpit utilities
    cockpit/           brain_index, embed_vault, doctor, primer
    hooks/             SessionStart, Stop, UserPromptSubmit hooks
  plans/               PLANS.json single source of truth + specs
    specs/             Per-version design documents
  brain_index/          SQLite FTS5 index over vault notes
  qdrant_storage/      Local Qdrant collections (vault, skills)
  skill-vault/         Archived or large skill packs (lazy-load only)
```

## Privacy

All data lives under `~/.ultron/` and `~/.claude/`. There is no telemetry, no
analytics, and no outbound network traffic except calls you trigger explicitly
through the Claude, Codex, or Gemini CLIs you have already authenticated. The
news generator, embedding pipeline, and Qdrant instance all run locally.

If you choose to mirror your vault to a remote git repo (an optional L3 layer),
that is an explicit `git push` you control. Nothing else leaves the machine.

## Status

v15.1.x is stable for personal use. v15.2.0 is the first public release. Expect
rough edges on platforms other than Windows 11, and on first-run flows when
the user has no existing Claude Code installation. Bug reports and reproducible
issue write-ups are welcome via GitHub Issues.

## License

MIT — see `LICENSE`.
