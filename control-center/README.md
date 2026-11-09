# ULTRON Control Center

## Overview

This is the desktop Control Center for ULTRON. It bundles a Tauri 2 / React 19 /
TypeScript / Tailwind v4 stack into a multi-tab panel that drives the cockpit
scripts under `~/.ultron/scripts/`.

## Develop

```powershell
npm install
npm run tauri dev
```

Hot-reload runs against the local cockpit. The Rust backend recompiles on save;
the React frontend uses Vite HMR.

## Build

Close the running app first: while `control-center.exe` is open the Rust
binary cannot be relinked and the build keeps the old executable.

```powershell
npm run build:local   # desktop build for this machine (adds Finance when its sources exist)
npm run build:app     # public build, without Finance
```

`build:local` (`scripts/build-local.mjs`) sets `VITE_FINANCE=1` and passes
`--features finance` to `tauri build` only when the gitignored Finance sources
are present; otherwise it falls back to the public build. Both scripts close a
running instance before building. `tauri.conf.json` keeps
`bundle.targets = ["app"]`, so local builds produce the executable under
`src-tauri/target/release/` without installers.

Public releases start with `../scripts/cut-release.ps1`, which pushes a `v*.*.*`
tag; `.github/workflows/release.yml` runs on that tag and builds the installers
per platform (NSIS + MSI on Windows, `.deb` + AppImage on Linux). The auto-updater stays off
(`plugins.updater.active: false`). See `../docs/RELEASE-PROCESS.md` for the
operator-facing flow.

## Where things live

| Layer | Path |
|---|---|
| Rust backend: Tauri command wrappers | `src-tauri/src/commands/` |
| Rust backend: command registry (`generate_handler!`) | `src-tauri/src/handlers.rs` |
| React components (one `.tsx` per tab) | `src/components/` |
| Tauri IPC | `invoke` from `@tauri-apps/api/core`, called directly in components or through small per-domain wrappers in `src/lib/*` (for example `library-client.ts`, `button-prompts.ts`, `paths.ts`); event helpers in `src/lib/tauri-events.ts` |
| Shared TS types mirroring Rust structs | `src/types/*.ts`, re-exported by `src/types.ts` |

## Where to add a new tab

See the **Where to add what** table in
[`../CONTRIBUTING.md`](../CONTRIBUTING.md#where-to-add-what). The short version:
new component under `src/components/<Name>.tsx`, register it in
`src/components/Sidebar.tsx` (the `Tab` union + `SECTIONS`), then render it from
`App.tsx`. Tauri commands follow the `*_inner` domain + thin wrapper split
described in the same table.
