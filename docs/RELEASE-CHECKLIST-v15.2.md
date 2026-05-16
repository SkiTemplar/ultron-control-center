# Release Checklist — v15.2.0

Operational checklist for cutting the first public release of ULTRON. Run top
to bottom. Do not tag the release until every box is checked.

## Pre-flight

- [ ] Persona-strip script run; `grep -r "C:\\Users\\USER"` returns 0
      matches under `src/`, `src-tauri/`, `scripts/`, `cockpit/`, `docs/`.
- [ ] All persona-named skills renamed to generic role aliases; old names
      remain only as optional aliases in the user's local tree.
- [ ] Secret audit passed on the release branch (no tokens, API keys, OAuth
      blobs, personal email or phone in tracked files or history).
- [ ] `LICENSE` present at repo root, MIT, copyright 2026 USER SURNAME.
- [ ] `README.md` renders correctly in the GitHub preview pane (headings,
      code blocks, tree diagram, table of contents implicit links).
- [ ] `CONTRIBUTING.md` present at repo root.
- [ ] `.gitignore` excludes `personal/`, `cockpit/news/*.html`,
      `brain_index/`, `qdrant_storage/`, `qdrant-native/`, `_legacy/`,
      `archive/`, `backups/`, `multimodel/`, `telemetry/`, `metrics/`,
      `audits/`, `.tmp/`, `alerts.jsonl*`, screenshots at repo root.

## Build verification

- [ ] `cargo check --release` clean from `control-center/src-tauri/`.
- [ ] `cargo clippy --all-targets --release` shows no warnings treated as
      errors.
- [ ] `npx tsc --noEmit` clean from `control-center/`.
- [ ] `uv run pytest` passes from repo root.
- [ ] `npm run tauri build` produces a working installer artifact.

## Install verification

- [ ] `scripts/install.ps1` dry-run on a clean Windows 11 VM with no
      pre-existing `~/.ultron/` succeeds end to end.
- [ ] Smoke test: doctor script reports green, `brain_index update` indexes
      the seed vault, Control Center launches and shows all configured tabs.
- [ ] At least one beta tester (external to the author's machine) confirms
      install works on their own Windows 11 box.

## Release artifacts

- [ ] Auto-updater endpoint configured against the GitHub Releases feed (if
      shipping the Tauri auto-updater plugin in this release).
- [ ] Release notes drafted from the relevant `plans/specs/` files.
- [ ] Tag `v15.2.0` cut on `main` after all prior items are green.
- [ ] GitHub Release published with installer artifact attached and release
      notes pasted in.

## Post-release

- [ ] Announcement message drafted (no urgency, but keep it ready).
- [ ] Issue templates enabled on the repo.
- [ ] Discussions enabled, with a pinned "first install" thread.
