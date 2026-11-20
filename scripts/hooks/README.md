# scripts/hooks

This folder is **not** where the Claude Code hooks live. It only holds
`auto-changelog.py`, which the git `post-commit` hook (`git-hooks/post-commit`,
installed by `scripts/setup-git-hooks.ps1`) runs after every commit. It is not
registered in `~/.claude/settings.json`.

## Claude Code hooks

They live in `hooks/scripts/*.js` and run in place from `~/.ultron/hooks/scripts/`.
See [`../../hooks/README.md`](../../hooks/README.md) for the live inventory.

Single source of truth: `~/.claude/settings.json`. `node hooks/regen-manifest.js`
mirrors it into `hooks/manifest.json` (checksums, writer path, description) and
into `templates/settings-hooks.json`, the template that `install.ps1` /
`install.sh` merge into a fresh install (the token `{USERPROFILE}` expands to the
user's home, forward-slash form). `node hooks/regen-manifest.js --check` fails
on drift and runs in pre-commit; `tests/test_hooks_template.py` (CI job
`python-tests`) checks that the template only references scripts in the repo.

## Test a hook locally

```bash
echo '{"hook_event_name":"PreToolUse","tool_name":"Read","tool_input":{"file_path":"test.txt"}}' \
  | node ~/.ultron/hooks/scripts/deny-secrets.js
```

## References

- [Hooks reference (Claude Code)](https://code.claude.com/docs/en/hooks)
