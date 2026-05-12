#!/usr/bin/env python3
"""
ULTRON · osint_footprint — auditoría de huella digital propia.

Envuelve Sherlock (sherlock-project) para localizar en qué redes/sitios
existe un username dado. Pensado para que USER audite SU PROPIA presencia
online (privacidad / OPSEC), no para terceros.

  uv run python osint_footprint.py scan <username> [<username2> ...]
  uv run python osint_footprint.py scan <username> --all      # imprime también los no-encontrados
  uv run python osint_footprint.py last                       # muestra el último escaneo

Resultados en ~/.ultron/.tmp/osint/<username>.csv (+ resumen en stdout).
Sherlock se ejecuta vía `uvx --from sherlock-project sherlock` — no se instala
nada permanente ni se mete una skill al contexto.

NOTA: esto sólo cubre cuentas basadas en username. Para brechas de datos
(emails filtrados) haría falta HaveIBeenPwned API (de pago) — pendiente.
"""
from __future__ import annotations

import argparse
import csv
import subprocess
import sys
from datetime import datetime
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

OUT_DIR = Path.home() / ".ultron" / ".tmp" / "osint"


def _run_sherlock(usernames: list[str], print_all: bool) -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    cmd = [
        "uvx", "--from", "sherlock-project", "sherlock",
        "--csv", "--no-color",
        "--folderoutput", str(OUT_DIR),
        "--timeout", "10",
    ]
    cmd += ["--print-all"] if print_all else ["--print-found"]
    cmd += usernames
    print(f"[osint] sherlock {' '.join(usernames)}  → {OUT_DIR}")
    try:
        proc = subprocess.run(cmd, text=True, capture_output=True, timeout=600)
    except FileNotFoundError:
        print("[osint] 'uvx' no encontrado en PATH. Instala uv."); return 2
    except subprocess.TimeoutExpired:
        print("[osint] sherlock timeout (>10 min)."); return 124
    # sherlock imprime los hallazgos por stdout; los pasamos tal cual
    if proc.stdout:
        print(proc.stdout.rstrip())
    if proc.returncode != 0 and proc.stderr:
        print(proc.stderr.rstrip(), file=sys.stderr)
    # resumen desde el/los CSV
    for u in usernames:
        csv_path = OUT_DIR / f"{u}.csv"
        if csv_path.exists():
            try:
                rows = list(csv.DictReader(csv_path.read_text(encoding="utf-8", errors="replace").splitlines()))
                found = [r for r in rows if (r.get("exists") or r.get("status") or "").lower().startswith(("claimed", "true", "yes"))]
                print(f"\n[osint] {u}: {len(found)} cuentas encontradas / {len(rows)} sitios comprobados  ({csv_path})")
                for r in found[:40]:
                    name = r.get("name") or r.get("site") or "?"
                    url = r.get("url_user") or r.get("url") or ""
                    print(f"  · {name:<22} {url}")
            except Exception:
                print(f"[osint] {u}: CSV en {csv_path} (no se pudo resumir)")
    # log
    try:
        (OUT_DIR / "_runs.log").open("a", encoding="utf-8").write(
            f"{datetime.now().isoformat(timespec='seconds')}  scan {' '.join(usernames)}  rc={proc.returncode}\n")
    except OSError:
        pass
    return proc.returncode


def _show_last() -> int:
    if not OUT_DIR.exists():
        print("[osint] sin escaneos previos."); return 0
    csvs = sorted(OUT_DIR.glob("*.csv"), key=lambda p: p.stat().st_mtime, reverse=True)
    if not csvs:
        print("[osint] sin escaneos previos."); return 0
    for p in csvs[:3]:
        print(f"\n=== {p.name}  ({datetime.fromtimestamp(p.stat().st_mtime):%Y-%m-%d %H:%M}) ===")
        try:
            rows = list(csv.DictReader(p.read_text(encoding="utf-8", errors="replace").splitlines()))
            found = [r for r in rows if (r.get("exists") or r.get("status") or "").lower().startswith(("claimed", "true", "yes"))]
            print(f"  {len(found)} encontradas / {len(rows)} comprobadas")
            for r in found[:40]:
                print(f"  · {(r.get('name') or r.get('site') or '?'):<22} {r.get('url_user') or r.get('url') or ''}")
        except Exception:
            print("  (no se pudo leer)")
    log = OUT_DIR / "_runs.log"
    if log.exists():
        print(f"\nHistorial: {log}")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(prog="osint_footprint")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sc = sub.add_parser("scan", help="buscar username(s) en redes con Sherlock")
    sc.add_argument("usernames", nargs="+")
    sc.add_argument("--all", action="store_true", help="incluir sitios donde NO se encontró")
    sub.add_parser("last", help="mostrar el último escaneo")
    args = ap.parse_args()
    if args.cmd == "scan":
        return _run_sherlock(args.usernames, args.all)
    return _show_last()


if __name__ == "__main__":
    raise SystemExit(main())
