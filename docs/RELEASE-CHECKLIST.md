# Release Checklist

Pre-tag checklist for ULTRON Control Center. Run every item in this list
before pushing a `v*.*.*` tag — the tag triggers the public-release workflow
in `.github/workflows/release.yml` and there is no manual override to take it
back without breaking the auto-updater for whoever caught the mid-flight
download. Per the release-cadence policy in `RELEASE-PROCESS.md`, a tag is
only cut at a **stable milestone**: bugs fixed, features verified across at
least one real session, docs updated.

The operator-facing flow (signing setup, version bumps, post-tag verification)
lives in [`RELEASE-PROCESS.md`](RELEASE-PROCESS.md). This document is the gate
that runs **before** it.

---

## Pre-flight (every release)

- [ ] Clean working tree on `main`. `git status` reports nothing.
- [ ] CI green on the latest `main` commit (cargo + tsc + pytest matrix on
      `windows-latest` and `ubuntu-22.04`).
- [ ] `uv run python scripts/cockpit/doctor.py --quiet` exits 0 (or 1 with a
      reviewed warning).
- [ ] `uv run python scripts/cockpit/version_propagate.py --check` exits 0 —
      the three version files (`control-center/package.json`,
      `control-center/src-tauri/Cargo.toml`,
      `control-center/src-tauri/tauri.conf.json`) agree on the next tag.

## Version + changelog

- [ ] Bump the three version files in lockstep. Easiest path:
      `./scripts/cut-release.ps1 -NewVersion vX.Y.Z -DryRun` first, then
      without `-DryRun`.
- [ ] `CHANGELOG.md`: add a new section at the top with **Added / Fixed /
      Changed** subheadings. Reference plan specs by path where relevant
      (`plans/specs/...`).
- [ ] Cross-check the SSOT version in `SYSTEM-MAP.md` line 9.

## Docs

- [ ] README.md version badge matches the tag being cut
      (`img.shields.io/badge/version-vX.Y.Z-...`).
- [ ] README.md "Current stable" paragraph under **Release notes** updated.
- [ ] README.es.md mirror updated (same version, same release-notes prose
      translated).
- [ ] If the release moves files referenced from docs, run a quick link
      sweep — `Grep` for any path that mentions the removed file.

## Manual smoke (the build CI cannot do for you)

- [ ] `cd control-center && npm run tauri build` succeeds locally on the
      release branch (Windows).
- [ ] The resulting installer launches; the version under **Settings → About**
      matches the tag.
- [ ] Open the Dashboard and run **Full diagnostic** — all rows green / amber
      with documented reasons.
- [ ] If Linux changed at all this cycle: re-run the Linux CI leg and, if you
      have access to a Debian/Ubuntu box, install the `.deb` / `.AppImage` and
      launch it. Open an issue with the result.
- [ ] Auto-updater dry-run: from an older installed version on a separate
      box, confirm the update prompt appears on next launch (no install yet —
      that happens post-tag in `RELEASE-PROCESS.md` step 1.6).

## Security + secrets

- [ ] No new `.env`, `*-secret*`, `*credentials*` paths checked in. The deny
      list in `templates/settings-hooks.json` is defence-in-depth, not the
      primary gate.
- [ ] `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
      still resolve in GitHub repo secrets (Settings → Secrets and variables
      → Actions). Without them, the release workflow signs nothing and the
      auto-updater refuses every install.

## Commit + tag

- [ ] One commit per logical change. The release commit itself follows the
      conventional format: `release: vX.Y.Z`.
- [ ] Tag the release commit with the version *only* once every item above is
      ticked: `git tag -a vX.Y.Z -m "ULTRON Control Center vX.Y.Z"`.
- [ ] Push the tag and watch the workflow in
      [`RELEASE-PROCESS.md §1.5`](RELEASE-PROCESS.md).

---

If any item is unchecked, **do not push the tag**. The release-cadence policy
exists exactly so that the public version stays on a known-good build until
the next milestone is ready; intermediate work commits the version bump but
holds the tag.
