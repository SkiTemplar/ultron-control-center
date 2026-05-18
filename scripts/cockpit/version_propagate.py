# === maintainer-only (not user-facing) ===
# Sole caller: .github/workflows/ci.yml § version-drift job. Never invoked
# by hooks, control-center, or any user-facing command. See docs/MAINTAINERS.md.
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

# v15.5.15: also scan markdown bodies for stale version pins (badges,
# bootstrap one-liners, "Current stable" prose, legacy-doc preambles).
# internal-review-note caught README/SYSTEM-MAP/docs/INSTALL pinning v15.5.13 after
# the v15.5.15 bump because mirrors were narrowly file-level, not body-level.
# Pattern: any literal `v15.5.13` / `v15.5.14` / older-style `version-vX.Y.Z-*.svg`
# in the listed docs is a drift signal (forward versions are fine — newer than SSOT).
MD_TARGETS: list[str] = [
    "README.md",
    "README.es.md",
    "SYSTEM-MAP.md",
    "INSTALL.md",
    "docs/INSTALL.md",
    "docs/QUICKSTART.md",
    "docs/memory-layers.md",
    "docs/skills-manifest-schema.md",
]
# Only matches version pins in contexts that MUST track SSOT (badge URLs,
# bootstrap one-liners, "Current stable" prose links, legacy-doc preambles).
# Historical references like "v15.0.2 removed Docker" or "Qdrant v1.18.0" are
# intentionally excluded — they document past decisions and must NOT bump.
# CHANGELOG.md is never scanned (historical entries are supposed to be stale).
MD_PIN_PATTERNS: list[re.Pattern[str]] = [
    re.compile(r'version-v(?P<ver>[0-9]+\.[0-9]+\.[0-9]+)-[0-9a-f]{6,8}\.svg'),         # badge
    re.compile(r'(?:tags|tag)/v(?P<ver>[0-9]+\.[0-9]+\.[0-9]+)(?:/|\))'),               # release link / bootstrap URL
    re.compile(r'/v(?P<ver>[0-9]+\.[0-9]+\.[0-9]+)/bootstrap\.(?:ps1|sh)'),             # raw bootstrap URL
    re.compile(r'Architecture unchanged through v(?P<ver>[0-9]+\.[0-9]+\.[0-9]+)'),     # legacy doc preamble
    re.compile(r'(?:Current|Stable actual)[^v]{0,30}\*\*\[v(?P<ver>[0-9]+\.[0-9]+\.[0-9]+)\]'),  # release-notes header
    # v15.5.17 (internal-review-note + internal-review-note): SYSTEM-MAP.md plain-prose pins.
    re.compile(r'SSOT version:\s*v(?P<ver>[0-9]+\.[0-9]+\.[0-9]+)'),                    # SSOT prose
    re.compile(r'Control Center \(v(?P<ver>[0-9]+\.[0-9]+\.[0-9]+)\):'),                # CC header in SYSTEM-MAP
    re.compile(r'2026-05-\d{2}\s*\(v(?P<ver>[0-9]+\.[0-9]+\.[0-9]+)'),                  # "Última actualización: 2026-05-18 (v15.5.X..."
]


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


def collect_md_drift(ssot: str) -> list[tuple[str, int, str]]:
    """Scan markdown bodies for stale version pins.

    Returns ``(file, line_number, version_found)`` for every match that does
    not equal the SSOT. Forward-version mentions (newer than SSOT) are ignored
    because they may be intentional placeholders. CHANGELOG.md is intentionally
    not scanned — its historical entries are supposed to reference old tags.
    """
    drift: list[tuple[str, int, str]] = []
    for rel in MD_TARGETS:
        path = ROOT / rel
        if not path.exists():
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except OSError:
            continue
        for lineno, line in enumerate(text.splitlines(), start=1):
            for pattern in MD_PIN_PATTERNS:
                for match in pattern.finditer(line):
                    ver = match.group("ver")
                    if ver == ssot:
                        continue
                    if _is_forward(ver, ssot):
                        continue
                    drift.append((rel, lineno, ver))
    return drift


def _is_forward(candidate: str, ssot: str) -> bool:
    """Return True if candidate is strictly newer than ssot (semver tuple)."""
    try:
        ct = tuple(int(p) for p in candidate.split("."))
        st = tuple(int(p) for p in ssot.split("."))
        return ct > st
    except ValueError:
        return False


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
    md_drift = collect_md_drift(ssot)
    if md_drift:
        print(f"\n{len(md_drift)} markdown body drift(s):")
        for rel, lineno, ver in md_drift:
            print(f"  - {rel}:{lineno}: v{ver} (expected v{ssot})")
    if missing:
        print(f"\n{len(missing)} file(s) missing or unparsable:")
        for rel in missing:
            print(f"  - {rel}")
    if drift:
        print(f"\n{len(drift)} version drift(s):")
        for line in drift:
            print(f"  - {line}")
    if drift or missing or md_drift:
        return 1
    print("\nOK — all version files and markdown bodies match SSOT.")
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
