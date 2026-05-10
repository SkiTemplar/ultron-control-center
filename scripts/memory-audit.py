#!/usr/bin/env python3
"""
ULTRON MEMORY AUDIT · v1.0
Audita archivos de memoria CC (~/.claude/projects/*/memory/*.md).
Detecta: SIN-FRONTMATTER, TIPO-INVÁLIDO, TOXICO, DUPLICADO, STALE, huérfanos en MEMORY.md.
Implementa: protocols.md § AUTO-LIMPIEZA (sección CC)

Uso:
    python scripts/memory-audit.py
    python scripts/memory-audit.py --fix-index    (actualiza MEMORY.md con entradas huérfanas)
"""
import re
import sys
import io
from pathlib import Path

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')

HOME = Path.home()
PROJECTS_DIR = HOME / ".claude" / "projects"

VALID_TYPES = {"feedback", "project", "user", "reference"}
TOXIC_CHARS = 500       # body > N chars sin estructura → TOXICO
SIMILARITY_THRESHOLD = 0.80  # Jaccard similarity → DUPLICADO


# ── Frontmatter ───────────────────────────────────────────────────────────────

def parse_frontmatter(text: str) -> dict:
    m = re.match(r"^---\s*\n(.*?)\n---", text, re.DOTALL)
    if not m:
        return {}
    fm = {}
    for line in m.group(1).splitlines():
        if ":" in line:
            k, _, v = line.partition(":")
            fm[k.strip()] = v.strip()
    return fm


def get_body(text: str) -> str:
    return re.sub(r"^---.*?---\s*\n?", "", text, flags=re.DOTALL).strip()


# ── Clasificación ─────────────────────────────────────────────────────────────

def jaccard(a: str, b: str) -> float:
    wa = set(a.lower().split())
    wb = set(b.lower().split())
    if not wa or not wb:
        return 0.0
    return len(wa & wb) / len(wa | wb)


def classify_file(path: Path, text: str, fm: dict, all_bodies: list[tuple[Path, str]]) -> list[str]:
    flags = []

    if not fm:
        flags.append("SIN-FRONTMATTER")
        return flags

    if fm.get("type") not in VALID_TYPES:
        flags.append(f"TIPO-INVÁLIDO({fm.get('type', '?')})")

    body = get_body(text)

    # TOXICO: cuerpo largo sin estructura (sin párrafos separados)
    if len(body) > TOXIC_CHARS and body.count("\n\n") == 0:
        flags.append("TOXICO")

    # DUPLICADO: alta similitud con otro archivo
    for other_path, other_body in all_bodies:
        if other_path == path or len(body) < 40:
            continue
        if jaccard(body, other_body) >= SIMILARITY_THRESHOLD:
            flags.append(f"DUPLICADO({other_path.name})")
            break

    # STALE: menciona un path que ya no existe
    paths_in_text = re.findall(r"[`']([^`'\s]+\.[a-z]{1,5})[`']", body)
    for p in paths_in_text:
        if "/" in p or "\\" in p:
            candidate = Path(p.replace("~", str(HOME)))
            if not candidate.exists():
                flags.append(f"STALE({p})")

    return flags


# ── Index check ───────────────────────────────────────────────────────────────

def check_index(memory_dir: Path, file_names: set[str]) -> tuple[list[str], list[str]]:
    """Devuelve (huérfanos, enlaces muertos) respecto a MEMORY.md."""
    memory_md = memory_dir / "MEMORY.md"
    if not memory_md.exists():
        return list(file_names), []

    index_text = memory_md.read_text(encoding="utf-8", errors="ignore")
    linked = set(re.findall(r"\[.*?\]\(([\w._-]+\.md)\)", index_text))

    orphaned = sorted(file_names - linked)           # existen pero no están en index
    dead_links = sorted(linked - file_names)         # están en index pero no existen
    return orphaned, dead_links


# ── Auditoría de proyecto ─────────────────────────────────────────────────────

