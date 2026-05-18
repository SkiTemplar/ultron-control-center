#!/usr/bin/env python3
"""
ULTRON · osint_footprint — auditoría de huella digital propia.

Envuelve Sherlock (sherlock-project) para localizar en qué redes/sitios
existe un username dado. Pensado para que el usuario audite SU PROPIA presencia
online (privacidad / OPSEC), no para terceros.

  uv run python osint_footprint.py scan <username> [<username2> ...]   # Sherlock (~400 sitios por username)
  uv run python osint_footprint.py scan <username> --all               # incluye los no-encontrados
  uv run python osint_footprint.py email <email>                       # holehe (~120 sitios donde ese email está registrado)
  uv run python osint_footprint.py last                                # muestra el último escaneo

Resultados en ~/.ultron/.tmp/osint/ (+ resumen en stdout).
Sherlock/holehe se ejecutan vía `uvx` — no se instala nada permanente ni se
mete una skill al contexto (0 tokens). Ambas son gratuitas, sin API key.

NOTA: `scan` (Sherlock) = cuentas por username. `email` (holehe) = sitios donde
ese email tiene cuenta. Para brechas/leaks de datos haría falta HaveIBeenPwned
(API de pago) — the user prefers no-cost tools, así que holehe es el sustituto gratis.
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


def _run_holehe(email: str) -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    csv_path = OUT_DIR / f"email_{email.replace('@', '_at_').replace('.', '_')}.csv"
    cmd = ["uvx", "holehe", "--only-used", "--no-clear", "--no-color", "-C", "-T", "10", email]
    print(f"[osint] holehe {email}  → {OUT_DIR}")
    try:
        proc = subprocess.run(cmd, text=True, capture_output=True, timeout=600, cwd=str(OUT_DIR))
    except FileNotFoundError:
        print("[osint] 'uvx' no encontrado en PATH."); return 2
    except subprocess.TimeoutExpired:
        print("[osint] holehe timeout."); return 124
    if proc.stdout:
        print(proc.stdout.rstrip())
    if proc.returncode != 0 and proc.stderr:
        print(proc.stderr.rstrip(), file=sys.stderr)
    # holehe escribe holehe_<ts>_out.csv en cwd; renómbralo a algo estable
    try:
        for produced in OUT_DIR.glob("holehe_*_out.csv"):
            produced.replace(csv_path)
            print(f"\n[osint] {email}: resultados en {csv_path}")
            break
    except OSError:
        pass
    try:
        (OUT_DIR / "_runs.log").open("a", encoding="utf-8").write(
            f"{datetime.now().isoformat(timespec='seconds')}  email {email}  rc={proc.returncode}\n")
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


def _csv_accounts(path: Path) -> set[str]:
    try:
        rows = list(csv.DictReader(path.read_text(encoding="utf-8", errors="replace").splitlines()))
    except OSError:
        return set()
    out = set()
    for r in rows:
        status = (r.get("exists") or r.get("status") or "").lower()
        if status.startswith(("claimed", "true", "yes")):
            out.add(r.get("name") or r.get("site") or r.get("url_user") or r.get("url") or "?")
    return out


def _cmd_diff(target: str | None) -> int:
    if not OUT_DIR.exists():
        print("[osint] sin escaneos."); return 0
    pat = f"{target}.csv" if target else "*.csv"
    csvs = sorted(OUT_DIR.glob(pat), key=lambda p: p.stat().st_mtime, reverse=True)
    csvs = [p for p in csvs if not p.name.startswith("_")]
    if len(csvs) < 2:
        print(f"[osint] necesito ≥2 escaneos{' de '+target if target else ''} para comparar (hay {len(csvs)})."); return 0
    new, old = csvs[0], csvs[1]
    a_new, a_old = _csv_accounts(new), _csv_accounts(old)
    added = sorted(a_new - a_old)
    removed = sorted(a_old - a_new)
    print(f"[osint] diff  {old.name} ({datetime.fromtimestamp(old.stat().st_mtime):%Y-%m-%d %H:%M})  →  {new.name} ({datetime.fromtimestamp(new.stat().st_mtime):%Y-%m-%d %H:%M})")
    if added:
        print(f"  ➕ cuentas nuevas ({len(added)}): " + " · ".join(added))
    if removed:
        print(f"  ➖ ya no aparecen ({len(removed)}): " + " · ".join(removed))
    if not added and not removed:
        print("  = sin cambios")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(prog="osint_footprint")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sc = sub.add_parser("scan", help="buscar username(s) en redes con Sherlock")
    sc.add_argument("usernames", nargs="+")
    sc.add_argument("--all", action="store_true", help="incluir sitios donde NO se encontró")
    em = sub.add_parser("email", help="comprobar en qué sitios está registrado un email (holehe)")
    em.add_argument("address")
    df = sub.add_parser("diff", help="comparar los 2 escaneos más recientes (cuentas nuevas/desaparecidas)")
    df.add_argument("target", nargs="?", default=None, help="username concreto (opcional)")
    sub.add_parser("last", help="mostrar el último escaneo")
    args = ap.parse_args()
    if args.cmd == "scan":
        return _run_sherlock(args.usernames, args.all)
    if args.cmd == "email":
        return _run_holehe(args.address)
    if args.cmd == "diff":
        return _cmd_diff(args.target)
    return _show_last()


if __name__ == "__main__":
    raise SystemExit(main())
