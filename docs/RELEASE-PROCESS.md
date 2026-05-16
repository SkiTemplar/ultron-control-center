# Release Process

Step-by-step for cutting a public release of ULTRON Control Center. This is
the operational counterpart to `docs/RELEASE-CHECKLIST-v15.2.md`. Run the
checklist first, then follow this document to actually ship the bits.

Every public release flows through GitHub Actions. There is no manual upload
of installer artifacts to the GitHub Releases page — pushing a `v*.*.*` tag
is the single trigger.

---

## 0. One-time setup (per repository)

Performed once by the repository owner. Skip if your fork already has the
signing key wired up.

### 0.1 Generate the Tauri updater signing keypair

The auto-updater plugin requires a signed manifest. Generate a keypair on a
trusted local machine — never on a CI runner:

```powershell
cd control-center
npx tauri signer generate -w ~/.tauri/ultron-updater.key
```

The command produces two files:

- `~/.tauri/ultron-updater.key`        — private key, NEVER commit.
- `~/.tauri/ultron-updater.key.pub`    — public key, safe to embed.

You will be prompted for a passphrase. Store both the passphrase and the
private key in a password manager. If the key is lost you cannot publish
updates that existing installs will trust — users would have to reinstall
manually.

### 0.2 Embed the public key in tauri.conf.json

Open `control-center/src-tauri/tauri.conf.json` and replace the literal
string `<TAURI_PUBKEY_HERE>` under `plugins.updater.pubkey` with the contents
of `ultron-updater.key.pub` (a single line beginning with
`untrusted comment: minisign public key ...` followed by the base64 blob —
paste only the base64 blob, not the comment line).

Commit and push this change. The public key is not a secret.

### 0.3 Replace the repo owner placeholder

Search the repository for the literal `SkiTemplar` placeholder and replace it
with the GitHub user or org that hosts the public repo. The placeholder
appears in (at minimum):

- `control-center/src-tauri/tauri.conf.json`  (updater endpoint URL)
- `docs/download.html`                        (download button href)
- `docs/RELEASE-PROCESS.md`                   (this file, example URLs)

Commit and push.

### 0.4 Add the private key to GitHub repo secrets

In the GitHub web UI:

1. Repository -> Settings -> Secrets and variables -> Actions -> New repository secret.
2. Name: `TAURI_SIGNING_PRIVATE_KEY`. Value: the full contents of
   `~/.tauri/ultron-updater.key` (including the `untrusted comment:` header
   line). Save.
3. New repository secret. Name: `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Value:
   the passphrase chosen in step 0.1. Save.

These secrets are consumed by `.github/workflows/release.yml`. They are
never echoed in logs and are not exposed to forks.

---

## 1. Per-release flow

### 1.1 Run the release checklist

Walk through every item in `docs/RELEASE-CHECKLIST-v15.2.md`. Do not proceed
until every box is ticked.

### 1.2 Bump version numbers

Three files must agree:

| File                                              | Field      |
| ------------------------------------------------- | ---------- |
| `control-center/package.json`                     | `version`  |
| `control-center/src-tauri/Cargo.toml`             | `version`  |
| `control-center/src-tauri/tauri.conf.json`        | `version`  |

The helper script does this automatically:

```powershell
./scripts/cut-release.ps1 -NewVersion v15.2.1
```

Pass `-DryRun` to see what the script would do without writing or pushing.

### 1.3 Update CHANGELOG.md

Add a new section at the top of `CHANGELOG.md`:

```markdown
## v15.2.1 - 2026-MM-DD

### Added
- ...

### Fixed
- ...

### Changed
- ...
```

Keep the entries short and user-facing. Reference plan specs by path where
relevant (e.g. `plans/specs/2026-05-13-entrega-memoria-design.md`).

### 1.4 Commit and tag

The helper script handles the tag. If you are doing it by hand:

```powershell
git add control-center/package.json `
        control-center/src-tauri/Cargo.toml `
        control-center/src-tauri/tauri.conf.json `
        CHANGELOG.md
git commit -m "release: v15.2.1"
git tag -a v15.2.1 -m "ULTRON Control Center v15.2.1"
git push
git push --tags
```

### 1.5 Watch GitHub Actions

Open the repository's Actions tab. The `release` workflow starts within a
few seconds of the tag push. A successful run:

- Installs Node 22 and the stable Rust toolchain on `windows-latest`.
- Runs `npm ci` inside `control-center/`.
- Invokes `tauri-action`, which runs `npm run tauri build`, signs the
  installer with `TAURI_SIGNING_PRIVATE_KEY`, generates `latest.json`, and
  creates the GitHub Release.

Typical runtime on a free-tier runner: 12 to 25 minutes for a cold cache,
6 to 10 minutes with `swatinem/rust-cache` warm.

### 1.6 Verify the release

When the workflow goes green:

1. Open the GitHub Releases page. Confirm the release exists with both the
   installer (`.exe` and / or `.msi`) and `latest.json` attached.
2. Download the installer on a clean Windows 11 VM and install it. Confirm
   Windows SmartScreen warns (expected with a self-signed build) and that
   "Run anyway" produces a working install.
3. Launch the app, open Settings -> About, and confirm the displayed
   version matches the tag.
4. From an older installed version, confirm the auto-updater prompts on
   next launch and successfully installs the new build.

### 1.7 Announce

Drop the GitHub Release URL into whichever channel(s) you use to announce
versions. The auto-updater takes care of existing installs the next time
they open.

---

## Auto-updater behaviour

Once `plugins.updater` is wired up in `tauri.conf.json` and the front-end
calls `check_for_update` (see `control-center/src-tauri/src/lib.rs` wiring
notes in the v15.2.0 release commit), every install with the matching public
key will:

1. Hit the `endpoints[0]` URL on startup (configurable in Settings).
2. Compare the remote version in `latest.json` against the local version.
3. If newer, prompt the user and on confirmation download + install
   (`installMode: passive` means a brief installer flash, no full UI).

Because the `latest.json` URL points at
`https://github.com/SkiTemplar/ultron/releases/latest/download/latest.json`,
GitHub always redirects to the most recent release. There is no manifest
hosting service to maintain.

---

## Rollback

If a release ships a regression:

1. Mark the bad release as a pre-release in the GitHub UI. Pre-releases are
   excluded from the `/releases/latest` redirect, which immediately points
   the updater at the previous good version.
2. Cut a patch release with the fix (e.g. v15.2.1 -> v15.2.2).
3. Existing installs on the bad version will auto-update to the patch on
   next launch.

Do not delete a published release. Deletion breaks the auto-updater for
anyone caught mid-download and removes the audit trail.
