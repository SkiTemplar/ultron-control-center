"""ULTRON Cockpit — installed apps inventory (Win32 registry + winget).

Reads Windows uninstall registry (HKLM 32+64-bit, HKCU) and merges with
`winget list` output. Deduplicates by normalized name. Output is sorted
alphabetically.

Usage:
    ultron apps                      # printable table to stdout
    ultron apps --json               # JSON to stdout
    ultron apps --md <path>          # write Markdown table to <path>
    ultron apps --filter "Visual"    # case-insensitive name filter
    ultron apps --source registry    # only registry, skip winget
    ultron apps --source winget      # only winget
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Iterable

if sys.platform != "win32":
    print("[apps] error: Windows only", file=sys.stderr)
    sys.exit(2)

import winreg  # noqa: E402

UNINSTALL_KEYS = [
    (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall", "HKLM-64"),
    (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall", "HKLM-32"),
    (winreg.HKEY_CURRENT_USER, r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall", "HKCU"),
]


@dataclass
class App:
    name: str
    version: str
    publisher: str
    install_date: str
    source: str  # registry hive or "winget"
    install_location: str = ""

    def key(self) -> str:
        # Normalize for dedup: lowercase, strip non-alphanumeric.
        return re.sub(r"[^a-z0-9]+", "", self.name.lower())


def _read_value(handle, name: str) -> str:
    try:
        v, _ = winreg.QueryValueEx(handle, name)
        return str(v) if v is not None else ""
    except OSError:
        return ""


def read_registry() -> list[App]:
    apps: list[App] = []
    for root, subkey, label in UNINSTALL_KEYS:
        try:
            with winreg.OpenKey(root, subkey) as parent:
                i = 0
                while True:
                    try:
                        child_name = winreg.EnumKey(parent, i)
                    except OSError:
                        break
                    i += 1
                    try:
                        with winreg.OpenKey(parent, child_name) as child:
                            display_name = _read_value(child, "DisplayName")
                            if not display_name:
                                continue
                            # Skip Windows updates and system patches.
                            if re.match(r"^(KB\d+|Security Update|Update for)", display_name):
                                continue
                            if _read_value(child, "SystemComponent") == "1":
                                continue
                            apps.append(App(
                                name=display_name.strip(),
                                version=_read_value(child, "DisplayVersion"),
                                publisher=_read_value(child, "Publisher"),
                                install_date=_read_value(child, "InstallDate"),
                                source=label,
                                install_location=_read_value(child, "InstallLocation"),
                            ))
                    except OSError:
                        continue
        except OSError:
            continue
    return apps


def read_winget() -> list[App]:
    try:
        proc = subprocess.run(
            ["winget", "list", "--accept-source-agreements"],
            capture_output=True, text=True, timeout=60, encoding="utf-8", errors="replace",
        )
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return []
    if proc.returncode != 0:
        return []

    lines = proc.stdout.splitlines()
    # Skip preamble until the dashed divider (-----...).
    header_idx = next((i for i, ln in enumerate(lines) if re.match(r"^-{5,}", ln)), -1)
    if header_idx < 1:
        return []
    # Column widths come from the line ABOVE the divider (header line).
    header = lines[header_idx - 1]
    divider = lines[header_idx]
    # Column ranges: each block of '-' marks a column extent.
    bounds: list[tuple[int, int]] = []
    pos = 0
    for m in re.finditer(r"-+", divider):
        bounds.append((m.start(), m.end()))
    cols = [header[s:e].strip() for s, e in bounds]
    try:
        name_idx = cols.index("Name")
        ver_idx = cols.index("Version")
    except ValueError:
        return []

    apps: list[App] = []
    for ln in lines[header_idx + 1:]:
        if not ln.strip() or ln.startswith(("Upgrades", "The following", "No installed", "No applicable", "└─", "├─")):
            continue
        try:
            name = ln[bounds[name_idx][0]:bounds[name_idx][1]].strip()
            version = ln[bounds[ver_idx][0]:bounds[ver_idx][1]].strip()
        except IndexError:
            continue
        if not name or name.startswith(("Name", "----")):
            continue
        apps.append(App(name=name, version=version, publisher="", install_date="", source="winget"))
    return apps


def merge(*sources: Iterable[App]) -> list[App]:
    by_key: dict[str, App] = {}
    for src in sources:
        for app in src:
            k = app.key()
            if not k:
                continue
            existing = by_key.get(k)
            if existing is None:
                by_key[k] = app
                continue
            # Prefer the entry with the most metadata (publisher + version).
            score_new = sum(bool(x) for x in (app.version, app.publisher, app.install_location))
            score_old = sum(bool(x) for x in (existing.version, existing.publisher, existing.install_location))
            if score_new > score_old:
                by_key[k] = app
    return sorted(by_key.values(), key=lambda a: a.name.lower())


def render_table(apps: list[App]) -> str:
    if not apps:
        return "(no apps found)"
    n_w = min(max(len(a.name) for a in apps), 50)
    v_w = min(max(len(a.version or "") for a in apps), 20)
    p_w = min(max(len(a.publisher or "") for a in apps), 30)
    rows = [f"{'NAME':<{n_w}}  {'VERSION':<{v_w}}  {'PUBLISHER':<{p_w}}  SOURCE"]
    rows.append("-" * (n_w + v_w + p_w + 16))
    for a in apps:
        rows.append(f"{a.name[:n_w]:<{n_w}}  {(a.version or '')[:v_w]:<{v_w}}  {(a.publisher or '')[:p_w]:<{p_w}}  {a.source}")
    rows.append("")
    rows.append(f"Total: {len(apps)} apps")
    return "\n".join(rows)


def render_markdown(apps: list[App]) -> str:
    lines = [
        "# Installed Apps Inventory",
        "",
        f"Total: **{len(apps)}** apps. Generated by `ultron apps`.",
        "",
        "| Name | Version | Publisher | Source |",
        "|------|---------|-----------|--------|",
    ]
    for a in apps:
        n = a.name.replace("|", "\\|")
        p = (a.publisher or "").replace("|", "\\|")
        lines.append(f"| {n} | {a.version or ''} | {p} | {a.source} |")
    return "\n".join(lines) + "\n"


def main():
    p = argparse.ArgumentParser(prog="ultron apps", description=__doc__.split("\n")[0])
    p.add_argument("--json", action="store_true", help="JSON output to stdout")
    p.add_argument("--md", metavar="PATH", help="write Markdown table to PATH")
    p.add_argument("--filter", metavar="REGEX", help="case-insensitive name regex filter")
    p.add_argument("--source", choices=("all", "registry", "winget"), default="all")
    args = p.parse_args()

    sources: list[list[App]] = []
    if args.source in ("all", "registry"):
        sources.append(read_registry())
    if args.source in ("all", "winget"):
        sources.append(read_winget())
    apps = merge(*sources)

    if args.filter:
        rx = re.compile(args.filter, re.IGNORECASE)
        apps = [a for a in apps if rx.search(a.name)]

    if args.json:
        print(json.dumps([asdict(a) for a in apps], indent=2, ensure_ascii=False))
        return

    if args.md:
        Path(args.md).write_text(render_markdown(apps), encoding="utf-8")
        print(f"[apps] wrote {len(apps)} apps to {args.md}")
        return

    print(render_table(apps))


if __name__ == "__main__":
    main()
