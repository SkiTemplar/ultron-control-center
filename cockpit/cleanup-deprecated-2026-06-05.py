# Limpieza curada de deprecados (2026-06-05). Borra SOLO la lista explicita de
# abajo, con un GUARD que rechaza cualquier path protegido. Mide y reporta.
import os, glob, shutil, sys, stat

def _force_rm(func, path, exc):
    # Windows: clear read-only attribute then retry (handles WinError 5).
    try:
        os.chmod(path, stat.S_IWRITE)
        func(path)
    except Exception:
        pass

ROOT = r"C:\Users\USER\.ultron"
DRY = "--apply" not in sys.argv  # por defecto dry-run; --apply borra de verdad

# --- PROTEGIDOS: nunca borrar aunque aparezcan en la lista (substring match, normalizado) ---
PROTECTED = [
    "brain.db", "qdrant_storage", "qdrant-native", ".fastembed_cache\\models--qdrant",
    ".git", ".env", ".venv", "control-center\\src\\", "src-tauri\\src\\",
    "target\\release", "node_modules", "\\bin\\", "\\hooks\\", "\\skills\\",
    "project-cards", "memory-ingest\\extracted", "memory-ingest\\ingest",
    "memory-rework\\specs", "memory-rework\\informe", "memory-rework\\cleanup",
    "cockpit\\projects", "cockpit\\ai-router", "cockpit\\diagnostic-schedule",
    "memory-settings", "cockpit\\features", "cockpit\\hooks",
]

# --- Lista curada a borrar (rutas relativas a ROOT; soporta globs) ---
TARGETS = [
    # Regenerable
    r"control-center\src-tauri\target\debug",
    r"cockpit\memory-ingest\.fastembed_cache",
    r".pytest_cache",
    r"manifest.cache.json",
    # Backups grandes superados (codigo en git)
    r"cockpit\diagnostics\skills-worktree-backup-2026-05-24.zip",
    r"cockpit\memory-rework\_archive",
    r"backups\pre-v14.9-2026-05-10-134132-fb47",
    r"backups\2026-05-05-1437-pre-S2-rebuild",
    r"backups\2026-05-04-pre-S0",
    r"backups\claude-code-workflows-2026-05-07.zip",
    r"backups\2026-05-05-pre-*",
    r"backups\2026-05-20-ultron-skill-subfiles",
    r"backups\monitor-fix-20260508-144000",
    r"backups\skill-provenance.2026-05-07-*.json",
    r"backups\startup",
    # _legacy_archive (versiones 15.x archivadas)
    r"_legacy_archive\skills-catalog",
    r"_legacy_archive\agents-15x",
    r"_legacy_archive\multimodel\requests",
    r"_legacy_archive\quiz-generator-template",
    r"_legacy_archive\web-old-landing",
    # archive viejos
    r"archive\migration-2026-05-22",
    r"archive\v14.9-migration",
    r"archive\cockpit-proposals-applied",
    r"archive\2026-05-09-v14.9-pre-cleanup",
    r"archive\deferred-2026-05-04-plan-session.md",
    r"archive\skill-discoveries-converter-20260429.json",
    # logs/sessions/telemetry viejos
    r"logs\backup-2026-06-01.log",
    r"sessions\2026-04-*",
    r"telemetry\v14-overhaul",
    r"plans\_archived-2026-05-22-ultron-backlog.json",
    r"batches\staging-workdays-2026-05-25",
    # docs obsoletas
    r"docs\download.html",
    r"docs\plans\v15.4-final.md",
    r"docs\plans\v15.4-plans-audit.md",
    r"cockpit\diagnostics\2026-05-23T18-00-38Z.json",
    r"cockpit\diagnostics\2026-05-23T20-32-37Z.json",
    # locks/archivos huerfanos
    r"alerts.jsonl.archive",
    r"alerts.jsonl.lock",
    r"skill-provenance.lock",
]

def is_protected(p):
    pl = p.lower()
    return any(tok.lower() in pl for tok in PROTECTED)

def dsize(path):
    if os.path.isfile(path):
        try: return os.path.getsize(path)
        except OSError: return 0
    t = 0
    for dp, _, fs in os.walk(path):
        for f in fs:
            try: t += os.path.getsize(os.path.join(dp, f))
            except OSError: pass
    return t

freed = 0; deleted = 0; skipped = 0; errors = 0
for rel in TARGETS:
    for path in glob.glob(os.path.join(ROOT, rel)):
        ap = os.path.abspath(path)
        if not ap.startswith(ROOT):
            print("  [SKIP fuera de ROOT]", ap); skipped += 1; continue
        if is_protected(ap):
            print("  [SKIP PROTEGIDO]", ap); skipped += 1; continue
        if not os.path.exists(ap):
            continue
        sz = dsize(ap)
        if DRY:
            print(f"  [DRY {sz/1024/1024:8.1f}MB] {os.path.relpath(ap, ROOT)}")
            freed += sz; deleted += 1
            continue
        try:
            if os.path.isfile(ap):
                os.chmod(ap, stat.S_IWRITE); os.remove(ap)
            else: shutil.rmtree(ap, onerror=_force_rm)
            freed += sz; deleted += 1
            print(f"  [DEL {sz/1024/1024:8.1f}MB] {os.path.relpath(ap, ROOT)}")
        except Exception as e:
            errors += 1
            print(f"  [ERR] {os.path.relpath(ap, ROOT)} :: {str(e)[:80]}")

mode = "DRY-RUN (nada borrado)" if DRY else "APLICADO"
print("=" * 60)
print(f"{mode}: {deleted} items, {freed/1024/1024/1024:.2f} GB, skipped={skipped}, errors={errors}")
