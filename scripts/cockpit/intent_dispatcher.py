"""
intent_dispatcher.py — importable shim for intent-dispatcher hook.

The hook lives at hooks/intent-dispatcher.py (hyphen in filename prevents
direct import). This module loads it via importlib and exposes dispatch_intent()
as a structured Python API for tests and cockpit tooling.

Returns:
  {"routes": [{"skill": str, "confidence": float}], "line": str}
  "routes" is empty if confidence < 0.70 or no match found.
"""
from __future__ import annotations

import importlib.util
import re
from pathlib import Path

_HOOK_PATH = Path.home() / ".ultron" / "scripts" / "hooks" / "intent-dispatcher.py"

_hook_module = None


def _load_hook():
    global _hook_module
    if _hook_module is not None:
        return _hook_module
    spec = importlib.util.spec_from_file_location("intent_dispatcher_hook", _HOOK_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    _hook_module = mod
    return mod


# e.g. [ULTRON·85%] skill=terry-davis | ctx=some/path (123tok) | via=rules
_LINE_RE = re.compile(r"\[ULTRON·(\d+)%\]\s+skill=(\S+)\s+\|")


def dispatch_intent(query: str) -> dict:
    """Dispatch a query and return structured routing result.

    Calls the hook's dispatch() directly in-process (no subprocess, no stdin).
    Returns {"routes": [...], "line": str} where each route has "skill" and
    "confidence" keys.
    """
    try:
        hook = _load_hook()
        line: str = hook.dispatch(query)
    except Exception:
        return {"routes": [], "line": ""}

    if not line:
        return {"routes": [], "line": ""}

    m = _LINE_RE.search(line)
    if not m:
        return {"routes": [], "line": line}

    pct_str, skill_str = m.group(1), m.group(2)
    confidence = int(pct_str) / 100.0

    return {
        "routes": [{"skill": skill_str, "confidence": confidence}],
        "line": line,
    }
