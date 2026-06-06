"""ULTRON v14 Sprint 5 Sub-pilar B -- Doctor CLI v2.

Inspect the live ULTRON installation and surface drift, orphaned data,
stale caches, retention violations, blocking alerts, and token-overhead
regressions. The doctor only PROPOSES -- it never deletes or rewrites
anything unless the user explicitly accepts a fix via ``--fix`` (which
prompts y/N for each finding individually).

DESIGN INVARIANTS
-----------------
1. **Read-mostly.** Default mode (and ``--dry-run``) never writes outside
   ``~/.ultron/.tmp/`` log/state files.
2. **Pure stdlib + optional yaml.** Same fallback contract as
   ``skill_manifest.py`` / ``mcp_health_check.py``.
3. **Silent on --quiet.** Hooks/cron call us with ``--quiet --json``;
   no stdout chatter, only exit codes + the JSON file.
4. **Bounded runtime.** All detections short-circuit at limits so a
   clean setup completes in well under 2 seconds.
5. **Atomic writes.** Anything we persist uses tmp + flush + fsync + os.replace.
6. **Subprocess hygiene.** When ``--fix`` runs a command it's via
   ``silent_exec.silent_run`` -- no popup windows on Windows.

EXIT CODES
----------
- 0 : no findings, or only ``info`` findings, or ``--fix`` applied >=1 fix
- 1 : at least one ``warn`` finding (no blockings)
- 2 : at least one ``blocking`` finding

CLI
---
  uv run python doctor.py                    full report
  uv run python doctor.py --fix              interactive per-finding y/N
  uv run python doctor.py --dry-run          alias for default mode
  uv run python doctor.py --json             machine-readable output
  uv run python doctor.py --health-check     compact MCP+ZTMSI+L0 view
  uv run python doctor.py --token-audit      E1 gate: always-on overhead
  uv run python doctor.py --quiet            no stdout, exit code only
  uv run python doctor.py --security         S5-C security detectors only

MODULE LAYOUT (post-split)
--------------------------
doctor.py           -- this file: entrypoint + public re-exports
doctor_models.py    -- Finding, Report, severity constants, shared helpers
doctor_rules.py     -- rules loader (doctor-rules.yaml + defaults)
doctor_checks.py    -- all _check_* detection functions
doctor_reporters.py -- format_human, format_health_check, format_token_audit
doctor_core.py      -- orchestration (run_all_detections), fix workflow, CLI
"""
from __future__ import annotations

import sys
from pathlib import Path

# Ensure the cockpit directory is on sys.path regardless of invocation style.
_COCKPIT_DIR = Path(__file__).resolve().parent
if str(_COCKPIT_DIR) not in sys.path:
    sys.path.insert(0, str(_COCKPIT_DIR))

# ---------------------------------------------------------------------------
# Public API re-exports
# Keep these stable: external callers (health.py, alerts.py, hooks, tests)
# import from ``doctor`` directly and must continue to work unchanged.
# ---------------------------------------------------------------------------

from doctor_models import (  # noqa: E402, F401
    SEVERITY_BLOCKING,
    SEVERITY_INFO,
    SEVERITY_WARN,
    VALID_CATEGORIES,
    Finding,
    Report,
    _append_jsonl,
    _atomic_write_text,
    _dir_size_bytes,
    _file_age_days,
    _file_age_hours,
    _humanize_bytes,
    _now_utc_iso,
    _path_size_bytes,
)

from doctor_rules import (  # noqa: E402, F401
    DOCTOR_RULES_YAML,
    load_rules,
)

from doctor_checks import (  # noqa: E402, F401
    _ALL_DETECTORS,
    _SECURITY_DETECTORS,
    measure_token_overhead,
)

from doctor_reporters import (  # noqa: E402, F401
    format_health_check,
    format_human,
    format_token_audit,
)

from doctor_core import (  # noqa: E402, F401
    apply_fixes_interactively,
    main,
    run_all_detections,
)

# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    raise SystemExit(main())
