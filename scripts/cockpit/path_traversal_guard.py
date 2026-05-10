"""ULTRON v14 Sprint 5-C — Path Traversal Guard.

Helper for any cockpit script that takes user-supplied paths. Resolves
the candidate under a known base and rejects anything that escapes (via
``..``, absolute drift, symlink, NUL byte, etc.).

USAGE
-----
    from path_traversal_guard import safe_resolve, PathTraversalError
    target = safe_resolve(user_input, base=Path.home() / ".ultron")
    target.write_text(...)

DESIGN INVARIANTS
-----------------
1. Reject NUL bytes in the input.
2. Reject inputs whose resolved path is not under `base`.
3. Reject reparse-points/symlinks that point outside `base` (Windows
   junctions included — `Path.resolve(strict=False)` follows them).
4. Path is returned ONLY if it can exist under base — does NOT verify
   the file already exists; callers do that.
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Union

PathLike = Union[str, "os.PathLike[str]", Path]


class PathTraversalError(ValueError):
    """Raised when the user-supplied path resolves outside `base`, contains
    NUL bytes, or otherwise fails the safety contract.
    """


def _has_null(s: str) -> bool:
    return "\x00" in s


def safe_resolve(user_path: PathLike, base: PathLike) -> Path:
    """Resolve `user_path` under `base`. Raises PathTraversalError on escape.

    Parameters
    ----------
    user_path : str | os.PathLike
        The candidate path. May be relative or absolute. Absolute paths
        outside `base` are rejected.
    base : str | os.PathLike
        Allowed root. Resolved with strict=False so the base may not yet
        exist on disk (e.g., new tmp dirs).
    """
    if user_path is None:
        raise PathTraversalError("user_path is None")

    user_str = os.fspath(user_path)
    if _has_null(user_str):
        raise PathTraversalError("user_path contains NUL byte")

    base_path = Path(os.fspath(base))
    try:
        base_resolved = base_path.resolve(strict=False)
    except OSError as exc:  # noqa: BLE001
        raise PathTraversalError(f"cannot resolve base: {exc}") from exc

    # Anchor relative inputs under base; absolute inputs MUST already lie
    # under base after resolution.
    candidate = Path(user_str)
    if candidate.is_absolute():
        joined = candidate
    else:
        joined = base_resolved / candidate

    try:
        resolved = joined.resolve(strict=False)
    except OSError as exc:  # noqa: BLE001
        raise PathTraversalError(f"cannot resolve user_path: {exc}") from exc

    # Compare via os.path.commonpath to handle Windows case-insensitivity.
    try:
        common = Path(os.path.commonpath([str(base_resolved), str(resolved)]))
    except ValueError as exc:
        raise PathTraversalError(
            f"path on different drive than base: {resolved}"
        ) from exc

    # Case-insensitive compare on Windows; case-sensitive on POSIX.
    if os.name == "nt":
        if str(common).lower() != str(base_resolved).lower():
            raise PathTraversalError(
                f"path '{resolved}' escapes base '{base_resolved}'"
            )
    else:
        if str(common) != str(base_resolved):
            raise PathTraversalError(
                f"path '{resolved}' escapes base '{base_resolved}'"
            )

    return resolved


__all__ = ["safe_resolve", "PathTraversalError"]
