"""Version drift guard for ULTRON.

The SSOT version lives in ``pyproject.toml`` (``[project].version``). Six other
files repeat that version because their respective tooling (Tauri, Cargo, npm,
PowerShell installers, Bash installer) cannot read pyproject.toml at runtime.
Drift has reopened repeatedly across releases (PLANS item ``ci-version-drift-
guard``); this script is the deterministic check that fails the build on the
first mismatch instead of letting a half-bumped tag ship to users.

Usage::

    uv run python scripts/cockpit/version_propagate.py --check
        # exit 0 if all 7 versions match SSOT, exit 1 otherwise

    uv run python scripts/cockpit/version_propagate.py --print
        # print SSOT version to stdout

Wired into ``.github/workflows/ci.yml`` as the ``version-drift`` job; also
intended to be called from local hooks before tagging a release.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent

# (file, regex-with-named-group "ver", optional v-prefix expected)
# Each pattern captures exactly the version literal so we can compare without
# pulling in toml/yaml libraries.
TARGETS: list[tuple[str, str, bool]] = [
    ("control-center/package.json",
     r'"version"\s*:\s*"(?P<ver>[0-9]+\.[0-9]+\.[0-9]+)"', False),
    ("control-center/src-tauri/Cargo.toml",
     r'^version\s*=\s*"(?P<ver>[0-9]+\.[0-9]+\.[0-9]+)"', False),
    ("control-center/src-tauri/tauri.conf.json",
     r'"version"\s*:\s*"(?P<ver>[0-9]+\.[0-9]+\.[0-9]+)"', False),
    ("install.ps1",
     r'\$Script:VersionFallback\s*=\s*"v(?P<ver>[0-9]+\.[0-9]+\.[0-9]+)"', True),
    ("scripts/cockpit/install-wizard.ps1",
     r'\[string\]\$Version\s*=\s*"v(?P<ver>[0-9]+\.[0-9]+\.[0-9]+)"', True),
    ("install.sh",
     r'readonly\s+ULTRON_VERSION="v(?P<ver>[0-9]+\.[0-9]+\.[0-9]+)"', True),
]

SSOT_FILE = "pyproject.toml"
SSOT_PATTERN = re.compile(r'^version\s*=\s*"(?P<ver>[0-9]+\.[0-9]+\.[0-9]+)"', re.MULTILINE)


def read_ssot() -> str:
    """Return the version string from pyproject.toml [project].version."""
    text = (ROOT / SSOT_FILE).read_text(encoding="utf-8")
    match = SSOT_PATTERN.search(text)
    if not match:
        sys.stderr.write(f"ERROR: cannot find [project].version in {SSOT_FILE}\n")
        sys.exit(2)
    return match.group("ver")


def collect() -> list[tuple[str, str | None]]:
    """Read every target and return ``(file, version_or_None)`` tuples."""
    out: list[tuple[str, str | None]] = []
    for rel, pattern, _vprefix in TARGETS:
        path = ROOT / rel
        if not path.exists():
            out.append((rel, None))
            continue
        text = path.read_text(encoding="utf-8")
        match = re.search(pattern, text, re.MULTILINE)
        out.append((rel, match.group("ver") if match else None))
    return out


def check() -> int:
    ssot = read_ssot()
    rows = collect()
    drift: list[str] = []
    missing: list[str] = []
    for rel, ver in rows:
        if ver is None:
            missing.append(rel)
        elif ver != ssot:
            drift.append(f"{rel}: {ver} (expected {ssot})")
    print(f"SSOT ({SSOT_FILE}): {ssot}")
    for rel, ver in rows:
        marker = "OK" if ver == ssot else ("MISS" if ver is None else "DRIFT")
        print(f"  [{marker}] {rel}: {ver}")
    if missing:
        print(f"\n{len(missing)} file(s) missing or unparsable:")
        for rel in missing:
            print(f"  - {rel}")
    if drift:
        print(f"\n{len(drift)} version drift(s):")
        for line in drift:
            print(f"  - {line}")
    if drift or missing:
        return 1
    print("\nOK — all version files match SSOT.")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--check", action="store_true", help="verify drift, exit 1 on mismatch")
    ap.add_argument("--print", dest="print_only", action="store_true",
                    help="print SSOT version to stdout and exit")
    args = ap.parse_args()
    if args.print_only:
        print(read_ssot())
        return 0
    if args.check or len(sys.argv) == 1:
        return check()
    return 0


if __name__ == "__main__":
    sys.exit(main())
