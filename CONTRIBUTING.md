# Contributing to ULTRON

Thanks for considering a contribution. ULTRON is a small project with a strong
opinion about how it should be built, so please read this before opening a PR.

## Setup

```powershell
git clone https://github.com/<owner>/ultron.git
cd ultron

# Python side
uv sync

# Frontend
cd control-center
npm install

# Rust toolchain check
cargo check
```

You will also need the Claude Code CLI installed and authenticated. Codex and
Gemini CLIs are optional for most development work.

## Branching

- Feature branches: `feature/<short-slug>`.
- Bug fixes: `fix/<short-slug>`.
- Documentation: `docs/<short-slug>`.
- Target branch is always `main`. **No force-pushes to `main`.** If you need to
  rewrite history, do it on your own feature branch only.

## Commits

- Imperative mood. "Add X", not "Added X" or "Adds X".
- Scope prefix from a small allowed set: `feat`, `fix`, `chore`, `docs`,
  `refactor`, `test`.
- Example: `feat(plans): add archive-on-resolve toggle`.
- Co-author trailers attributing Claude or other AI assistants are encouraged
  for transparency, but never required from external contributors.

## Code style

- **Python**: `ruff` for lint and format. CI will reject unformatted code.
- **Rust**: `cargo fmt` and `cargo clippy --all-targets`. Treat warnings as
  errors in `src-tauri/`.
- **TypeScript**: `tsc` strict mode. No `any` without a justifying comment.
- A pre-commit hook runs the relevant subset of these on staged files. Install
  it with `uv run pre-commit install` (or accept the offer from
  `scripts/install.ps1`).

## Pull request requirements

Before requesting review, your branch must pass:

- `cargo check --release` from `control-center/src-tauri/`.
- `npx tsc --noEmit` from `control-center/`.
- `uv run pytest` from the repo root, if any Python file changed.

CI runs the same three checks. Failing CI will block merge.

PR descriptions should state the user-visible change in one sentence, link
the spec under `plans/specs/` if one exists, and mention any behavior change
that affects existing users' `~/.ultron/` data.

## Out of scope

Some changes will be declined regardless of code quality:

- Anything that requires a paid API key. ULTRON is subscription-only by design;
  Claude, Codex, and Gemini are all reached through their respective CLIs.
- Anything that ships personal data, hard-coded user paths, or persona names
  out of one user's vault. Use generic identifiers and read paths from config.
- Telemetry, analytics, or any silent outbound network call. All network I/O
  must be initiated by an explicit user action.
- Features that require Docker. ULTRON dropped Docker in v15.0.2 in favor of
  the native Qdrant binary; do not reintroduce it.

If you are unsure whether your idea is in scope, open a discussion or a draft
issue before writing the code.
