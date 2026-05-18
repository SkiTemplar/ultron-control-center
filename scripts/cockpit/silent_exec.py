"""ULTRON silent subprocess wrapper — Pillar I (no popup windows).

Sprint 1 Pilar A (v13.4.0 SILENT + ALERTS). Policy and rationale documented in
`~/.ultron/docs/silent-execution-policy.md`.

WHY THIS EXISTS
---------------
ULTRON Pillar I = zero terminal flash, ever. Any cockpit script that spawns
a child process via `subprocess.run` / `subprocess.Popen` on Windows can flash
a console window unless `creationflags=CREATE_NO_WINDOW` is explicitly set.
Forgetting that flag is silent — it works in dev, then leaks a popup in
production. This module makes "silent by default" the path of least
resistance for NEW code.

WHEN TO USE
-----------
USE this wrapper in:
- New cockpit scripts (S2-S5 deliverables)
- New hook scripts that shell out
- Any code path the user will invoke during a Claude Code session

DO NOT use this wrapper for (existing patterns are fine, do not migrate):
- `shared-duet.ps1::Start-Hidden` — PowerShell-side helper for Codex/Gemini calls
- `background_tasks.py` — already uses `_WIN_HIDDEN = subprocess.CREATE_NO_WINDOW`
- `job_supervisor.py` — has its own DETACHED_PROCESS / async pattern

POSIX BEHAVIOUR
---------------
On non-Windows the silencing is a no-op passthrough — `creationflags` doesn't
exist there. We still default `capture_output=True` for consistency.

DEBUG OVERRIDE
--------------
Setting the env var `ULTRON_DEBUG=1` disables the silent flags AND lets
stdout/stderr stream to the console — useful when diagnosing a hung child.

PUBLIC API
----------
- `silent_run(cmd, **kwargs) -> CompletedProcess`  drop-in for subprocess.run
- `silent_popen(cmd, **kwargs) -> Popen`           drop-in for subprocess.Popen
"""
from __future__ import annotations

import os
import subprocess
import sys
from typing import Any

__all__ = ["silent_run", "silent_popen", "is_debug", "CREATE_NO_WINDOW"]


# Windows constant for CreateProcess: do not create a console window.
# Defined as 0 on POSIX so the flag merge is a no-op there.
CREATE_NO_WINDOW: int = (
    subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0  # type: ignore[attr-defined]
)


def is_debug() -> bool:
    """True iff ULTRON_DEBUG is set to a truthy value (1/true/yes, case-insensitive)."""
    val = os.environ.get("ULTRON_DEBUG", "").strip().lower()
    return val in {"1", "true", "yes", "on"}


def _apply_silent_defaults(kwargs: dict[str, Any]) -> dict[str, Any]:
    """Mutate kwargs in place so subprocess.* call is silent on Windows.

    **Caller-wins contract:** if the caller passed any of ``creationflags``,
    ``capture_output``, ``stdout`` or ``stderr``, we respect their value
    verbatim — even ``creationflags=0`` (explicit "no flags"). We only add
    CREATE_NO_WINDOW when ``creationflags`` is absent from kwargs.

    When ``ULTRON_DEBUG=1`` we skip everything so the user sees live output.
    """
    if is_debug():
        return kwargs

    if sys.platform == "win32":
        # Caller wins: only set CREATE_NO_WINDOW if absent. creationflags=0
        # explicitly means "I want no flags" and must be honored.
        if "creationflags" not in kwargs:
            kwargs["creationflags"] = CREATE_NO_WINDOW

    # Capture stdout/stderr by default so nothing flashes to a parent console.
    # Do not override if caller has already set any of stdout/stderr/capture_output.
    has_redirect = (
        "capture_output" in kwargs
        or "stdout" in kwargs
        or "stderr" in kwargs
    )
    if not has_redirect:
        kwargs["capture_output"] = True

    return kwargs


def silent_run(cmd: Any, **kwargs: Any) -> subprocess.CompletedProcess:
    """Like ``subprocess.run`` but Windows-silent by default.

    On Windows: adds ``creationflags=CREATE_NO_WINDOW`` and
    ``capture_output=True`` unless the caller already specified those keys.
    POSIX: passthrough plus a default ``capture_output=True``.
    Honors ``ULTRON_DEBUG=1`` — when set, no silencing is applied.

    Caller-passed kwargs always win:
        silent_run(["foo"], capture_output=False)  # caller wins, output streams
        silent_run(["foo"], creationflags=0)       # caller wins, no flag added

    Returns a ``CompletedProcess`` (same as ``subprocess.run``).
    """
    kwargs = _apply_silent_defaults(dict(kwargs))
    return subprocess.run(cmd, **kwargs)


def silent_popen(cmd: Any, **kwargs: Any) -> subprocess.Popen:
    """Like ``subprocess.Popen`` but Windows-silent by default.

    Same caller-wins contract as :func:`silent_run`. ``ULTRON_DEBUG=1``
    disables silencing.

    Special handling: ``Popen`` does NOT accept ``capture_output`` natively
    (unlike ``run``). We translate it for callers' convenience BEFORE the
    debug branch so passing ``capture_output=True`` never reaches Popen and
    raises TypeError:

    - ``capture_output=True``  → ``stdout=PIPE, stderr=PIPE`` (unless caller
      already set stdout/stderr)
    - ``capture_output=False`` / ``None`` → just dropped

    Returns a ``Popen`` (callers manage lifecycle).
    """
    kwargs = dict(kwargs)

    # Translate capture_output → stdout/stderr=PIPE BEFORE any other branch so
    # Popen never sees the unsupported kwarg (regardless of ULTRON_DEBUG).
    # Truthy → translate to PIPE pair (caller's stdout/stderr win if also set);
    # falsy/missing → just drop, nothing to do.
    if kwargs.pop("capture_output", False):
        kwargs.setdefault("stdout", subprocess.PIPE)
        kwargs.setdefault("stderr", subprocess.PIPE)

    if is_debug():
        return subprocess.Popen(cmd, **kwargs)

    if sys.platform == "win32":
        # Caller wins on creationflags: only set CREATE_NO_WINDOW if absent.
        if "creationflags" not in kwargs:
            kwargs["creationflags"] = CREATE_NO_WINDOW

    # Default redirects so the child cannot flash a parent console.
    if "stdout" not in kwargs and "stderr" not in kwargs:
        kwargs["stdout"] = subprocess.PIPE
        kwargs["stderr"] = subprocess.PIPE

    return subprocess.Popen(cmd, **kwargs)
