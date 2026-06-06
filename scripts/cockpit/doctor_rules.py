"""doctor_rules — rules loader for ULTRON Doctor.

Loads ~/.ultron/config/doctor-rules.yaml (or an alternate path), merges
it over the built-in defaults, and exposes ``load_rules()``.

No dependencies on other doctor_* modules — importable in isolation.
"""
from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

ULTRON_HOME = Path(os.environ.get("USERPROFILE", os.path.expanduser("~"))) / ".ultron"
DOCTOR_RULES_YAML = ULTRON_HOME / "config" / "doctor-rules.yaml"

# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------

_DEFAULT_RULES: dict[str, Any] = {
    "retention": {
        "session_logs_days": 30,
        "backups_days": 90,
        "telemetry_days": 180,
        "alerts_max_size_mb": 10,
    },
    "staleness": {
        "l0_max_hours": 4,
        "ztmsi_max_hours": 4,
    },
    "thresholds": {
        "token_overhead_tokens": 1500,
    },
    "auto_doctor": False,
}

# ---------------------------------------------------------------------------
# YAML parsing helpers
# ---------------------------------------------------------------------------

_RULES_SCALAR_RE = re.compile(r"^([A-Za-z0-9_]+)\s*:\s*(.*?)\s*$")


def _coerce_scalar(value: str) -> Any:
    """Coerce a YAML scalar string to int/float/bool/None/string."""
    v = value.strip()
    if not v:
        return None
    low = v.lower()
    if low in ("null", "~"):
        return None
    if low == "true":
        return True
    if low == "false":
        return False
    if (v.startswith('"') and v.endswith('"')) or (
        v.startswith("'") and v.endswith("'")
    ):
        return v[1:-1]
    try:
        if "." in v:
            return float(v)
        return int(v)
    except ValueError:
        return v


def _parse_rules_yaml_fallback(text: str) -> dict[str, Any]:
    """Tiny stdlib parser tuned for the doctor-rules.yaml schema.

    Only supports the exact shape we ship: a top-level mapping with
    optional nested mappings (one level deep) of scalar values.
    Indentation is two spaces. Lines starting with # are comments.
    """
    out: dict[str, Any] = {}
    current_section: str | None = None
    for raw in text.splitlines():
        line = raw.rstrip("\n")
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        indent = len(line) - len(line.lstrip(" "))
        if indent == 0:
            if stripped.endswith(":"):
                key = stripped[:-1].strip()
                out[key] = {}
                current_section = key
                continue
            m = _RULES_SCALAR_RE.match(stripped)
            if m:
                out[m.group(1)] = _coerce_scalar(m.group(2))
                current_section = None
            continue
        if current_section is None:
            continue
        m = _RULES_SCALAR_RE.match(stripped)
        if m:
            section_dict = out.setdefault(current_section, {})
            if isinstance(section_dict, dict):
                section_dict[m.group(1)] = _coerce_scalar(m.group(2))
    return out


def _deep_merge(base: dict[str, Any], override: dict[str, Any]) -> dict[str, Any]:
    """Merge override into a copy of base — recursive on dict values only."""
    out = dict(base)
    for k, v in override.items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _deep_merge(out[k], v)
        else:
            out[k] = v
    return out


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def load_rules(path: Path = DOCTOR_RULES_YAML) -> dict[str, Any]:
    """Return the merged rules dict (defaults + user overrides from *path*).

    Args:
        path: Path to doctor-rules.yaml (or alternate). If missing or
              unreadable the built-in defaults are returned unchanged.

    Returns:
        A dict that is a deep-merge of ``_DEFAULT_RULES`` and any user
        overrides found at *path*.
    """
    if not path.exists():
        return dict(_DEFAULT_RULES)
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return dict(_DEFAULT_RULES)
    parsed: dict[str, Any]
    try:
        import yaml  # type: ignore[import-not-found]

        loaded = yaml.safe_load(text)
        parsed = loaded if isinstance(loaded, dict) else {}
    except ImportError:
        parsed = _parse_rules_yaml_fallback(text)
    except Exception:  # noqa: BLE001
        parsed = {}
    return _deep_merge(_DEFAULT_RULES, parsed)
