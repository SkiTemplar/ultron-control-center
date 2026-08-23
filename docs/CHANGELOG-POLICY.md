# Changelog Policy

> Effective v15.5.18+. Codified in `scripts/hooks/auto-changelog.py` and
> mirrored in `cockpit/changelog.ndjson` (the source the Control Center
> reads).

## TL;DR

Only **major** (`X.0.0`) and **minor** (`X.Y.0`) versions appear in the
public `CHANGELOG.md` and the Control Center "Changelog" tab. **Patch**
versions (`X.Y.Z` where `Z > 0`) accumulate silently and are folded into
the next minor entry.

## Why

- Patches in this repo are frequent (sometimes 5+ per day during a
  burn-down). Per-patch entries drown the signal under commit-message-level
  noise and force the user to read the GitHub Release page like a git log.
- The user wants a concise, user-facing summary per minor: "Errores
  corregidos: A, B, C. Anadido: D, E, F." - not a wall of `feat(v15.5.X):`
  envelopes.
- Patch tags are still useful for bisecting and tracking installer
  contents, so we keep them in git history and `pyproject.toml` /
  `tauri.conf.json` / `Cargo.toml`. They just don't show up as their own
  CHANGELOG section.

## Bump criteria — choosing patch / minor / major

`auto-changelog.py` *classifies* a bump from the version token, but a
human picks the number first. ULTRON is a tool, not a library with a
public API contract, so the criteria measure the **size and impact** of
the change, not API compatibility.

| Bump                        | When                                                                                                                                            | Examples                                                                                  |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| **Patch** (`X.Y.Z`, `Z++`)  | One micro change: a single bug fix, a small adjustment, a doc tweak, a config correction. Self-contained, low risk.                              | Fix a failing test · correct a hook typo · adjust one threshold · repair a broken link    |
| **Minor** (`X.Y.0`, `Y++`)  | A larger change, or an accumulated series of micro changes that together form something coherent for the user. Stays backward-usable.            | Add a Control Center panel · ship a new skill or agent · close a burn-down of 10+ patches |
| **Major** (`X.0.0`, `X++`)  | A large change or overhaul: architectural rework, a breaking change to the install/config layout, a milestone that redefines how the system works. | New memory architecture · cross-platform support · a release that forces a reinstall      |

Tie-breakers:

- Patch vs minor: if the work accumulated since the last `X.Y.0` already
  tells a coherent user-facing story, cut a minor. A lone fix stays a patch.
- Minor vs major: ask "does an existing user have to *do* something
  (reinstall, migrate, relearn)?" If yes, it is major.
- The version-number bump lands in the commit; pushing the **tag** is a
  separate, deliberate act gated on a stable milestone — see
  `docs/RELEASE-PROCESS.md` for the cadence rule.

## Bump matrix

| Bump kind | Example                     | CHANGELOG action                                                         |
| --------- | --------------------------- | ------------------------------------------------------------------------ |
| Major     | `v15.5.18 → v16.0.0`        | Drain rolling buffer, write one entry titled `v16.0.0`, reset.           |
| Minor     | `v15.5.18 → v15.6.0`        | Drain rolling buffer, write one entry titled `v15.6.0`, reset.           |
| Patch     | `v15.5.18 → v15.5.19`       | Append commit subjects to rolling buffer. NOTHING is written publicly.  |

The rolling buffer lives at `~/.ultron/.tmp/pending-patches.jsonl`. It is
gitignored - if the file is lost, the next minor reads from git history
back to the previous minor tag instead.

## Entry format

Every minor/major entry follows this shape (Spanish per the user's
preference, succinct, no internal-change noise, no personal names):

```markdown
<!-- vX.Y.0 -->
## vX.Y.0 - YYYY-MM-DD (acumula vX.Y.1..vX.Y.N)

Errores corregidos:
- Short one-liner per fix
- Another one-liner

Anadido:
- Short one-liner per addition
- Another one-liner
```

Rules:

- One line per item, ≤120 characters.
- No author names (the maintainer, contributor handles).
- No commit SHAs, branch names, or PR numbers.
- No internal-implementation chatter ("inlined the helper", "renamed
  the var") - users don't read those.
- Drop `chore`, `release`, `merge`, `revert` commit subjects entirely.

## What the hook does

`scripts/hooks/auto-changelog.py` is a Stop hook (Claude Code lifecycle):

1. Detect a `v\d+\.\d+\.\d+` token in the most recent 10 commit subjects.
2. Classify as major / minor / patch.
3. **Patch** → append to `~/.ultron/.tmp/pending-patches.jsonl` and exit
   silently. CHANGELOG.md is NOT touched.
4. **Minor / major** → drain the rolling buffer, aggregate every fix and
   addition (deduped by line), and prepend one section to CHANGELOG.md
   plus mirror to `cockpit/changelog.ndjson` for the Control Center UI.
5. Gate: only fires on HIGH/ULTRA session modes (the same gate the hook
   has had since v15.5.14 - prevents per-Stop git-log overhead on
   MEDIUM/LOW).

Idempotency: each minor/major version is guarded by a `<!-- vX.Y.0 -->`
anchor. The hook is safe to re-fire on the same commit.

## Manual override

If a milestone needs human-curated prose (the v15.5.0 / v15.4.0 entries
are good examples), the maintainer can:

1. Edit `CHANGELOG.md` manually before the bump commit lands.
2. The hook detects the anchor and exits silently - no clobber.

The hook is additive, never destructive.

## How to compose a minor by hand

When the rolling buffer is wrong (e.g. the buffer was lost, or a patch
landed without going through the hook), regenerate the buffer from git:

```bash
git log --pretty=format:%s v15.4.21..HEAD | tail -r > /tmp/subjects.txt
# Edit /tmp/subjects.txt to drop noise, then split into fixes/adds.
```

Then write the CHANGELOG entry following the format above. The next
minor bump will see the anchor and skip.

## Migration notes (v15.5.18)

The v15.5.0 entry currently in `CHANGELOG.md` was hand-aggregated as part
of the v15.5.18 policy rollout: every patch from v15.5.1 through v15.5.18
was folded into one section. Subsequent minor bumps will use the hook's
automatic aggregation.

## See also

- `scripts/hooks/auto-changelog.py` - implementation.
- `docs/RELEASE-PROCESS.md` - how a tag becomes a public release.
- `docs/RELEASE-CHECKLIST.md` - per-release pre-flight.
- `~/.ultron/cockpit/changelog.ndjson` - mirror that the Control Center
  "Changelog" tab renders.
