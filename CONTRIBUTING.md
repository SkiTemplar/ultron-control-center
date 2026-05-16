<div align="center">

<h1>Contributing to ULTRON</h1>

<p><b>Thanks for considering a contribution.</b><br/>
ULTRON is a small project with a strong opinion about how it should be built.<br/>
Please read this before opening a PR.</p>

<p>
  <a href="README.md">README (English)</a>
  &middot;
  <a href="README.es.md">README (Espanol)</a>
  &middot;
  <a href="SECURITY.md">Security policy</a>
  &middot;
  <a href="LICENSE">License</a>
</p>

</div>

---

## Setup

```powershell
git clone https://github.com/SkiTemplar/ultron.git
cd ultron

# Python side
uv sync

# Frontend
cd control-center
npm install

# Rust toolchain check
cargo check
```

You will also need the Claude Code CLI installed and authenticated. Codex and Gemini CLIs are optional for most development work.

---

## Branching

| Type | Prefix | Example |
|---|---|---|
| Feature | `feature/<slug>` | `feature/plans-archive-toggle` |
| Bug fix | `fix/<slug>` | `fix/clipboard-spawn-flag` |
| Docs | `docs/<slug>` | `docs/install-troubleshooting` |

Target branch is always `main`.

> [!WARNING]
> No force-pushes to `main`. If you need to rewrite history, do it on your own feature branch only.

---

## Commits

- Imperative mood. "Add X", not "Added X" or "Adds X".
- Scope prefix from a small allowed set: `feat`, `fix`, `chore`, `docs`, `refactor`, `test`.
- Example: `feat(plans): add archive-on-resolve toggle`.

Co-author trailers attributing Claude or other AI assistants are **encouraged for transparency**, but never required from external contributors.

---

## Code style

| Language | Tooling | Rule |
|---|---|---|
| **Python** | `ruff` | CI rejects unformatted code |
| **Rust** | `cargo fmt` + `cargo clippy --all-targets` | Warnings are errors under `src-tauri/` |
| **TypeScript** | `tsc --strict` | No `any` without a justifying comment |

A pre-commit hook runs the relevant subset of these on staged files. Install it with `uv run pre-commit install` (or accept the offer from `install.ps1`).

---

## Pull request requirements

Before requesting review, your branch must pass:

```powershell
# From control-center/src-tauri/
cargo check --release

# From control-center/
npx tsc --noEmit

# From repo root, if any Python file changed
uv run pytest
```

CI runs the same three checks. Failing CI blocks merge.

**PR description checklist.**

- [ ] One-sentence user-visible change at the top.
- [ ] Link the spec under `plans/specs/` if one exists.
- [ ] Mention any behavior change that affects existing users' `~/.ultron/` data.
- [ ] List any new dependency (Python, npm or Cargo).

---

## Out of scope

Some changes will be declined regardless of code quality.

> [!IMPORTANT]
> Read this section **before** writing code if your idea touches any of the topics below.

| Will be declined | Why |
|---|---|
| Anything requiring a paid API key | ULTRON is subscription-only by design. Claude, Codex and Gemini are reached through their CLIs. |
| Personal data, hard-coded user paths, or persona names from a single vault | Use generic identifiers and read paths from config. |
| Telemetry, analytics or silent outbound calls | All network I/O must be initiated by an explicit user action. |
| Features that require Docker | ULTRON dropped Docker in v15.0.2 in favor of the native Qdrant binary. Do not reintroduce. |

If you are unsure whether your idea is in scope, **open a discussion or a draft issue before writing the code**.

---

<div align="center">
<sub>Thanks for keeping ULTRON small, fast and honest.</sub>
</div>