def audit_project(project_dir: Path) -> bool:
    """Audita un proyecto. Devuelve True si hay issues."""
    memory_dir = project_dir / "memory"
    if not memory_dir.exists():
        return False

    files = [f for f in memory_dir.glob("*.md") if f.name != "MEMORY.md"]
    if not files:
        return False

    # Cargar todos los bodies para detección de duplicados
    bodies: list[tuple[Path, str]] = []
    file_data: dict[Path, tuple[str, dict]] = {}
    for f in files:
        text = f.read_text(encoding="utf-8", errors="ignore")
        fm = parse_frontmatter(text)
        body = get_body(text)
        bodies.append((f, body))
        file_data[f] = (text, fm)

    # Clasificar cada archivo
    any_issue = False
    rows: list[tuple[str, str, str, list[str]]] = []

    for f, (text, fm) in file_data.items():
        other_bodies = [(p, b) for p, b in bodies if p != f]
        flags = classify_file(f, text, fm, other_bodies)
        ftype = fm.get("type", "?")
        fname_label = fm.get("name", f.stem)[:28]
        rows.append((ftype, f.name, fname_label, flags))
        if flags:
            any_issue = True

    # Index consistency
    file_names = {f.name for f in files}
    orphaned, dead_links = check_index(memory_dir, file_names)
    if orphaned or dead_links:
        any_issue = True

    if not any_issue:
        return False

    # Mostrar resultado del proyecto
    print(f"\n📁 {project_dir.name}")
    for ftype, fname, label, flags in rows:
        symbol = "✅" if not flags else "⚠️ "
        flag_str = " · ".join(flags) if flags else "ok"
        print(f"  {symbol} [{ftype:9}] {fname:<35} {flag_str}")

    if orphaned:
        for o in orphaned:
            print(f"  ⚠️  HUÉRFANO: {o} existe pero NO está en MEMORY.md index")
    if dead_links:
        for d in dead_links:
            print(f"  ❌ ENLACE MUERTO: {d} en MEMORY.md index pero el archivo NO existe")

    return True


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    fix_index = "--fix-index" in sys.argv

    print(f"\n{'='*60}")
    print("ULTRON MEMORY AUDIT — ~/.claude/projects/*/memory/")
    print(f"{'='*60}")

    if not PROJECTS_DIR.exists():
        print("\n⚠️  No se encuentra ~/.claude/projects/")
        print("   Normal si no has iniciado sesiones de proyecto en CC.")
        sys.exit(0)

    project_dirs = sorted(
        d for d in PROJECTS_DIR.iterdir()
        if d.is_dir() and (d / "memory").exists()
    )

    if not project_dirs:
        print("\n⚠️  No hay proyectos con directorio memory/ en ~/.claude/projects/")
        sys.exit(0)

    has_issues = False
    for pd in project_dirs:
        if audit_project(pd):
            has_issues = True

    print(f"\n{'='*60}")

    if not has_issues:
        print("✅ Memoria CC limpia. Ningún issue detectado.")
        sys.exit(0)

    print("\nACCIONES SUGERIDAS:")
    print("  SIN-FRONTMATTER  → añadir ---/name/description/type/--- al archivo")
    print("  TIPO-INVÁLIDO    → corregir type: a uno de {feedback, project, user, reference}")
    print("  TOXICO           → comprimir body a ≤2 líneas con la regla esencial")
    print("  DUPLICADO        → fusionar ambos archivos, eliminar el redundante")
    print("  STALE            → verificar si el path sigue existiendo, actualizar o eliminar ref")
    print("  HUÉRFANO         → añadir entrada en MEMORY.md: - [Nombre](archivo.md) — descripción")
    print("  ENLACE MUERTO    → eliminar la línea del MEMORY.md index")
    print("\n→ Ver protocols.md § AUTO-LIMPIEZA para el protocolo completo")
    sys.exit(1)


if __name__ == "__main__":
    main()
