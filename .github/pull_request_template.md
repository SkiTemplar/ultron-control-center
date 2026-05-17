<!--
ULTRON PR template — adapt and delete what doesn't apply.
Small PRs merge faster than large ones. Aim for one logical change per PR.
-->

## Summary

<!-- 1-3 sentences. WHY this change, not WHAT (the diff shows the what). -->

## Scope

- [ ] Bug fix
- [ ] New feature
- [ ] Refactor / cleanup (no behaviour change)
- [ ] Docs only
- [ ] CI / build / release plumbing

## Versioning

- [ ] I bumped `package.json`, `src-tauri/tauri.conf.json`, AND `src-tauri/Cargo.toml` together
- [ ] No version bump needed (docs / CI / non-shipping change)

## Verification

How did you test this? Be specific.

- [ ] `cargo test --lib` (Rust unit tests pass)
- [ ] `npx tsc --noEmit` (TypeScript clean)
- [ ] `npm run tauri build` (Tauri build green)
- [ ] Manual smoke test in the running app — describe what you clicked
- [ ] Tested on a fresh `~/.ultron` (bootstrap or clone)

## Risk

- [ ] Touches the security-scanner / vault-write paths → describe the threat model below
- [ ] Touches the dispatcher / hooks → describe the regression vector
- [ ] Touches the installer / release pipeline → describe how a failed run looks
- [ ] Self-contained, low blast radius

## Notes for the reviewer

<!-- Anything tricky. Where to look first. What you ALMOST did but didn't. -->
