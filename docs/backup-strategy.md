# ULTRON Backup Strategy — 2 mirrors, NO history

> Design decision (2026-05-10): two mirror systems, no history kept.
> Mirror = local deletions propagate to the destination.

## Sistema 1 — Google Drive Desktop (automático)

- **Tipo**: sync bidireccional. Mirror.
- **Comportamiento**: si borras local → se borra en Drive. Sin papelera retenida más allá de la papelera de Drive web (~30 días).
- **Configurar exclusiones**:
  1. Abrir Google Drive Desktop (icono en bandeja).
  2. ⚙ → Preferences → "Mi ordenador" tab.
  3. Para CADA carpeta sincronizada, click en su entrada y desmarcar las subcarpetas auto-generadas.
  4. Drive Desktop **NO acepta `.gitignore`-style**. Solo selección de carpetas concretas.
  5. Carpetas que típicamente convienen excluir:
     - `*/Library/`, `*/Temp/`, `*/Logs/` (Unity)
     - `*/Binaries/`, `*/Build/`, `*/DerivedDataCache/`, `*/Intermediate/`, `*/Saved/` (Unreal)
     - `*/node_modules/`, `*/.next/`, `*/dist/`, `*/.venv/` (Web/Python)
     - `*/__pycache__/`, `*/.pytest_cache/`, `*/.mypy_cache/`
- **Ejecución**: continua, automática.

## Sistema 2 — `weekly-backup.ps1` → `$env:ULTRON_BACKUP_ROOT` (manual)

- **Tipo**: robocopy `/MIR`. Mirror, NO history.
- **Destino**: configurable vía `$env:ULTRON_BACKUP_ROOT` (ej. `D:\BACKUP`). Fallback: `%USERPROFILE%\BACKUP`.
- **Comportamiento**: si borras local → en la próxima ejecución se borra en el destino. Idéntico a Drive.
- **Configurar exclusiones**: editar `~/.ultron/config/backup-exclusions.txt` (gitignore-style).
- **Ejecución**: automática cada lunes 09:00 vía Task Scheduler (`UltronBackup-Weekly`, State: Ready). Reactivado 2026-05-11.
  ```powershell
  # Ejecutar manualmente cuando quieras:
  & "$env:USERPROFILE\.ultron\scripts\backup\weekly-backup.ps1"
  
  # Dry-run para ver qué haría sin tocar nada:
  & "$env:USERPROFILE\.ultron\scripts\backup\weekly-backup.ps1" -DryRun
  
  # Solo una fuente:
  & "$env:USERPROFILE\.ultron\scripts\backup\weekly-backup.ps1" -Source ".ultron"
  
  # Ver último resultado:
  & "$env:USERPROFILE\.ultron\scripts\backup\weekly-backup.ps1" -Status
  ```

## Cómo confirmar que estamos en estado mirror correcto

```powershell
# Drive: si borraste algo y aún aparece en Drive web → revisar Preferences > Sync
# (puede que la carpeta no estuviera marcada para sincronizar antes de borrar)

# Cockpit D:\:
& "$env:USERPROFILE\.ultron\scripts\backup\weekly-backup.ps1" -DryRun
# Lee el log en ~/.ultron/logs/backup-YYYY-MM-DD.log
# Las líneas "EXTRA" indican archivos que existen en D:\ y NO en source → /MIR los borraría
```

## Recuperación si borras algo por accidente

- **Drive web** → papelera (`drive.google.com/drive/trash`), 30 días.
- **`$env:ULTRON_BACKUP_ROOT`** (ej. `D:\BACKUP\`) → si todavía no has ejecutado weekly-backup desde el borrado, el archivo sigue ahí.
- **Sin más copias** — esto es decisión consciente: ambos sistemas son mirrors, no archivos.
