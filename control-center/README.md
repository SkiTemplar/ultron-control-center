# ULTRON Control Center

## Overview

This is the desktop Control Center for ULTRON. It bundles a Tauri 2 / React 19 /
TypeScript / Tailwind v4 stack into a 17-tab panel that drives the cockpit
scripts under `~/.ultron/scripts/`.

## Develop

```powershell
npm install
npm run tauri dev
```

Hot-reload runs against the local cockpit. The Rust backend recompiles on save;
the React frontend uses Vite HMR.

## Build

```powershell
npm run tauri build
```

Produces signed installers under `src-tauri/target/release/bundle/`
(NSIS `.exe` + MSI on Windows; `.deb` + `.AppImage` on Linux). Public releases
are cut by CI via `.github/workflows/release.yml` on every `v*.*.*` tag push —
see `docs/RELEASE-PROCESS.md` for the operator-facing flow.

## Where things live

| Layer | Path |
|---|---|
| Rust backend (domain logic + Tauri commands) | `src-tauri/src/commands/` |
| React components (one `.tsx` per tab) | `src/components/` |
| Tauri IPC bridge (typed wrappers around `invoke`) | `src/lib/tauri.ts` |
| Shared TS types mirroring Rust structs | `src/types.ts` |

## Where to add a new tab

See the **Where to add what** table in
[`../CONTRIBUTING.md`](../CONTRIBUTING.md#where-to-add-what). The short version:
new component under `src/components/<Name>.tsx`, register it in
`src/components/Sidebar.tsx` (the `Tab` union + `SECTIONS`), then render it from
`App.tsx`. Tauri commands follow the `*_inner` domain + thin wrapper split
described in the same table.
